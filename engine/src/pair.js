// Tailscale remote access — put this machine's engine on the user's tailnet
// so a phone (and later the mobile app) can reach it from anywhere.
//
// Mechanics: `tailscale serve` publishes the loopback engine over the
// tailnet as https://<machine>.<tailnet>.ts.net (WireGuard-encrypted,
// tailnet-only, real TLS cert — no ports opened to the internet). The
// engine's DNS-rebinding guard is then told to accept that hostname.
//
// Two consumers: `agentcalendar pair [--off]` (CLI, prints a QR) and the
// engine's /api/v1/remote-access endpoint (HQ's in-app pairing dialog).
// The lib functions use async execFile so the engine event loop never
// blocks — `tailscale serve` can take up to a minute minting its first
// ACME cert.
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR } from './config.js'
import qrcode from './vendor/qrcode.js'

const pExecFile = promisify(execFile)
const SERVE_PORT = 443

// The macOS GUI app doesn't put `tailscale` on PATH; check its bundle too.
const TAILSCALE_BINS = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

export function findTailscale() {
  for (const bin of TAILSCALE_BINS) {
    try {
      execFileSync(bin, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
      return bin
    } catch {}
  }
  return null
}

const fail = (code, message) => Object.assign(new Error(message), { code })

// One snapshot of everything the pairing UI needs to render its state.
export async function remoteStatus() {
  const bin = findTailscale()
  if (!bin) return { installed: false, state: 'NotInstalled', dns: null, certsEnabled: false }
  try {
    const { stdout } = await pExecFile(bin, ['status', '--json'], { timeout: 5000 })
    const s = JSON.parse(stdout)
    return {
      installed: true,
      state: s.BackendState || 'Unknown',
      dns: String(s.Self?.DNSName || '').replace(/\.$/, '') || null,
      certsEnabled: (s.CertDomains || []).length > 0,
    }
  } catch {
    return { installed: true, state: 'Unreachable', dns: null, certsEnabled: false }
  }
}

// Publish the engine over the tailnet. Resolves {host} or throws a friendly
// error with a .code the UI can branch on: not-installed | needs-login |
// no-certs | serve-failed.
export async function remoteUp(enginePort) {
  const s = await remoteStatus()
  if (!s.installed) {
    throw fail('not-installed', 'Tailscale is not installed — get it at https://tailscale.com/download')
  }
  if (s.state !== 'Running' || !s.dns) {
    throw fail('needs-login', `Tailscale is ${s.state} — open the Tailscale app and sign in first.`)
  }
  // Without the HTTPS-certificates feature, `tailscale serve` silently blocks
  // forever waiting for a cert it can never get — catch it up front.
  if (!s.certsEnabled) {
    throw fail(
      'no-certs',
      'Your tailnet does not have HTTPS certificates enabled (one-time setup): open https://login.tailscale.com/admin/dns and under "HTTPS Certificates" click "Enable HTTPS", then retry.'
    )
  }
  const bin = findTailscale()
  try {
    // First run after enabling HTTPS mints a TLS cert via ACME — allow a minute.
    await pExecFile(bin, ['serve', '--bg', `--https=${SERVE_PORT}`, `http://127.0.0.1:${enginePort}`], {
      timeout: 60_000,
    })
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message).trim()
    const hint = /access denied|permission|operator/i.test(msg)
      ? ' Fix: sudo tailscale set --operator="$USER"'
      : ''
    throw fail('serve-failed', `tailscale serve failed: ${msg}${hint}`)
  }
  return { host: s.dns }
}

// Tear the mapping down. Resolves {host} (null if tailscale is gone).
export async function remoteDown() {
  const s = await remoteStatus()
  const bin = findTailscale()
  if (bin) {
    try {
      await pExecFile(bin, ['serve', `--https=${SERVE_PORT}`, 'off'], { timeout: 10_000 })
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message).trim()
      if (!/handler does not exist/i.test(msg)) throw fail('serve-failed', `tailscale serve off failed: ${msg}`)
    }
  }
  return { host: s.dns }
}

async function findEngine(basePort) {
  for (let port = basePort; port < basePort + 10; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(1500) })
      if (res.ok && (await res.json()).name === 'agentcal') return port
    } catch {}
  }
  return null
}

// Terminal QR via half-blocks, light modules drawn as blocks (reads on the
// dark terminals most people run; phone cameras handle the inversion).
function asciiQr(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const QUIET = 2
  const light = (r, c) => {
    if (r < -QUIET || r >= n + QUIET || c < -QUIET || c >= n + QUIET) return false
    if (r < 0 || r >= n || c < 0 || c >= n) return true // quiet zone
    return !qr.isDark(r, c)
  }
  const lines = []
  for (let r = -QUIET; r < n + QUIET; r += 2) {
    let line = ''
    for (let c = -QUIET; c < n + QUIET; c++) {
      const top = light(r, c)
      const bot = light(r + 1, c)
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

async function engineCall(port, token, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acal-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function runPair({ off = false, basePort = 4747 }) {
  const port = await findEngine(basePort)
  const token = (() => {
    try { return readFileSync(join(DATA_DIR, 'token'), 'utf8').trim() } catch { return null }
  })()

  if (off) {
    let host = null
    try {
      host = (await remoteDown()).host
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
    if (port && token && host) {
      await engineCall(port, token, '/api/v1/remote-hosts', { host, remove: true }).catch(() => {})
    }
    console.log(`✓ Remote access off${host ? ` — https://${host} no longer serves AgentCal.` : '.'}`)
    process.exit(0)
  }

  if (!port) {
    console.error('No running AgentCal engine found — open AgentCal HQ (or run `agentcalendar`) first.')
    process.exit(1)
  }
  if (!token) {
    console.error(`No auth token at ${join(DATA_DIR, 'token')} — start the engine once first.`)
    process.exit(1)
  }

  let host
  try {
    host = (await remoteUp(port)).host
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  // Let the engine's Host guard accept the tailnet hostname (persists to
  // ~/.agentcal/config.json so it survives restarts).
  await engineCall(port, token, '/api/v1/remote-hosts', { host })

  // The QR is the pairing credential: engine URL + auth token in one scan
  // (what the mobile app consumes; also works for curl / any API client).
  const url = `https://${host}/?token=${token}`
  console.log('')
  console.log(asciiQr(url))
  console.log('')
  console.log(`  ✓ Your AgentCal engine is on your tailnet: https://${host}/`)
  console.log('')
  console.log('  Any device signed into the same Tailscale account can reach it —')
  console.log('  nothing is exposed to the public internet. The QR carries the URL')
  console.log('  plus this machine\'s auth token for the AgentCal app to pair with.')
  console.log('')
  console.log(`  API from another device:  curl -H "x-acal-token: ${token.slice(0, 8)}…" https://${host}/api/v1/status`)
  console.log('  Turn off anytime:         agentcalendar pair --off')
  process.exit(0)
}
