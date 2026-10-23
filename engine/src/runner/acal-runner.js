import { execFile } from 'node:child_process'
import {
  readFileSync, existsSync, mkdirSync, createWriteStream,
  readdirSync, statSync, unlinkSync, openSync, readSync, closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runClaudeJob, createPermissionBroker, permissionSocketPath, askSummary } from '../drivers/claude.js'
import { runCodexJob } from '../drivers/codex.js'

// Is the agent CLI signed in on THIS box? The control plane can't see the
// VM's filesystem, so the runner reports it — provision uses this to keep a
// not-yet-signed-in VM up for the one-time /login instead of running a job
// that would only fail.
function claudeAuthed() {
  return existsSync(join(homedir(), '.claude', '.credentials.json'))
}
function codexAuthed() {
  return existsSync(join(homedir(), '.codex', 'auth.json'))
}

// acal-runner — the on-box agent. Runs on a Sprites VM OR a user's own machine
// (`agentcalendar runner`); the control plane treats both as "a machine". It
// dials OUT to the MachineHub Durable Object over wss (no inbound port, works
// behind NAT/firewalls), registers as the host, and:
//   - answers RPC (job.start / job.stop / job.list) from the owner
//   - runs each job in its own process via the stream-json driver
//   - streams job.* events to the DO's seq log → calendar sees them live
//
// Credentials never come from us: the box uses its own `claude` login (the
// persistent VM was signed in once; a BYO box already has the user's login).

const RECONNECT_MAX_MS = 30_000

export function gitHead(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 3000 }, (e, out) =>
      resolve(e ? null : out.trim()))
  })
}

const git = (cwd, args, timeout = 5000) => new Promise((resolve) =>
  execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 8 << 20 }, (e, out) => resolve(e ? null : out)))

const tmux = (args, timeout = 5000) => new Promise((resolve) =>
  execFile('tmux', args, { timeout }, (e, out) => resolve(e ? null : (out ?? ''))))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

const JOBS_DIR = join(homedir(), '.acal', 'jobs')

// Job mirror: a live, read-only view of a headless run inside the user's tmux
// session (the one ttyd serves as the browser terminal). The headless driver
// stays the engine and source of truth — the runner tees each normalized
// event to an ndjson file, and a `render` window in tmux tails it. Joining
// the terminal therefore shows the job working; taking over goes through
// `claude --resume` (pre-typed when the job ends, or forced via job.handoff).
export function createMirror(session, jobId, spec, cwd, opts = {}) {
  try { mkdirSync(JOBS_DIR, { recursive: true }) } catch {}
  const file = opts.file || join(JOBS_DIR, `${jobId}.ndjson`)
  const out = createWriteStream(file, { flags: 'a' })
  const win = `job-${jobId.slice(0, 8)}`
  const target = `${session}:${win}`
  const shell = opts.shell || 'bash'
  const shellName = shell.split('/').pop()
  // every command runs from the JOB's cwd: claude stores sessions per project
  // directory, so `claude --resume <sid>` only finds this job's conversation
  // when invoked from where the job ran
  const inCwd = (cmd) => `cd ${shq(cwd)} 2>/dev/null; ${cmd}`
  let windowOpen = false
  const write = (e) => { try { out.write(JSON.stringify(e) + '\n') } catch {} }
  write({ type: 'meta', jobId, agent: spec.agent === 'codex' ? 'codex' : 'claude', prompt: spec.prompt, ts: Date.now() })

  // CONTRACT: the window re-invokes THIS process's entry (argv[1]) with
  // `render <file>` — bin/agentcal.js and the sprite bundle both dispatch it;
  // any other embedder of startRunner must too, or skip tmuxSession.
  async function openWindow() {
    const cmd = inCwd(`${shq(process.execPath)} ${shq(process.argv[1])} render ${shq(file)}; exec ${shell} -i`)
    // local mode: no ttyd session exists — the mirror gets its own detached
    // session the user can `tmux attach -t <session>` into
    if (opts.createSession) {
      windowOpen = (await tmux(['new-session', '-d', '-s', session, '-n', win, '-c', cwd, cmd])) != null
      return
    }
    // the terminal service may still be booting when a job lands — retry ~60s;
    // no session means no mirror (never create it: ttyd's attach owns that).
    for (let i = 0; i < 12; i++) {
      if (await tmux(['has-session', '-t', session]) != null) {
        windowOpen = (await tmux(['new-window', '-t', session, '-n', win, cmd])) != null
        return
      }
      await sleep(5000)
    }
  }

  // after the run ends the renderer execs into the shell — pre-type the
  // takeover command there (no Enter: executing an agent is always the
  // user's keypress)
  async function preType(cmd) {
    if (!windowOpen) return
    for (let i = 0; i < 30; i++) {
      const cur = await tmux(['display-message', '-p', '-t', target, '#{pane_current_command}'])
      if (cur == null) return // window closed by the user
      if (cur.trim() === shellName) {
        await tmux(['send-keys', '-t', target, '-l', cmd])
        return
      }
      await sleep(500)
    }
  }

  // handoff: replace whatever the window runs with the interactive session
  async function respawn(cmd) {
    const shellCmd = inCwd(`${cmd}; exec ${shell} -i`)
    if (windowOpen && (await tmux(['respawn-window', '-k', '-t', target, shellCmd])) != null) return true
    if (await tmux(['has-session', '-t', session]) != null) {
      return (await tmux(['new-window', '-t', session, '-n', win, shellCmd])) != null
    }
    return false
  }

  return { file, session, write, openWindow, preType, respawn, close: () => { try { out.end() } catch {} } }
}

// `render <file>` mode: tail a job's ndjson mirror file and pretty-print it.
// Runs inside the tmux window createMirror opens; exits when the job ends
// (the window then falls through to an interactive shell).
export function renderJobFile(file) {
  const DIM = '\x1b[2m', B = '\x1b[1m', R = '\x1b[0m'
  let offset = 0
  let buf = ''
  let sessionId = null
  let agent = 'claude'
  let lastData = Date.now()

  const printEvent = (line) => {
    let e
    try { e = JSON.parse(line) } catch { return }
    switch (e.type) {
      case 'meta':
        if (e.agent) agent = e.agent
        console.log(`${B}▦ agentcal cloud job ${String(e.jobId || '').slice(0, 8)}${R}`)
        if (e.prompt) console.log(`${DIM}${String(e.prompt).slice(0, 400)}${R}`)
        console.log('')
        break
      case 'session':
        sessionId = e.sessionId
        console.log(`${DIM}▸ session ${e.sessionId} · ${e.model ?? ''}${R}\n`)
        break
      case 'assistant':
        console.log(`${e.text}\n`)
        break
      case 'tool_use':
        console.log(`${DIM}⏺ ${e.name}${R}`)
        break
      case 'tool_result':
        if (e.ok === false) console.log(`${DIM}  ⎿ failed${R}`)
        break
      case 'error':
        console.log(`✗ ${e.message}`)
        break
      case 'ask':
        if (e.kind === 'question') {
          console.log(`${B}⚑ the agent asks:${R} ${e.summary ?? ''}`)
          if (Array.isArray(e.choices) && e.choices.length) console.log(`${DIM}  options: ${e.choices.join(' · ')}${R}`)
        } else {
          console.log(`${B}⚑ needs you: ${e.tool}${R} ${DIM}${e.summary ?? ''}${R}`)
        }
        console.log(`${DIM}  answer from the calendar (or take over here)${R}`)
        break
      case 'answered':
        console.log(`${DIM}  ⎿ ${e.tool}: ${e.behavior}${e.source === 'timeout' ? ' (timed out)' : ''}${R}`)
        break
      case 'handoff':
        console.log(`\n${B}— taking over: this window becomes the interactive session —${R}`)
        setTimeout(() => process.exit(0), 150)
        break
      case 'done': {
        const sid = e.sessionId ?? sessionId
        const cost = e.cost != null ? ` · $${Number(e.cost).toFixed(2)}` : ''
        const turns = e.turns != null ? ` · ${e.turns} turns` : ''
        console.log(`\n${B}— job ${e.ok ? 'finished ✓' : 'failed ✗'}${cost}${turns} —${R}`)
        const resume = agent === 'codex' ? `codex resume ${sid}` : `claude --resume ${sid}`
        if (sid) console.log(`${DIM}take over: ${resume}   (pre-typed below — press Enter)${R}`)
        setTimeout(() => process.exit(0), 150)
        break
      }
    }
  }

  const poll = () => {
    let st
    try { st = statSync(file) } catch { return }
    if (st.size < offset) offset = 0
    if (st.size === offset) {
      // runner died mid-job and nothing will ever finish this file — don't
      // hold the window hostage forever
      if (Date.now() - lastData > 2 * 60 * 60_000) {
        console.log(`\n${DIM}— no activity for 2h, closing viewer —${R}`)
        process.exit(0)
      }
      return
    }
    lastData = Date.now()
    let chunk
    try {
      const fd = openSync(file, 'r')
      chunk = Buffer.alloc(st.size - offset)
      readSync(fd, chunk, 0, chunk.length, offset)
      closeSync(fd)
    } catch { return }
    offset = st.size
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) printEvent(line)
    }
  }

  setInterval(poll, 400)
  poll()
}

// +files / +ins / -del since a base commit. `git diff --numstat` covers tracked
// changes but NOT new untracked files, so count those separately (the omnara
// GitDiffTracker lesson — a job's whole point is often creating files).
export async function gitNumstat(cwd, base) {
  if (!base) return null
  let files = 0, ins = 0, del = 0
  const tracked = await git(cwd, ['diff', '--numstat', base])
  if (tracked == null) return null
  for (const line of tracked.split('\n')) {
    if (!line.trim()) continue
    const [a, b] = line.split('\t')
    files++
    if (a !== '-') ins += Number(a) || 0
    if (b !== '-') del += Number(b) || 0
  }
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'])
  for (const rel of (untracked || '').split('\n')) {
    if (!rel.trim()) continue
    files++
    try {
      const text = readFileSync(join(cwd, rel), 'utf8')
      ins += text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
    } catch {}
  }
  return { files, insertions: ins, deletions: del }
}

export function startRunner({ api, machineId, hostToken, tmuxSession = null, onLog = () => {} }) {
  const wsBase = api.replace(/^http/, 'ws').replace(/\/$/, '')

  // Prefer a one-time ws-ticket (host token stays in a header, never a URL —
  // query strings land in request logs); fall back to the legacy ?token=
  // query for workers that predate the ticket route.
  async function hostWsUrl() {
    try {
      const res = await fetch(`${api.replace(/\/$/, '')}/v1/machines/${machineId}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hostToken}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const { ticket } = await res.json()
        if (ticket) return `${wsBase}/v1/machines/${machineId}/host?ticket=${encodeURIComponent(ticket)}`
      }
    } catch {}
    return `${wsBase}/v1/machines/${machineId}/host?token=${encodeURIComponent(hostToken)}`
  }
  const jobs = new Map() // jobId -> { stop, done, agent, cwd, sessionId, handedOff, mirror }
  let ws = null
  let backoff = 1000
  let stopped = false

  // absolute agent-CLI paths for tmux respawn commands — `sh -c` windows
  // don't read .bashrc, so bare `claude`/`codex` may be off their PATH
  const bins = { claude: 'claude', codex: 'codex' }
  for (const name of Object.keys(bins)) {
    execFile('sh', ['-lc', `command -v ${name}`], { timeout: 5000 }, (e, out) => {
      if (!e && out.trim()) bins[name] = out.trim().split('\n').pop()
    })
  }
  // the interactive continuation of a finished/handed-off job, per agent
  const resumeCmd = (agent, sid) =>
    agent === 'codex' ? `${bins.codex} resume ${sid}` : `${bins.claude} --resume ${sid}`

  // mirror files are per-job debris; drop anything older than a week
  try {
    for (const f of readdirSync(JOBS_DIR)) {
      const p = join(JOBS_DIR, f)
      try { if (Date.now() - statSync(p).mtimeMs > 7 * 86_400_000) unlinkSync(p) } catch {}
    }
  } catch {}

  // Outbound events queue until the hub acks them into its seq log — a job
  // that finishes mid-reconnect must not vanish from the calendar's history.
  // eids are monotonic within one runner boot and the hub dedups on
  // (boot, eid), so replaying the whole outbox after a reconnect is safe.
  const boot = (globalThis.crypto?.randomUUID?.() ?? String(Date.now())).slice(0, 8)
  const outbox = []
  let eid = 0
  let lastPong = Date.now()

  const send = (obj) => { try { ws?.send(typeof obj === 'string' ? obj : JSON.stringify(obj)) } catch {} }
  const emit = (type, data) => {
    outbox.push({ t: 'event', boot, eid: ++eid, ts: Date.now(), type, data })
    if (outbox.length > 1000) { outbox.shift(); onLog('outbox overflow: dropped oldest unacked event') }
    if (ws?.readyState === 1) send(outbox[outbox.length - 1])
  }

  // Half-dead sockets are the norm behind NAT. The hub answers 'ping' with
  // 'pong' in the runtime itself (no hibernation wake); two missed pongs
  // means the link is a corpse — close it so reconnect/replay kicks in.
  const heartbeat = setInterval(() => {
    if (ws?.readyState !== 1) return
    if (Date.now() - lastPong > 65_000) { try { ws.close() } catch {}; return }
    send('ping')
  }, 20_000)
  heartbeat.unref?.()

  async function startJob(params) {
    const jobId = params.jobId || (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
    // a retried job.start RPC must not orphan the first process's handle
    if (jobs.has(jobId)) return { jobId, accepted: false, error: 'job id already running' }
    const spec = params.spec || params // tolerate {spec} or flat
    const agent = spec.agent === 'codex' ? 'codex' : 'claude'
    const cwd = spec.cwd || process.cwd()
    const base = await gitHead(cwd)
    onLog(`job ${jobId.slice(0, 8)} start (${agent}): ${(spec.prompt || '').slice(0, 60)}`)

    const mirror = tmuxSession ? createMirror(tmuxSession, jobId, spec, cwd) : null
    mirror?.openWindow()
    const rec = { stop: () => {}, done: null, agent, cwd, sessionId: null, handedOff: false, mirror, broker: null, denied: new Set() }

    // Ask plumbing shared by both agents: permission asks (non-fullAuto) and
    // ask_user questions (all modes) become job.ask hub events the calendar
    // shows as "needs you"; job.answer RPC resolves them. Claude delivers
    // asks through the unix-socket broker; codex sends them as in-process
    // JSON-RPC requests and its handle answers like a broker would.
    const onAsk = (ask) => {
      // ExitPlanMode = the plan approval (see schedules.js askHandlers) —
      // carry the plan text up so the calendar can render Implement/Refine
      const isPlan = ask.kind === 'permission' && ask.tool === 'ExitPlanMode'
      const plan = isPlan ? String(ask.input?.plan ?? '') : null
      const summary = isPlan ? (plan.replace(/\s+/g, ' ').slice(0, 300) || 'Plan ready') : askSummary(ask)
      const wire = {
        id: ask.id, kind: isPlan ? 'plan' : ask.kind, tool: ask.tool, summary,
        choices: ask.input?.choices ?? null, at: ask.at,
        ...(isPlan ? { plan: plan.slice(0, 20_000) } : {}),
      }
      mirror?.write({ type: 'ask', kind: wire.kind, tool: ask.tool, summary, choices: ask.input?.choices })
      emit('job.ask', { jobId, ask: wire })
      onLog(`job ${jobId.slice(0, 8)} asks (${wire.kind}): ${summary}`)
    }
    const onResolve = (resolved) => {
      if (resolved.behavior === 'deny') rec.denied.add(resolved.tool)
      mirror?.write({ type: 'answered', kind: resolved.kind, tool: resolved.tool, behavior: resolved.behavior, source: resolved.source })
      emit('job.answered', { jobId, askId: resolved.id, behavior: resolved.behavior, source: resolved.source })
    }
    const onEvent = (e) => {
      // a handed-off job's kill looks like a failure to the driver — the
      // mirror shows the takeover banner instead of a bogus ✗
      if (e.type === 'done') mirror?.write(rec.handedOff ? { type: 'handoff' } : { ...e, sessionId: rec.sessionId })
      else mirror?.write(e)
      if (e.type === 'session') {
        rec.sessionId = e.sessionId
        emit('job.started', { jobId, sessionId: e.sessionId, model: e.model })
      } else if (e.type === 'assistant') emit('job.progress', { jobId, kind: 'message', text: e.text })
      else if (e.type === 'tool_use') emit('job.progress', { jobId, kind: 'tool', name: e.name })
      else if (e.type === 'tokens') emit('job.progress', { jobId, kind: 'tokens', input: e.input, output: e.output })
      else if (e.type === 'error' && !rec.handedOff) emit('job.progress', { jobId, kind: 'error', message: e.message })
    }

    // native protocol stream — the same debugging artifact local runs keep;
    // pruned with the rest of JOBS_DIR after a week
    let native = null
    try { mkdirSync(JOBS_DIR, { recursive: true }); native = createWriteStream(join(JOBS_DIR, `${jobId}.native.ndjson`)) } catch {}
    const common = {
      prompt: spec.prompt,
      cwd,
      model: spec.model || undefined,
      effort: spec.effort || undefined,
      fullAuto: !!spec.fullAuto,
      mode: spec.mode || undefined,
      maxRuntimeMs: (spec.maxRuntimeMin || 30) * 60_000,
      onEvent,
      onRaw: (r) => { try { native?.write(JSON.stringify({ ts: Date.now(), ...r }) + '\n') } catch {} },
    }
    let job
    if (agent === 'codex') {
      job = runCodexJob({ ...common, onAsk, onResolve })
      rec.broker = job // broker-compatible handle: answer(askId, behavior, message)
    } else {
      try { mkdirSync(JOBS_DIR, { recursive: true }) } catch {}
      rec.broker = createPermissionBroker({ socketPath: permissionSocketPath(JOBS_DIR, jobId), onAsk, onResolve })
      job = runClaudeJob({ ...common, permissionSocket: rec.broker.socketPath })
    }
    rec.stop = job.stop
    rec.done = job.done
    jobs.set(jobId, rec)
    job.done.then(async (r) => {
      jobs.delete(jobId)
      rec.broker?.close()
      const diff = await gitNumstat(cwd, base)
      if (rec.handedOff) {
        // not done, not failed: the user pulled the run into the terminal.
        // The block stays open; the VM keeps running until Stop or the cap.
        emit('job.handoff', { jobId, sessionId: rec.sessionId, diff })
        onLog(`job ${jobId.slice(0, 8)} handed off to terminal`)
      } else {
        // outcome makes "green but did nothing" impossible to miss: a run
        // that got tools denied is blocked, a clean run that changed no
        // files is no_changes — the calendar renders both differently
        const denials = [...new Set([...(r.denials ?? []), ...rec.denied])]
        const outcome = !r.ok ? 'failed'
          : denials.length ? 'blocked'
          : diff ? (diff.files === 0 ? 'no_changes' : 'changed')
          : 'done'
        emit(r.ok ? 'job.done' : 'job.failed', {
          jobId, ok: r.ok, result: (r.result || '').slice(-2000),
          cost: r.cost, turns: r.turns, stopReason: r.stopReason, diff, denials, outcome,
        })
        if (rec.sessionId) await mirror?.preType(resumeCmd(rec.agent, rec.sessionId))
        onLog(`job ${jobId.slice(0, 8)} ${r.ok ? outcome : 'failed'}`)
      }
      try { native?.end() } catch {}
      mirror?.close()
    }).catch((e) => {
      // a finalize throw must never strand the job as running-forever: report
      // it as failed and free the slot
      jobs.delete(jobId)
      try { rec.broker?.close() } catch {}
      try { native?.end() } catch {}
      try { mirror?.close() } catch {}
      emit('job.failed', { jobId, ok: false, result: `finalize error: ${e.message}`, outcome: 'failed' })
      onLog(`job ${jobId.slice(0, 8)} finalize error: ${e.message}`)
    })
    return { jobId, accepted: true }
  }

  // Take over a running job: stop the headless process (its session file is
  // already on disk), then turn the mirror window into `claude --resume` —
  // the browser terminal the user is looking at becomes the live conversation.
  async function handoffJob({ jobId }) {
    const rec = jobs.get(jobId)
    if (!rec) return { ok: false, error: 'no such job' }
    if (!rec.sessionId) return { ok: false, error: 'job has no session yet — try again in a few seconds' }
    rec.handedOff = true
    rec.stop()
    // never let two frontends share one session file: wait for the headless
    // process to die before the interactive resume starts
    await Promise.race([rec.done, sleep(8000)])
    const interactive = rec.mirror ? await rec.mirror.respawn(resumeCmd(rec.agent, rec.sessionId)) : false
    onLog(`job ${jobId.slice(0, 8)} handoff (${interactive ? 'interactive in tmux' : 'no tmux window — resume manually'})`)
    return { ok: true, sessionId: rec.sessionId, interactive }
  }

  function handleRpc(method, params) {
    if (method === 'job.start') return startJob(params || {})
    if (method === 'job.handoff') return handoffJob(params || {})
    if (method === 'job.stop') {
      const j = jobs.get(params?.jobId)
      if (!j) return { ok: false, error: 'no such job' }
      j.stop()
      return { ok: true }
    }
    if (method === 'job.answer') {
      // clear a pending permission ask: {jobId, askId, behavior: allow|deny}
      const j = jobs.get(params?.jobId)
      if (!j) return { ok: false, error: 'no such job' }
      if (!j.broker) return { ok: false, error: 'job has no permission broker (full-auto run)' }
      const ok = j.broker.answer(params?.askId, params?.behavior, params?.message)
      return ok ? { ok: true } : { ok: false, error: 'no such ask — it may have timed out' }
    }
    if (method === 'job.list') {
      return { jobs: [...jobs.keys()].map((id) => ({ jobId: id, agent: jobs.get(id).agent })) }
    }
    if (method === 'ping') {
      // authed keeps its historical meaning (claude) for the control plane's
      // needs-login flow; agents carries the per-CLI truth for codex routing
      return { pong: true, jobs: jobs.size, authed: claudeAuthed(), agents: { claude: claudeAuthed(), codex: codexAuthed() } }
    }
    throw new Error(`unknown method ${method}`)
  }

  async function connect() {
    if (stopped) return
    ws = new WebSocket(await hostWsUrl())
    ws.onopen = () => {
      backoff = 1000
      lastPong = Date.now()
      onLog(`connected to hub as ${machineId.slice(0, 8)}`)
      for (const e of outbox) send(e) // replay everything the hub hasn't acked
    }
    ws.onmessage = async (ev) => {
      if (ev.data === 'pong') { lastPong = Date.now(); return }
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.t === 'welcome') return onLog(`hub welcome (lastSeq ${msg.lastSeq})`)
      if (msg.t === 'event-ack') {
        if (msg.boot === boot) while (outbox.length && outbox[0].eid <= msg.eid) outbox.shift()
        return
      }
      if (msg.t === 'rpc-req') {
        try {
          const result = await handleRpc(msg.method, msg.params)
          send({ t: 'rpc-res', id: msg.id, ok: true, result })
        } catch (e) {
          send({ t: 'rpc-res', id: msg.id, ok: false, error: e.message })
        }
      }
    }
    ws.onclose = () => { if (!stopped) reconnect() }
    ws.onerror = () => { try { ws.close() } catch {} }
  }

  function reconnect() {
    const wait = Math.min(backoff, RECONNECT_MAX_MS) * (0.8 + Math.random() * 0.4)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    onLog(`disconnected, retrying in ${Math.round(wait / 1000)}s`)
    setTimeout(connect, wait)
  }

  connect()
  return {
    stop() { stopped = true; clearInterval(heartbeat); for (const j of jobs.values()) j.stop(); try { ws?.close() } catch {} },
    get jobCount() { return jobs.size },
  }
}

// register a machine with the control plane, returns {machineId, hostToken}
export async function registerMachine({ api, proKey, name, kind = 'byo' }) {
  const res = await fetch(`${api}/v1/machines/register`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `register failed: HTTP ${res.status}`)
  return data
}
