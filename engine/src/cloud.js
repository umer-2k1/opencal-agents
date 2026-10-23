import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

// AgentCalendar Cloud (Pro): thin client for the control plane. The license
// key lives in ~/.agentcal/secrets.json (0600) and never reaches the browser —
// the local server proxies cloud calls so the UI stays keyless.

const API = process.env.AGENTCAL_API || 'https://agentcal-api.milindsoni201.workers.dev'
const SECRETS = join(DATA_DIR, 'secrets.json')

function secrets() {
  try {
    return JSON.parse(readFileSync(SECRETS, 'utf8'))
  } catch {
    return {}
  }
}

export function proKey() {
  return secrets().proKey ?? null
}

export function clearKey() {
  const { proKey, proEmail, savedAt, ...rest } = secrets()
  writeFileSync(SECRETS, JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 })
}

export function saveKey(key, email) {
  mkdirSync(DATA_DIR, { recursive: true })
  const next = { ...secrets(), proKey: key, proEmail: email ?? null, savedAt: new Date().toISOString() }
  writeFileSync(SECRETS, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

// validate a candidate key against the control plane WITHOUT touching the
// stored one; returns the /v1/me payload on success, throws on a bad key
export async function verifyKey(key) {
  const res = await fetch(`${API}/v1/me`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `cloud API: HTTP ${res.status}`)
  return data
}

export async function cloudFetch(path, options = {}) {
  const key = proKey()
  if (!key) throw new Error('not logged in — run: agentcalendar login <ACAL-… key>')
  const attempt = () => fetch(API + path, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  })
  let res
  try {
    res = await attempt()
  } catch {
    // transient local network blip (undici "fetch failed") — one quick retry
    // so a button click doesn't surface a meaningless error
    await new Promise((r) => setTimeout(r, 800))
    res = await attempt()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `cloud API: HTTP ${res.status}`)
  return data
}

export const cloudMe = () => cloudFetch('/v1/me', { timeoutMs: 15_000 })

// ---- account sign-in (Better Auth device flow) ----
// The app shows a short code, the browser approves it, and the resulting
// session token is stored exactly where a license key would be — every
// cloudFetch after that rides the same bearer pipe.
export async function deviceStart() {
  const res = await fetch(`${API}/v1/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'agentcal-app' }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error_description || data.message || data.error || `sign-in unavailable (HTTP ${res.status})`)
  return data
}

/** One poll tick: session token string when approved, null while pending, throws on denial/expiry. */
export async function devicePoll(deviceCode) {
  const res = await fetch(`${API}/v1/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'agentcal-app',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok && (data.access_token || data.token)) return data.access_token ?? data.token
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return null
  throw new Error(data.error_description || data.error || 'sign-in failed')
}
// provisioning includes a VM boot + waiting for the runner to dial in and
// accept the job over hub RPC; give it room
export const provisionVm = (body) => cloudFetch('/v1/vm/provision', { method: 'POST', body, timeoutMs: 240_000 })
export const stopVm = (vmId) => cloudFetch(`/v1/vm/${vmId}/stop`, { method: 'POST', timeoutMs: 30_000 })
// MachineHub event catch-up: everything the machine logged after `afterSeq`
export const machineEvents = (machineId, afterSeq = 0) =>
  cloudFetch(`/v1/machines/${machineId}/events?after_seq=${afterSeq}`, { timeoutMs: 15_000 })
// control call to the machine's runner (worker → DO → host, 30s hub timeout)
export const machineRpc = (machineId, method, params) =>
  cloudFetch(`/v1/machines/${machineId}/rpc`, { method: 'POST', body: { method, params }, timeoutMs: 45_000 })
