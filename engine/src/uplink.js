import { hostname } from 'node:os'
import { registerMachine } from './runner/acal-runner.js'
import { proKey } from './cloud.js'
import { masterSecret, payloadKey, encryptSecretBox, decryptSecretBox } from './secret.js'
import { windowStatus } from './windows.js'

// Mobile uplink — this install joins MachineHub AS A MACHINE (the same
// dial-out host protocol the cloud/BYO runner speaks) so a paired phone can
// see local jobs and answer local asks through the worker.
//
// Local-bus events are TRANSLATED into the runner's hub vocabulary (the app's
// reducer expects job.started/ask/answered/done/failed/handoff + window with
// jobId = our scheduleId), then each payload is SEALED with the per-machine
// key the app derives — so the worker relays ciphertext it cannot read
// (data:{enc:<base64url>}). A separate plaintext 'push' event carries only
// {kind,name} so the worker can fire a generic notification.

const RECONNECT_MAX_MS = 30_000
const b64url = (u) => Buffer.from(u).toString('base64url')

export function startUplink({ cfg, db, bus, scheduler, onLog = () => {} }) {
  if (cfg.mobileSync === false) return null
  const key = proKey()
  if (!key) return null // mobile rides the control plane — Pro only

  const master = masterSecret()
  // per-phase push prefs (config.json `push`); missing keys fall to defaults
  const pushOn = { ask: true, failed: true, done: false, ...(cfg.push ?? {}) }
  const api = process.env.AGENTCAL_API || 'https://agentcal-api.milindsoni201.workers.dev'
  const state = { ws: null, stopped: false, backoff: 1000, lastPong: Date.now(), machineId: null, hostToken: null, sealKey: null }
  const boot = crypto.randomUUID().slice(0, 8)
  const outbox = []
  let eid = 0

  const send = (obj) => { try { state.ws?.send(typeof obj === 'string' ? obj : JSON.stringify(obj)) } catch {} }
  // sealed event: translated payload → per-machine secretbox → {enc}
  const emitSealed = (type, data) => {
    if (!state.sealKey) return
    outbox.push({ t: 'event', boot, eid: ++eid, ts: Date.now(), type, data: { enc: b64url(encryptSecretBox(data, state.sealKey)) } })
    if (outbox.length > 1000) outbox.shift()
    if (state.ws?.readyState === 1) send(outbox[outbox.length - 1])
  }
  const emitPlain = (type, data) => {
    outbox.push({ t: 'event', boot, eid: ++eid, ts: Date.now(), type, data })
    if (outbox.length > 1000) outbox.shift()
    if (state.ws?.readyState === 1) send(outbox[outbox.length - 1])
  }

  // ---- calendar mirror: the phone's week view is sealed segments + windows.
  // Rows are translated into the app's Block/WindowInfo shapes HERE so the
  // app-side reducer stays dumb (and the worker still sees only ciphertext).
  const asBlock = (g) => ({
    id: String(g.id),
    provider: g.provider,
    account: g.account,
    title: g.title || g.project || `${g.provider} session`,
    start: g.started_at,
    end: g.ended_at,
  })
  const querySegments = (from, to) => db.prepare(
    `SELECT g.id, g.provider, g.account, g.started_at, g.ended_at, s.project, s.title
     FROM segments g JOIN sessions s ON s.id = g.session_id
     WHERE g.ended_at >= ? AND g.started_at <= ? ORDER BY g.started_at`
  ).all(from, to).map(asBlock)
  const windowsNow = () => windowStatus(db, cfg).map((w) => ({
    provider: w.provider,
    account: w.account,
    resetsAt: w.nextResetAt,
    usedPct: w.usedPercent ?? null,
    source: w.source === 'vendor' ? 'vendor' : 'estimated',
  }))

  // pending schedules as ghost blocks; next_reset ones sit at the provider's
  // predicted reset (mirroring the desktop grid's placement)
  const scheduleGhosts = () => {
    const ghosts = []
    for (const s of scheduler.list()) {
      if (s.status !== 'pending' && s.status !== 'running') continue
      let spec = {}
      try { spec = JSON.parse(s.action_value) } catch {}
      let at = s.fire_at
      if (at == null && s.when_type === 'next_reset') {
        const provider = String(s.when_value ?? 'claude').split(':')[0]
        at = windowsNow().find((w) => w.provider === provider)?.resetsAt ?? null
      }
      if (at == null) continue
      ghosts.push({
        id: `sch-${s.id}`,
        provider: ['claude', 'codex', 'openclaw', 'hermes', 'opencode'].includes(spec.agent) ? spec.agent : 'claude',
        account: s.status === 'running' ? 'running' : 'scheduled',
        title: s.name || (spec.prompt ?? s.action_type).slice(0, 80),
        start: at,
        end: at + 25 * 60_000,
        kind: 'scheduled',
      })
    }
    return ghosts
  }

  // live drip between snapshots: any segment that grew since the last tick
  // (extended by activity, or brand new) goes up as a sealed upsert; a window
  // goes up when its reset moves. The app upserts by id, so replays are free.
  let lastSweep = Date.now()
  const lastWindows = new Map()
  const sweep = setInterval(() => {
    if (!state.sealKey || state.ws?.readyState !== 1) return
    const changed = querySegments(lastSweep - 5_000, Date.now())
    lastSweep = Date.now()
    for (const b of changed.slice(-50)) emitSealed('segment', b)
    for (const w of windowsNow()) {
      const key = `${w.provider}:${w.account}`
      const sig = `${w.resetsAt}:${w.usedPct}`
      if (lastWindows.get(key) !== sig) {
        lastWindows.set(key, sig)
        emitSealed('window', w)
      }
    }
  }, 60_000)
  sweep.unref?.()

  // local bus (scheduleId-keyed) → hub runner vocabulary (jobId-keyed)
  bus.on((evt) => {
    if (!state.sealKey) return
    const d = evt.data ?? {}
    const jobId = d.scheduleId ?? d.id
    switch (evt.type) {
      case 'job.started':
        emitSealed('job.started', { jobId, sessionId: d.sessionId ?? null, model: d.model ?? null })
        break
      case 'job.needs_input':
        emitSealed('job.ask', { jobId, ask: d.ask })
        if (pushOn.ask) emitPlain('push', { kind: 'ask', name: d.name ?? null })
        break
      case 'job.answered':
        emitSealed('job.answered', { askId: d.askId, behavior: d.behavior, source: d.source })
        break
      case 'job.done':
      case 'job.failed':
        emitSealed(evt.type, {
          jobId, outcome: d.outcome ?? null, result: d.result ?? null,
          cost: d.costUsd ?? d.cost ?? null, turns: d.turns ?? null,
          diff: d.diff ?? null, denials: d.denials ?? [],
        })
        if (evt.type === 'job.failed' && pushOn.failed) emitPlain('push', { kind: 'failed', name: d.name ?? null })
        if (evt.type === 'job.done' && pushOn.done) emitPlain('push', { kind: 'done', name: d.name ?? null })
        break
      case 'job.handoff':
        emitSealed('job.handoff', { jobId, diff: d.diff ?? null })
        break
      case 'limits.updated':
        emitSealed('window', {
          provider: d.provider, account: d.account ?? 'default',
          resetsAt: d.resetsAt ?? null, usedPct: d.usedPercent ?? null, source: 'vendor',
        })
        break
    }
  })

  async function handleRpc(method, params) {
    if (method === 'ping') return { pong: true, uplink: true, authed: true }
    if (method === 'state.snapshot') {
      // the phone's catch-up: everything the calendar needs for a date range,
      // sealed — the worker relays a blob it cannot read
      if (!state.sealKey) throw new Error('uplink not ready')
      const to = Number(params?.to) || Date.now() + 2 * 86_400_000
      const from = Number(params?.from) || Date.now() - 14 * 86_400_000
      const snapshot = {
        at: Date.now(),
        segments: [...querySegments(from, to), ...scheduleGhosts()],
        windows: windowsNow(),
        // recent project dirs so the phone's create sheet can offer a cwd —
        // absolute paths (the scheduler spawns from them at fire time)
        recentProjects: db.prepare(
          `SELECT cwd, MAX(last_at) la FROM sessions
           WHERE cwd IS NOT NULL AND cwd LIKE '/%' GROUP BY cwd ORDER BY la DESC LIMIT 8`
        ).all().map((r) => r.cwd),
      }
      return { enc: b64url(encryptSecretBox(snapshot, state.sealKey)) }
    }
    // create a schedule FROM the phone: params.enc is the sealed spec
    // {name, when, action} — same contract as POST /api/v1/schedules. The
    // prompt only ever exists decrypted on the two paired ends.
    if (method === 'schedule.create') {
      if (!state.sealKey) throw new Error('uplink not ready')
      const spec = decryptSecretBox(Buffer.from(String(params?.enc ?? ''), 'base64url'), state.sealKey)
      if (!spec) throw new Error('could not decrypt the schedule — re-pair the phone')
      const row = scheduler.create(spec)
      return { ok: true, enc: b64url(encryptSecretBox({ id: row.id, fireAt: row.fire_at }, state.sealKey)) }
    }
    if (method === 'schedule.cancel') {
      const ok = scheduler.cancel(String(params?.id ?? ''))
      return { ok }
    }
    if (method === 'job.answer') {
      // app sends {jobId (=our scheduleId), askId, behavior, message}
      const r = await scheduler.answer(params?.jobId, params?.askId, params?.behavior, params?.message)
      if (!r) return { ok: false, error: 'no running job with a pending ask' }
      return { ok: true }
    }
    throw new Error(`unknown method ${method}`)
  }

  // one-time ws-ticket keeps the host token out of URLs (see acal-runner.js);
  // legacy ?token= fallback covers a worker that predates the ticket route
  async function hostWsUrl() {
    const wsBase = api.replace(/^http/, 'ws')
    try {
      const res = await fetch(`${api}/v1/machines/${state.machineId}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.hostToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const { ticket } = await res.json()
        if (ticket) return `${wsBase}/v1/machines/${state.machineId}/host?ticket=${encodeURIComponent(ticket)}`
      }
    } catch {}
    return `${wsBase}/v1/machines/${state.machineId}/host?token=${encodeURIComponent(state.hostToken)}`
  }

  async function connect() {
    if (state.stopped || !state.machineId) return
    state.ws = new WebSocket(await hostWsUrl())
    state.ws.onopen = () => {
      state.backoff = 1000
      state.lastPong = Date.now()
      onLog(`mobile uplink connected (machine ${state.machineId.slice(0, 8)})`)
      for (const e of outbox) send(e)
    }
    state.ws.onmessage = async (ev) => {
      if (ev.data === 'pong') { state.lastPong = Date.now(); return }
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.t === 'event-ack') {
        if (msg.boot === boot) while (outbox.length && outbox[0].eid <= msg.eid) outbox.shift()
        return
      }
      if (msg.t === 'rpc-req') {
        try {
          send({ t: 'rpc-res', id: msg.id, ok: true, result: await handleRpc(msg.method, msg.params) })
        } catch (e) {
          send({ t: 'rpc-res', id: msg.id, ok: false, error: e.message })
        }
      }
    }
    state.ws.onclose = () => { if (!state.stopped) reconnect() }
    state.ws.onerror = () => { try { state.ws.close() } catch {} }
  }

  function reconnect() {
    const wait = Math.min(state.backoff, RECONNECT_MAX_MS) * (0.8 + Math.random() * 0.4)
    state.backoff = Math.min(state.backoff * 2, RECONNECT_MAX_MS)
    setTimeout(connect, wait)
  }

  const heartbeat = setInterval(() => {
    if (state.ws?.readyState !== 1) return
    if (Date.now() - state.lastPong > 65_000) { try { state.ws.close() } catch {}; return }
    send('ping')
  }, 20_000)
  heartbeat.unref?.()

  registerMachine({ api, proKey: key, name: process.env.AGENTCAL_MACHINE_NAME || `${hostname()} · local`, kind: 'local' })
    .then((m) => {
      state.machineId = m.machineId
      state.hostToken = m.hostToken
      state.sealKey = payloadKey(master, m.machineId) // the app derives the same
      connect()
    })
    .catch((e) => onLog(`mobile uplink registration failed: ${e.message}`))

  return {
    get machineId() { return state.machineId },
    stop() { state.stopped = true; clearInterval(heartbeat); clearInterval(sweep); try { state.ws?.close() } catch {} },
  }
}
