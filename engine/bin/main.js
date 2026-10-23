import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import { createBus } from '../src/bus.js'
import { createCollectors } from '../src/collectors/index.js'
import { startWindowTracker } from '../src/windows.js'
import { startClaudePoller } from '../src/limits.js'
import { createWebhooks } from '../src/webhooks.js'
import { createScheduler } from '../src/schedules.js'
import { createHq } from '../src/hq.js'
import { createMissions } from '../src/missions.js'
import { createApi } from '../src/server.js'
import { startInstanceHeartbeat } from '../src/instances.js'
import { startUplink } from '../src/uplink.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt
}

// internal: MCP permission proxy for headless runs (the claude CLI spawns
// `agentcalendar permission-proxy <socket>` as an MCP server; see the driver).
// stdout is the MCP protocol channel — nothing may log before this dispatch.
if (args[0] === 'permission-proxy') {
  if (!args[1]) {
    console.error('usage: agentcalendar permission-proxy <socket>')
    process.exit(1)
  }
  const { runPermissionProxy } = await import('../src/drivers/claude.js')
  runPermissionProxy(args[1])
  await new Promise(() => {}) // serves until the CLI closes stdin
}

if (args[0] === 'login') {
  const key = args[1]
  if (!key) {
    console.error('usage: agentcalendar login <ACAL-… license key>\nGet one at https://agentcalendar.dev/pricing')
    process.exit(1)
  }
  const { saveKey } = await import('../src/cloud.js')
  const api = process.env.AGENTCAL_API || 'https://agentcal-api.milindsoni201.workers.dev'
  try {
    const res = await fetch(`${api}/v1/me`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    const me = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error(`login failed: ${me.error || `HTTP ${res.status}`}`)
      process.exit(1)
    }
    saveKey(key, me.email)
    console.log(`✓ logged in as ${me.email ?? 'pro user'} (${me.plan})`)
    console.log(`  cloud hours: ${me.usage.usedHours} / ${me.usage.includedHours} used this cycle`)
    console.log('  "☁ AgentCal Cloud" is now available in the Run-on picker.')
  } catch (e) {
    console.error(`login failed: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

// internal: live-view a cloud job's mirror file (the runner opens tmux
// windows running `agentcalendar render <file>`); not user-facing
if (args[0] === 'render') {
  const { renderJobFile } = await import('../src/runner/acal-runner.js')
  if (!args[1]) {
    console.error('usage: agentcalendar render <job ndjson file>')
    process.exit(1)
  }
  renderJobFile(args[1])
  await new Promise(() => {}) // exits from inside the renderer on job end
}

// BYO runner: turn this box into a cloud-dispatchable machine. It registers
// with the control plane once (idempotent by name) and dials OUT to the
// MachineHub — works behind NAT, no inbound ports. Jobs arrive over RPC and
// run with THIS box's own agent logins; credentials never leave the machine.
if (args[0] === 'runner') {
  const { proKey } = await import('../src/cloud.js')
  const { startRunner, registerMachine } = await import('../src/runner/acal-runner.js')
  const { hostname } = await import('node:os')
  const key = proKey()
  if (!key) {
    console.error('runner needs a license key — run: agentcalendar login <ACAL-… key>')
    process.exit(1)
  }
  const api = process.env.AGENTCAL_API || 'https://agentcal-api.milindsoni201.workers.dev'
  const name = opt('--name', hostname())
  try {
    const m = await registerMachine({ api, proKey: key, name, kind: 'byo' })
    console.log(`▦ agentcalendar runner "${name}" ${m.reused ? 'reconnecting' : 'registered'} (machine ${m.machineId.slice(0, 8)})`)
    startRunner({
      api, machineId: m.machineId, hostToken: m.hostToken,
      // opt-in job mirror: --tmux <session> opens a live job window (and
      // enables interactive take-over) inside that tmux session
      tmuxSession: opt('--tmux', null),
      onLog: (msg) => console.log(`${new Date().toISOString()} ${msg}`),
    })
  } catch (e) {
    console.error(`runner failed: ${e.message}`)
    process.exit(1)
  }
  await new Promise(() => {}) // runner runs until killed; never fall through to the server
}

// Remote access: publish the local engine over the user's tailnet so a phone
// (or any signed-in device) can reach the API from anywhere. No public
// exposure — Tailscale Serve proxies HTTPS to loopback inside the WireGuard
// mesh. Groundwork for the mobile app.
if (args[0] === 'pair') {
  const { runPair } = await import('../src/pair.js')
  const cfg = loadConfig()
  await runPair({ off: flag('--off'), basePort: cfg.port })
}

if (flag('--version') || flag('-v')) {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  console.log(pkg.version)
  process.exit(0)
}

const cfg = loadConfig()
cfg.port = Number(opt('--port', cfg.port))

const db = openDb(opt('--db'))
const bus = createBus(db)
const collectors = createCollectors(cfg, db, bus)

if (collectors.sources.length === 0 && !(cfg.runners?.length > 0)) {
  // a fresh machine is a legitimate start (new user, BYO box, cloud-only
  // use) — open with an empty calendar instead of refusing to launch
  console.warn('agentcal: no local agent sessions yet (looked in ~/.claude, ~/.codex, ~/.hermes, ~/.openclaw).')
  console.warn('agentcal: starting with an empty calendar — sessions appear as soon as an agent CLI runs here.')
}

console.log('agentcal: scanning local sessions…')
const t0 = Date.now()
const files = collectors.initialScan()
console.log(`agentcal: indexed ${files} transcript files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

collectors.startWatchers()
startWindowTracker(db, cfg, bus)
startClaudePoller(db, cfg, bus, collectors.sources)
const webhooks = createWebhooks(db, bus)
const hq = createHq(db, bus)
const scheduler = createScheduler(db, cfg, bus, hq)

// heartbeat row goes in before listen: even a process that loses the port
// race shows up as a peer for the few seconds it lives, and a daemon that
// binds elsewhere is visible from every instance sharing this db
const VERSION = await (async () => {
  try {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version
  } catch { return 'unknown' }
})()
const heartbeat = startInstanceHeartbeat(db, { port: cfg.port, version: VERSION })

const missions = createMissions({ db, bus, hq, scheduler, cfg })
const server = createApi({ db, cfg, bus, webhooks, scheduler, hq, missions, sources: collectors.sources, heartbeat })

// mobile uplink (Pro): join MachineHub as a machine so a paired phone can
// see local jobs and answer asks; payloads go up end-to-end encrypted
const uplink = startUplink({ cfg, db, bus, scheduler, onLog: (m) => console.log(`agentcal: ${m}`) })
void uplink

function banner(port) {
  const url = `http://localhost:${port}`
  console.log(`
  ▦ agentcalendar engine
    api        ${url}/api/v1/status
    live       ${url}/api/v1/stream   (SSE)
    ical feed  ${url}/calendar.ics
    ui         AgentCal HQ app — https://agentcalendar.dev
`)
}

let port = cfg.port
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err
  // is the thing on this port already us?
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(2000) })
    const who = await res.json()
    if (who?.name === 'agentcal' || who?.name === 'agentcalendar') {
      console.log(`agentcalendar is already running at http://localhost:${port}`)
      process.exit(0)
    }
  } catch {}
  if (port < cfg.port + 10) {
    port += 1
    console.log(`port ${port - 1} is busy, trying ${port}…`)
    server.listen(port, '127.0.0.1')
  } else {
    console.error(`agentcalendar: ports ${cfg.port}-${port} are all busy. Try --port <n>.`)
    process.exit(1)
  }
})
server.listen(port, '127.0.0.1', () => {
  heartbeat.setPort(port) // the port race may have moved us off cfg.port
  banner(port)
})
