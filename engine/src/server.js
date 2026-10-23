import { createServer } from 'node:http'
import { readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowStatus } from './windows.js'
import { buildIcs } from './ics.js'
import { latestLimits } from './limits.js'
import { agentModels } from './models.js'
import { federate, runnerStatuses, runnerFetch } from './runners.js'
import { proKey, cloudMe, cloudFetch, saveKey, clearKey, verifyKey, provisionVm, stopVm, machineRpc, deviceStart, devicePoll } from './cloud.js'
import { DATA_DIR, saveUserConfig } from './config.js'
import { rescheduleExternalJob } from './external.js'
import { masterSecret, authPublicKeyB64, pairUrl } from './secret.js'
import { remoteStatus, remoteUp, remoteDown } from './pair.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Per-install auth token. The local server binds to 127.0.0.1, but the browser
// is a remote-code path: without this gate any website the user visits could
// POST a shell-command schedule to localhost and get drive-by RCE. The token
// is minted once, stored 0600 in ~/.agentcal, embedded into the served HTML
// (so the same-origin UI has it) and required on browser-originated API calls.
const TOKEN_FILE = join(DATA_DIR, 'token')
function loadToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const t = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (t.length >= 32) return t
    }
  } catch {}
  const t = randomBytes(32).toString('hex')
  try { writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 }) } catch {}
  return t
}
const TOKEN = loadToken()

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
// Extra hostnames allowed past the DNS-rebinding guard — used for Tailscale
// Serve (phone → https://mac.tailnet.ts.net → loopback proxy → us). Populated
// from config.json remoteHosts at boot and via POST /api/v1/remote-hosts.
const EXTRA_HOSTS = new Set()
const allowedHost = (h) => LOCAL_HOSTS.has(h) || EXTRA_HOSTS.has(h)
const hostnameOf = (value) => {
  try { return new URL(value).hostname.replace(/^\[|\]$/g, '') } catch { return null }
}
function tokenPresented(req, url) {
  const auth = req.headers['authorization']
  const provided = (auth && auth.startsWith('Bearer ') && auth.slice(7)) ||
    req.headers['x-acal-token'] || url.searchParams.get('token')
  if (!provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}
// Decide whether a request to a protected path (/api/*, /calendar.ics) is
// allowed. Returns null to allow, or {code, error} to reject.
function guard(req, url, p) {
  // DNS-rebinding defense: the Host must resolve to us, not an attacker domain
  // pointed at 127.0.0.1. (Node gives host as "hostname:port".)
  const host = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
  if (host && !allowedHost(host)) return { code: 403, error: 'non-local host rejected' }
  const origin = req.headers.origin
  if (origin) {
    // Any browser cross-origin request carries an Origin the page cannot forge
    // or drop — reject everything that isn't our own localhost origin.
    const oh = hostnameOf(origin)
    if (!oh || !allowedHost(oh)) return { code: 403, error: 'cross-origin request rejected' }
  }
  // Requests that carry a body must be JSON — blocks the CSRF "simple request"
  // content-types (text/plain, form-encoded, multipart) outright.
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = (req.headers['content-type'] || '').toLowerCase()
    if (ct && !ct.startsWith('application/json')) return { code: 415, error: 'content-type must be application/json' }
  }
  // Token gate. A page can never issue a request WITHOUT an Origin header, so a
  // no-Origin call is not browser-initiated (federation, the already-running
  // status probe, ics subscribers, curl) and is not the drive-by vector — let
  // it through. Browser-origin calls need the token, minus the innocuous probe.
  if (origin && p !== '/api/v1/status' && !tokenPresented(req, url)) {
    return { code: 401, error: 'missing or invalid token — reload the AgentCalendar tab' }
  }
  // Remote (tailnet) requests don't get the local-process benefit of the
  // doubt: anything arriving under a non-local Host needs the token, Origin
  // or not — except the innocuous status probe.
  if (host && !LOCAL_HOSTS.has(host) && p !== '/api/v1/status' && !tokenPresented(req, url)) {
    return { code: 401, error: 'missing or invalid token' }
  }
  return null
}
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()


function json(res, code, data) {
  // No wildcard CORS: the UI is same-origin (needs no ACAO), and withholding it
  // is what stops a cross-origin page from READING sessions/prompts/cloud creds.
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1_048_576) reject(new Error('body too large'))
      else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function createApi({ db, cfg, bus, webhooks, scheduler, sources, hq, missions, heartbeat = null }) {
  for (const h of cfg.remoteHosts ?? []) EXTRA_HOSTS.add(String(h).toLowerCase())
  let cloudCache = { ts: 0, data: null }
  let machinesCache = { ts: 0, data: null }
  let cloudSetup = null // in-flight one-click VM setup (see /api/v1/cloud/setup)
  let cloudSignin = null // in-flight device-flow sign-in (see /api/v1/cloud/signin-start)
  const sseClients = new Set()
  bus.on((evt) => {
    const msg = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`
    for (const res of sseClients) res.write(msg)
  })
  setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n')
  }, 30_000).unref()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const range = () => {
      const now = Date.now()
      const from = Number(url.searchParams.get('from')) || now - 7 * 86_400_000
      const to = Number(url.searchParams.get('to')) || now
      return { from, to }
    }

    try {
      if (req.method === 'OPTIONS') {
        // Only our own localhost origin gets a CORS grant; a cross-origin
        // preflight goes unanswered, so its non-simple request never fires.
        const origin = req.headers.origin
        const headers = {
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
          'access-control-allow-headers': 'content-type, authorization, x-acal-token',
          vary: 'origin',
        }
        const oh = origin && hostnameOf(origin)
        if (oh && LOCAL_HOSTS.has(oh)) headers['access-control-allow-origin'] = origin
        res.writeHead(204, headers)
        return res.end()
      }

      // Auth gate for the local API + calendar feed (see guard()).
      if (p.startsWith('/api/') || p === '/calendar.ics') {
        const denied = guard(req, url, p)
        if (denied) return json(res, denied.code, { error: denied.error })
      }

      // --- API ---
      if (p === '/api/v1' || p === '/api/v1/') {
        return json(res, 200, {
          name: 'agentcal',
          docs: 'https://github.com/milind-soni/agentcal',
          routes: {
            'GET /api/v1/status': 'providers, accounts, session counts',
            'GET /api/v1/segments?from&to&provider': 'calendar blocks (epoch ms)',
            'GET /api/v1/sessions?from&to': 'sessions with project/title/model/tokens',
            'GET /api/v1/windows': 'rate-limit windows per provider/account: nextResetAt, usedPercent, weekly; source=vendor|inferred',
            'GET /api/v1/limits': 'latest vendor-confirmed limit snapshots (5h, weekly, per-model)',
            'GET /api/v1/events?since&type&limit': 'event history',
            'GET /api/v1/stream': 'SSE live event stream',
            'GET|POST /api/v1/webhooks': 'subscriptions {url, events, secret?}; HMAC-signed deliveries',
            'POST /api/v1/webhooks/{id}/test': 'send a sample event to the hook now',
            'DELETE /api/v1/webhooks/{id}': 'remove subscription',
            'GET|POST /api/v1/schedules': "{name, when:{type:'at'|'next_reset',value}, action:{type:'command'|'webhook',value}}",
            'DELETE /api/v1/schedules/{id}': 'cancel pending schedule',
            'GET /api/v1/cloud': 'license status + hours used (key never leaves this process)',
            'POST /api/v1/cloud/login': '{key} — verify + store an ACAL license key',
            'GET /api/v1/cloud/machines': 'cloud-dispatchable machines with live online + signed-in state',
            'POST /api/v1/cloud/setup': 'one-click cloud onboarding: wake the VM for the one-time /login, auto-sleep after',
            'DELETE /api/v1/cloud/machines/{id}': 'revoke a machine (its runner token stops working)',
            'POST /api/v1/schedules/{id}/takeover': 'take over a running cloud job: its terminal window becomes claude --resume',
            'POST /api/v1/schedules/{id}/answer': "answer a job's pending permission ask: {askId, behavior:'allow'|'deny'}",
            'GET /calendar.ics': 'iCal feed: sessions + upcoming resets',
          },
          eventTypes: [
            'session.started', 'session.active', 'session.idle', 'segment.started',
            'window.opened', 'window.reset.upcoming', 'window.reset', 'schedule.started', 'schedule.fired',
            'job.started', 'job.done', 'job.failed', 'job.handoff', 'job.needs_input', 'job.answered',
            'limits.updated',
          ],
        })
      }
      if (p === '/api/v1/status') {
        const active = db.prepare("SELECT COUNT(*) n FROM sessions WHERE state = 'active'").get().n
        const total = db.prepare('SELECT COUNT(*) n FROM sessions').get().n
        // other live agentcal processes on this same db: a stale launchd
        // daemon or forgotten npx run quietly races this one for jobs — the
        // UI turns this into a warning banner (loud when versions differ)
        const peers = (heartbeat?.peers() ?? []).map((peer) => ({
          pid: peer.pid, port: peer.port, version: peer.version, exe: peer.exe, startedAt: peer.started_at,
        }))
        return json(res, 200, {
          name: 'agentcal', version: VERSION, now: Date.now(),
          sources: sources.map((s) => ({ provider: s.provider, account: s.account, root: s.root })),
          sessions: { total, active },
          instances: {
            self: { pid: process.pid, version: VERSION },
            peers,
            conflict: peers.length > 0,
            versionMismatch: peers.some((peer) => peer.version && peer.version !== VERSION),
          },
        })
      }
      if (p === '/api/v1/segments') {
        const { from, to } = range()
        const provider = url.searchParams.get('provider')
        const rows = db.prepare(
          `SELECT g.id, g.session_id, g.provider, g.account, g.started_at, g.ended_at,
                  s.project, s.title, s.model, s.state, s.cwd, s.session_key
           FROM segments g JOIN sessions s ON s.id = g.session_id
           WHERE g.ended_at >= ? AND g.started_at <= ? ${provider ? 'AND g.provider = ?' : ''}
           ORDER BY g.started_at`
        ).all(...(provider ? [from, to, provider] : [from, to]))
        const remote = (await federate(cfg, `/api/v1/segments?from=${from}&to=${to}`, 'segments'))
          .filter((row) => !provider || row.provider === provider)
        return json(res, 200, { segments: [...rows, ...remote] })
      }
      if (p === '/api/v1/sessions') {
        const { from, to } = range()
        const rows = db.prepare(
          'SELECT * FROM sessions WHERE last_at >= ? AND started_at <= ? ORDER BY last_at DESC'
        ).all(from, to)
        return json(res, 200, { sessions: rows })
      }
      if (p === '/api/v1/windows') {
        return json(res, 200, {
          windows: [...windowStatus(db, cfg), ...(await federate(cfg, '/api/v1/windows', 'windows'))],
        })
      }
      if (p === '/api/v1/runners') return json(res, 200, { runners: await runnerStatuses(cfg) })
      if (p === '/api/v1/cloud') {
        // licensed = key on disk; usage comes from the control plane (cached).
        // The key itself never leaves this process.
        if (!proKey()) return json(res, 200, { licensed: false, signedIn: false, plan: null })
        if (!cloudCache.data || Date.now() - cloudCache.ts > 300_000) {
          try {
            cloudCache = { ts: Date.now(), data: await cloudMe() }
          } catch {
            cloudCache = { ts: Date.now(), data: cloudCache.data ?? { offline: true } }
          }
        }
        const me = cloudCache.data
        return json(res, 200, {
          licensed: true,
          signedIn: true,
          plan: me.plan ?? (me.offline ? null : 'pro'),
          trialEndsAt: me.trialEndsAt ?? null,
          checkoutUrl: me.checkoutUrl ?? null,
          email: me.email ?? null,
          usage: me.usage ?? null,
          offline: me.offline === true,
        })
      }
      if (p === '/api/v1/cloud/refresh' && req.method === 'POST') {
        // after checkout: re-read entitlement immediately instead of waiting
        // out the 5-minute status cache
        cloudCache = { ts: 0, data: null }
        machinesCache = { ts: 0, data: null }
        if (!proKey()) return json(res, 200, { licensed: false, signedIn: false, plan: null })
        try {
          const me = await cloudMe()
          cloudCache = { ts: Date.now(), data: me }
          return json(res, 200, { licensed: true, signedIn: true, plan: me.plan ?? 'pro', trialEndsAt: me.trialEndsAt ?? null, checkoutUrl: me.checkoutUrl ?? null, email: me.email ?? null, usage: me.usage ?? null })
        } catch (e) {
          return json(res, 502, { error: e.message })
        }
      }
      if (p === '/api/v1/cloud/login' && req.method === 'POST') {
        // paste-key login from the UI: verify against the control plane
        // FIRST, only then persist. The key itself never goes back out.
        const body = await readBody(req)
        const key = String(body.key ?? '').trim()
        if (key.length < 8) return json(res, 400, { error: 'paste the full license key from your purchase email' })
        try {
          const me = await verifyKey(key)
          saveKey(key, me.email)
          cloudCache = { ts: Date.now(), data: me }
          machinesCache = { ts: 0, data: null }
          return json(res, 200, { licensed: true, email: me.email ?? null, usage: me.usage ?? null })
        } catch (e) {
          return json(res, 401, { error: e.message })
        }
      }
      if (p === '/api/v1/cloud/logout' && req.method === 'POST') {
        clearKey()
        cloudCache = { ts: 0, data: null }
        return json(res, 200, { ok: true })
      }
      if (p === '/api/v1/cloud/machines' && req.method === 'GET') {
        // machines this license can dispatch to (managed VM + BYO boxes),
        // with live online state from each machine's hub
        if (!proKey()) return json(res, 200, { machines: [] })
        if (!machinesCache.data || Date.now() - machinesCache.ts > 15_000) {
          try {
            const { machines } = await cloudFetch('/v1/machines', { timeoutMs: 15_000 })
            machinesCache = {
              ts: Date.now(),
              data: await Promise.all((machines ?? []).map(async (m) => {
                const st = await cloudFetch(`/v1/machines/${m.id}/status`, { timeoutMs: 10_000 }).catch(() => null)
                // an online runner also reports whether the agent CLI is
                // signed in — drives the "finish sign-in" onboarding state
                let authed = null
                if (st?.online) {
                  const ping = await machineRpc(m.id, 'ping').catch(() => null)
                  authed = ping?.result?.authed ?? null
                }
                return { ...m, online: st?.online ?? false, lastSeq: st?.lastSeq ?? null, authed }
              })),
            }
          } catch {
            machinesCache = { ts: Date.now(), data: machinesCache.data ?? [] }
          }
        }
        return json(res, 200, { machines: machinesCache.data })
      }
      if (p === '/api/v1/cloud/signin-start' && req.method === 'POST') {
        // Google sign-in without keys: request a device code, hand the browser
        // the approval URL, and poll in the background until the account
        // session token lands — stored via saveKey like a license key.
        try {
          const d = await deviceStart()
          if (cloudSignin?.timer) clearInterval(cloudSignin.timer)
          const signin = { at: Date.now() }
          signin.timer = setInterval(async () => {
            try {
              const token = await devicePoll(d.device_code)
              if (!token) return
              clearInterval(signin.timer)
              cloudSignin = null
              const me = await verifyKey(token)
              saveKey(token, me.email)
              cloudCache = { ts: 0, data: null }
              machinesCache = { ts: 0, data: null }
              bus.emit('cloud.signedin', { data: { email: me.email ?? null } })
            } catch {
              clearInterval(signin.timer)
              cloudSignin = null
            }
          }, Math.max(3, Number(d.interval) || 5) * 1000)
          signin.timer.unref?.()
          setTimeout(() => clearInterval(signin.timer), (Number(d.expires_in) || 600) * 1000).unref?.()
          cloudSignin = signin
          return json(res, 200, {
            userCode: d.user_code,
            verificationUrl: d.verification_uri_complete ?? d.verification_uri,
          })
        } catch (e) {
          return json(res, 502, { error: e.message })
        }
      }
      if (p === '/api/v1/cloud/box/join' && req.method === 'POST') {
        // fresh desktop URL at click time — stream tokens rotate per boot
        try { return json(res, 200, await cloudFetch('/v1/box/join', { method: 'POST', timeoutMs: 120_000 })) }
        catch (e) { return json(res, 502, { error: e.message }) }
      }
      if (p === '/api/v1/cloud/box/sleep' && req.method === 'POST') {
        try { return json(res, 200, await cloudFetch('/v1/box/sleep', { method: 'POST', timeoutMs: 30_000 })) }
        catch (e) { return json(res, 502, { error: e.message }) }
      }
      if (p === '/api/v1/cloud/setup' && req.method === 'POST') {
        // one-click cloud onboarding: wake/provision the VM with NO job, hand
        // the browser the terminal, then watch for the one-time /login — the
        // moment it lands, put the VM back to sleep (setup shouldn't burn
        // hours) and the machines list flips to signed-in.
        if (!proKey()) return json(res, 401, { error: 'connect your license key first' })
        const vm = await provisionVm({ name: 'cloud setup' })
        machinesCache = { ts: 0, data: null }
        if (cloudSetup?.timer) clearInterval(cloudSetup.timer)
        const setup = { vmId: vm.vmId, machineId: vm.machineId, startedAt: Date.now() }
        setup.timer = setInterval(async () => {
          try {
            const ping = await machineRpc(vm.machineId, 'ping').catch(() => null)
            const authed = ping?.result?.authed === true || ping?.result?.agents?.claude === true
            const expired = Date.now() - setup.startedAt > 20 * 60_000
            if (authed || expired) {
              clearInterval(setup.timer)
              cloudSetup = null
              machinesCache = { ts: 0, data: null }
              await stopVm(vm.vmId).catch(() => {})
            }
          } catch {}
        }, 10_000)
        setup.timer.unref?.()
        cloudSetup = setup
        return json(res, 200, { joinUrl: vm.joinUrl, credential: vm.credential, machineId: vm.machineId })
      }
      if (/^\/api\/v1\/cloud\/machines\/[\w-]+$/.test(p) && req.method === 'DELETE') {
        if (!proKey()) return json(res, 401, { error: 'not logged in — run: agentcalendar login <key>' })
        try {
          await cloudFetch(`/v1/machines/${p.split('/').pop()}`, { method: 'DELETE', timeoutMs: 15_000 })
          machinesCache = { ts: 0, data: null }
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 502, { error: e.message })
        }
      }
      if (/^\/api\/v1\/schedules\/[\w-]+\/answer$/.test(p) && req.method === 'POST') {
        // answer a running job's pending permission ask: {askId, behavior, message?}
        const body = await readBody(req)
        try {
          const r = await scheduler.answer(p.split('/')[4], body.askId, body.behavior, body.message)
          return r ? json(res, 200, r) : json(res, 404, { error: 'no running job with a pending ask on that schedule' })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (/^\/api\/v1\/schedules\/[\w-]+\/stop-cloud$/.test(p) && req.method === 'POST') {
        const stopped = await scheduler.stopCloud(p.split('/')[4])
        return stopped ? json(res, 200, stopped) : json(res, 404, { error: 'no running cloud VM on that job' })
      }
      if (/^\/api\/v1\/schedules\/[\w-]+\/takeover$/.test(p) && req.method === 'POST') {
        // hand a running cloud job to the user: the VM's job window becomes
        // `claude --resume` and the browser terminal is the live conversation
        try {
          const r = await scheduler.takeoverCloud(p.split('/')[4])
          return r ? json(res, 200, r) : json(res, 404, { error: 'no running cloud job to take over on that schedule' })
        } catch (e) {
          return json(res, 502, { error: e.message })
        }
      }
      if (p === '/api/v1/mobile/pair' && req.method === 'POST') {
        // Pair a phone: register this install's derived device pubkey with the
        // control plane (so the app's /v1/auth succeeds), then hand back the
        // QR deep link that carries the pairing secret. Pro-gated — mobile
        // rides the control plane. The secret only ever travels localhost.
        if (!proKey()) return json(res, 401, { error: 'connect your license key first — mobile is a Pro feature' })
        const secret = masterSecret()
        try {
          await cloudFetch('/v1/mobile/devices', {
            method: 'POST', timeoutMs: 15_000,
            body: { pubkey: authPublicKeyB64(secret), name: 'phone' },
          })
        } catch (e) {
          return json(res, 502, { error: `could not register the device: ${e.message}` })
        }
        return json(res, 200, { pairUrl: pairUrl(secret) })
      }
      if (p === '/api/v1/limits') return json(res, 200, { limits: latestLimits(db) })
      if (p === '/api/v1/models') return json(res, 200, agentModels(cfg))
      if (p === '/api/v1/external-jobs') {
        return json(res, 200, {
          jobs: [
            ...db.prepare('SELECT * FROM external_jobs ORDER BY next_run_at').all(),
            ...(await federate(cfg, '/api/v1/external-jobs', 'jobs')),
          ],
        })
      }
      if (p.startsWith('/api/v1/external-jobs/') && req.method === 'PATCH') {
        // drag-to-reschedule for OpenClaw/Hermes cron jobs: {at: epochMs} —
        // written back through the agent's own CLI, so their scheduler stays
        // the source of truth
        const body = await readBody(req)
        const id = decodeURIComponent(p.slice('/api/v1/external-jobs/'.length))
        try {
          const job = await rescheduleExternalJob(db, id, Number(body.at))
          bus.emit('schedule.moved', { data: { id, external: true, provider: job.provider, fireAt: job.next_run_at } })
          return json(res, 200, job)
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (p === '/api/v1/events') {
        const since = Number(url.searchParams.get('since')) || Date.now() - 86_400_000
        const type = url.searchParams.get('type')
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
        const rows = db.prepare(
          `SELECT * FROM events WHERE ts >= ? ${type ? 'AND type = ?' : ''} ORDER BY ts DESC LIMIT ?`
        ).all(...(type ? [since, type, limit] : [since, limit]))
        return json(res, 200, { events: rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') })) })
      }
      if (p === '/api/v1/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }
      if (p === '/api/v1/webhooks') {
        if (req.method === 'GET') return json(res, 200, { webhooks: webhooks.list() })
        if (req.method === 'POST') return json(res, 201, webhooks.create(await readBody(req)))
      }
      if (p.startsWith('/api/v1/webhooks/') && p.endsWith('/test') && req.method === 'POST') {
        const id = p.split('/')[4]
        const ok = webhooks.test(id)
        return json(res, ok ? 202 : 404, ok ? { ok: true, note: 'sample event dispatched' } : { error: 'not found' })
      }
      if (p.startsWith('/api/v1/webhooks/') && req.method === 'DELETE') {
        return json(res, webhooks.remove(p.split('/').pop()) ? 200 : 404, { ok: true })
      }
      if (p === '/api/v1/schedules') {
        if (req.method === 'GET') {
          const remote = (await federate(cfg, '/api/v1/schedules', 'schedules'))
            .map((row) => ({ ...row, account: undefined }))
          return json(res, 200, { schedules: [...scheduler.list(), ...remote] })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (body.runner) {
            // queue on the runner itself: it fires there even if this machine sleeps
            const runner = (cfg.runners ?? []).find((r) => r.name === body.runner)
            if (!runner) return json(res, 400, { error: `unknown runner "${body.runner}"` })
            const { runner: _drop, ...forward } = body
            const created = await runnerFetch(runner, '/api/v1/schedules', { method: 'POST', body: forward })
            return json(res, 201, { ...created, runner: runner.name })
          }
          return json(res, 201, scheduler.create(body))
        }
      }
      // ---- Missions: "ask your squad" ------------------------------------
      if (p === '/api/v1/missions' && req.method === 'GET') {
        return json(res, 200, { missions: missions.list() })
      }
      if (p === '/api/v1/missions/plan' && req.method === 'POST') {
        const body = await readBody(req)
        const goal = String(body?.goal ?? '').trim()
        if (!goal) return json(res, 400, { error: 'give the squad a goal' })
        try {
          const plan = await missions.plan(goal, { context: String(body?.context ?? '').slice(0, 4000) })
          return json(res, 200, { plan })
        } catch (e) {
          return json(res, 502, { error: e.message })
        }
      }
      if (p === '/api/v1/missions/plan/cancel' && req.method === 'POST') {
        return json(res, 200, { cancelled: missions.cancelPlan() })
      }
      if (p === '/api/v1/missions' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          return json(res, 201, missions.apply(body?.plan ?? body, { cloud: !!body?.cloud }))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (/^\/api\/v1\/missions\/[\w-]+\/archive$/.test(p) && req.method === 'POST') {
        const m = missions.archive(p.split('/')[4])
        return m ? json(res, 200, m) : json(res, 404, { error: 'no such mission' })
      }
      // ---- HQ: roles (the employee roster) -------------------------------
      if (p === '/api/v1/roles') {
        if (req.method === 'GET') {
          return json(res, 200, {
            roles: hq.listRoles().map((r) => ({ ...r, weekSpend: hq.weekSpend(r.id) })),
          })
        }
        if (req.method === 'POST') return json(res, 201, hq.createRole(await readBody(req)))
      }
      if (/^\/api\/v1\/roles\/[\w-]+$/.test(p)) {
        const id = p.split('/')[4]
        if (req.method === 'GET') {
          const role = hq.getRole(id)
          return role ? json(res, 200, { ...role, weekSpend: hq.weekSpend(id) }) : json(res, 404, { error: 'not found' })
        }
        if (req.method === 'PATCH') {
          const updated = hq.updateRole(id, await readBody(req))
          return updated ? json(res, 200, updated) : json(res, 404, { error: 'not found' })
        }
        if (req.method === 'DELETE') {
          return json(res, hq.deleteRole(id) ? 200 : 404, { ok: true })
        }
      }
      if (/^\/api\/v1\/roles\/[\w-]+\/notes$/.test(p) && req.method === 'PUT') {
        const body = await readBody(req)
        const updated = hq.setNotes(p.split('/')[4], body.notes ?? '')
        return updated ? json(res, 200, updated) : json(res, 404, { error: 'not found' })
      }
      if (/^\/api\/v1\/roles\/[\w-]+\/report$/.test(p) && req.method === 'GET') {
        // the employee's performance record: what it did, what it cost, and
        // the honest failure signal (a no_changes streak = quiet failure)
        const id = p.split('/')[4]
        const role = hq.getRole(id)
        if (!role) return json(res, 404, { error: 'not found' })
        const runs = db.prepare(
          "SELECT status, fired_at, result FROM schedules WHERE role_id = ? AND fired_at IS NOT NULL ORDER BY fired_at DESC LIMIT 100"
        ).all(id)
        const outcomes = {}
        let cost = 0, changedRuns = 0, files = 0, ins = 0, del = 0, asks = 0
        let streak = 0, streakOpen = true
        for (const r of runs) {
          let a = {}
          try { a = JSON.parse(r.result) ?? {} } catch {}
          const outcome = a.outcome ?? (r.status === 'error' ? 'failed' : 'done')
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
          cost += Number(a.costUsd) || 0
          if (a.diff) { files += a.diff.files || 0; ins += a.diff.insertions || 0; del += a.diff.deletions || 0 }
          if (outcome === 'changed') changedRuns++
          if (a.denials?.length) asks += a.denials.length
          if (streakOpen && outcome === 'no_changes') streak++
          else streakOpen = false
        }
        return json(res, 200, {
          role: { id: role.id, name: role.name, status: role.status, agent: role.agent },
          runs: runs.length, outcomes,
          costUsd: Number(cost.toFixed(4)),
          costPerChange: changedRuns ? Number((cost / changedRuns).toFixed(4)) : null,
          diff: { files, insertions: ins, deletions: del },
          denials: asks,
          noChangeStreak: streak,
          weekSpend: Number(hq.weekSpend(id).toFixed(4)),
          budgetWeekUsd: role.budget_week_usd,
        })
      }

      // ---- HQ: inbox -----------------------------------------------------
      if (p === '/api/v1/inbox' && req.method === 'GET') {
        return json(res, 200, {
          messages: hq.listMessages({ archived: url.searchParams.get('archived') === '1' }),
          unread: hq.unreadCount(),
        })
      }
      if (p === '/api/v1/inbox/read' && req.method === 'POST') {
        const body = await readBody(req)
        const n = Array.isArray(body.ids) && body.ids.length ? hq.markRead(body.ids) : hq.markAllRead()
        return json(res, 200, { ok: true, marked: n, unread: hq.unreadCount() })
      }
      if (/^\/api\/v1\/inbox\/[\w-]+\/archive$/.test(p) && req.method === 'POST') {
        return json(res, hq.archiveMessage(p.split('/')[4]) ? 200 : 404, { ok: true, unread: hq.unreadCount() })
      }

      // ---- HQ: proposals (agent-created work awaiting the human) ---------
      if (p === '/api/v1/proposals' && req.method === 'GET') {
        return json(res, 200, { proposals: hq.listProposals() })
      }
      if (/^\/api\/v1\/proposals\/[\w-]+\/approve$/.test(p) && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const row = scheduler.approveProposal(p.split('/')[4], { when: body.when ?? null })
        return row ? json(res, 200, row) : json(res, 404, { error: 'no such proposal' })
      }
      if (/^\/api\/v1\/proposals\/[\w-]+\/deny$/.test(p) && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        return json(res, scheduler.denyProposal(p.split('/')[4], body.reason) ? 200 : 404, { ok: true })
      }

      if (/^\/api\/v1\/schedules\/[\w-]+\/log$/.test(p) && req.method === 'GET') {
        // live-tails the run's log while the job is running, then ends
        const id = p.split('/')[4]
        const getSchedule = () => db.prepare('SELECT status, result FROM schedules WHERE id = ?').get(id)
        const s = getSchedule()
        if (!s) return json(res, 404, { error: 'not found' })
        let logFile = null
        try { logFile = JSON.parse(s.result)?.logFile } catch {}
        if (!logFile) return json(res, 404, { error: 'no output log — dry runs and command jobs log into the result field instead' })
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
        })
        let offset = 0
        const pump = () => {
          try {
            const size = statSync(logFile).size
            if (size > offset) {
              const fd = openSync(logFile, 'r')
              const buf = Buffer.alloc(size - offset)
              try { readSync(fd, buf, 0, buf.length, offset) } finally { closeSync(fd) }
              offset = size
              res.write(buf)
            }
          } catch {}
        }
        pump()
        if (getSchedule()?.status !== 'running') return res.end()
        const timer = setInterval(() => {
          pump()
          if (getSchedule()?.status !== 'running') {
            pump()
            clearInterval(timer)
            res.end()
          }
        }, 500)
        req.on('close', () => clearInterval(timer))
        return
      }
      if (/^\/api\/v1\/schedules\/[\w-]+\/diff$/.test(p) && req.method === 'GET') {
        // the job's real patch (checkpoint tree-to-tree diff). 404 for runs
        // predating checkpoints or non-git cwds — callers fall back to the
        // numstat summary in the result JSON
        const id = p.split('/')[4]
        const s = db.prepare('SELECT result FROM schedules WHERE id = ?').get(id)
        if (!s) return json(res, 404, { error: 'not found' })
        let r = null
        try { r = JSON.parse(s.result) } catch {}
        if (!r?.patchFile) return json(res, 404, { error: 'no patch captured for this run' })
        let patch = ''
        try { patch = readFileSync(r.patchFile, 'utf8') } catch { return json(res, 404, { error: 'patch file no longer on disk' }) }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
        return res.end(patch)
      }
      if (/^\/api\/v1\/schedules\/[\w-]+\/terminal$/.test(p) && req.method === 'POST') {
        // "just open the terminal": pops Terminal.app tailing this run's log
        if (process.platform !== 'darwin') return json(res, 400, { error: 'macOS only' })
        const id = p.split('/')[4]
        const s = db.prepare('SELECT status, result FROM schedules WHERE id = ?').get(id)
        if (!s) return json(res, 404, { error: 'not found' })
        let audit = {}
        try { audit = JSON.parse(s.result) ?? {} } catch {}
        const logFile = audit.logFile
        if (!logFile) return json(res, 404, { error: 'no output log for this job yet' })
        // tmux session (attachable, user can drive it) beats a read-only tail
        const attach = audit.tmuxSession
          ? `if tmux has-session -t ${JSON.stringify(audit.tmuxSession)} 2>/dev/null; then exec tmux attach -t ${JSON.stringify(audit.tmuxSession)}; fi\n`
          : ''
        const script = s.status === 'running'
          ? `#!/bin/zsh\nclear\n${attach}echo "agentcalendar · live output (Ctrl+C to stop watching)"\necho\ntail -n +1 -f ${JSON.stringify(logFile)}\n`
          : `#!/bin/zsh\nclear\n${attach}cat ${JSON.stringify(logFile)}\necho\necho "— job finished —"\n`
        const cmd = logFile.replace(/\.log$/, '') + '.command'
        writeFileSync(cmd, script)
        chmodSync(cmd, 0o755)
        execFile('open', [cmd], () => {})
        return json(res, 200, { ok: true })
      }
      if (p === '/api/v1/resume-terminal' && req.method === 'POST') {
        // click-to-resume: reopen ANY session — a job's (live or finished) or
        // an observed calendar session — as an interactive terminal. A live
        // mirror tmux session wins (attach = watch + take over); otherwise
        // the agent's own resume command runs in the session's cwd (claude
        // stores conversations per project dir, so cwd is load-bearing).
        if (process.platform !== 'darwin') return json(res, 400, { error: 'macOS only' })
        const body = await readBody(req)
        const provider = String(body.provider ?? 'claude')
        const sessionId = String(body.sessionId ?? '').replace(/[^\w-]/g, '')
        const cwd = typeof body.cwd === 'string' && body.cwd.startsWith('/') ? body.cwd : null
        const tmuxSession = typeof body.tmuxSession === 'string' ? body.tmuxSession.replace(/[^\w.-]/g, '') : null
        const resume = provider === 'codex' ? (sessionId ? `codex resume ${sessionId}` : 'codex resume --last')
          : provider === 'opencode' ? 'opencode --continue'
          : provider === 'hermes' ? 'hermes -c'
          : provider === 'openclaw' ? 'openclaw tui'
          : sessionId ? `claude --resume ${sessionId}` : 'claude --continue'
        const attach = tmuxSession
          ? `if tmux has-session -t ${JSON.stringify(tmuxSession)} 2>/dev/null; then exec tmux attach -t ${JSON.stringify(tmuxSession)}; fi\n`
          : ''
        const script = `#!/bin/zsh\nclear\n${attach}${cwd ? `cd ${JSON.stringify(cwd)}\n` : ''}exec ${resume}\n`
        const cmd = join(DATA_DIR, 'runs', `resume-${sessionId || 'last'}.command`)
        writeFileSync(cmd, script)
        chmodSync(cmd, 0o755)
        execFile('open', [cmd], () => {})
        return json(res, 200, { ok: true, resume })
      }
      if (p.startsWith('/api/v1/schedules/') && req.method === 'DELETE') {
        return json(res, scheduler.cancel(p.split('/').pop()) ? 200 : 404, { ok: true })
      }
      if (p.startsWith('/api/v1/schedules/') && req.method === 'PATCH') {
        const body = await readBody(req)
        const id = p.split('/').pop()
        if (!body.when && body.maxRuntimeMin == null) return json(res, 400, { error: 'when or maxRuntimeMin required' })
        let updated = null
        if (body.when) updated = scheduler.reschedule(id, body.when)
        if (body.maxRuntimeMin != null) updated = scheduler.setTimeBox(id, body.maxRuntimeMin) ?? updated
        return updated ? json(res, 200, updated) : json(res, 404, { error: 'not found or not pending' })
      }
      if (p === '/api/v1/prefs') {
        // machine-level one-time choices (banners etc.) — not per-browser
        if (req.method === 'GET') {
          const rows = db.prepare('SELECT key, value FROM prefs').all()
          return json(res, 200, Object.fromEntries(rows.map((r) => [r.key, r.value])))
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          for (const [key, value] of Object.entries(body)) {
            if (typeof key !== 'string' || key.length > 64) continue
            db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
              .run(key, String(value).slice(0, 256))
          }
          return json(res, 200, { ok: true })
        }
      }
      if (p === '/api/v1/remote-access') {
        // In-app Tailscale pairing (HQ's "Connect your phone" dialog).
        // GET = state snapshot for the dialog; POST {enable} flips it.
        const state = async () => {
          const s = await remoteStatus()
          const active = !!(s.dns && EXTRA_HOSTS.has(s.dns))
          return {
            ...s,
            active,
            url: s.dns ? `https://${s.dns}/` : null,
            pairUrl: active && s.dns ? `https://${s.dns}/?token=${TOKEN}` : null,
          }
        }
        if (req.method === 'GET') return json(res, 200, await state())
        if (req.method === 'POST') {
          const body = await readBody(req)
          try {
            if (body.enable === false) {
              const { host } = await remoteDown()
              if (host) EXTRA_HOSTS.delete(host)
              saveUserConfig({ remoteHosts: [...EXTRA_HOSTS].sort() })
            } else {
              // Serve targets the port this very request arrived on — correct
              // even when the engine hopped ports at boot.
              const { host } = await remoteUp(req.socket.localPort)
              EXTRA_HOSTS.add(host)
              saveUserConfig({ remoteHosts: [...EXTRA_HOSTS].sort() })
            }
          } catch (e) {
            return json(res, 409, { error: e.message, code: e.code ?? 'error' })
          }
          return json(res, 200, await state())
        }
      }
      if (p === '/api/v1/remote-hosts') {
        // Hostnames (tailnet MagicDNS names) allowed past the Host/Origin
        // guard. `agentcalendar pair` calls this after `tailscale serve` so
        // the phone's requests aren't rejected as DNS rebinding.
        if (req.method === 'GET') return json(res, 200, { hosts: [...EXTRA_HOSTS] })
        if (req.method === 'POST') {
          const body = await readBody(req)
          const host = String(body.host || '').toLowerCase().replace(/\.$/, '')
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) {
            return json(res, 400, { error: 'invalid hostname' })
          }
          if (body.remove) EXTRA_HOSTS.delete(host)
          else EXTRA_HOSTS.add(host)
          saveUserConfig({ remoteHosts: [...EXTRA_HOSTS].sort() })
          return json(res, 200, { hosts: [...EXTRA_HOSTS] })
        }
      }
      if (p === '/calendar.ics') {
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' })
        return res.end(buildIcs(db, cfg))
      }

      // The UI is the AgentCal HQ app; the engine itself is headless. A bare
      // GET / answers with enough to confirm a pair worked from a phone.
      if (p === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>AgentCal engine</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh;text-align:center"><div><div style="font-size:40px">▦</div><h1 style="margin:8px 0 4px;font-size:20px">AgentCal engine v${VERSION}</h1><p style="color:#666;margin:0">Running. Open the AgentCal HQ app to see your calendar.</p></div></body>`)
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 400, { error: e.message })
    }
  })
  return server
}
