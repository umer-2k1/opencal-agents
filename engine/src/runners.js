import { execFile } from 'node:child_process'

// BYO runners: any machine running agentcalendar. Two transports:
//   { name, url }  — direct/Tailscale:  http://host:4747
//   { name, ssh }  — tunnel every call through `ssh host curl` (no open port)
// The local instance federates runner data into its own API responses and
// proxies job creation, so a queued job fires on the runner even when this
// machine is asleep.

const CACHE_TTL = 20_000
const cache = new Map() // runnerName:path -> {ts, data}

function sshFetch(runner, path, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', runner.ssh]
    const curl = ['curl', '-s', '--max-time', '6', `http://127.0.0.1:${runner.port ?? 4747}${path}`]
    if (options.method) curl.push('-X', options.method)
    if (options.body) curl.push('-d', `'${JSON.stringify(options.body).replace(/'/g, `'\\''`)}'`)
    execFile('ssh', [...args, curl.join(' ')], { timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('bad response from runner'))
      }
    })
  })
}

async function httpFetch(runner, path, options = {}) {
  const res = await fetch(runner.url.replace(/\/$/, '') + path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error(`runner ${runner.name}: HTTP ${res.status}`)
  return res.json()
}

export function runnerFetch(runner, path, options = {}) {
  return runner.url ? httpFetch(runner, path, options) : sshFetch(runner, path, options)
}

// cached read; failures resolve to null so a dead runner never breaks the UI
export async function runnerRead(runner, path) {
  const key = `${runner.name}:${path}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data
  try {
    const data = await runnerFetch(runner, path)
    cache.set(key, { ts: Date.now(), data })
    return data
  } catch {
    cache.set(key, { ts: Date.now(), data: null })
    return null
  }
}

const tagAccount = (row, runner) => ({ ...row, account: `${row.account} @ ${runner.name}`, runner: runner.name })

export async function federate(cfg, path, key) {
  const runners = cfg.runners ?? []
  if (runners.length === 0) return []
  const results = await Promise.all(runners.map(async (runner) => {
    const data = await runnerRead(runner, path)
    return (data?.[key] ?? []).map((row) => tagAccount(row, runner))
  }))
  return results.flat()
}

export async function runnerStatuses(cfg) {
  return Promise.all((cfg.runners ?? []).map(async (runner) => {
    const status = await runnerRead(runner, '/api/v1/status')
    return {
      name: runner.name,
      transport: runner.url ? 'url' : 'ssh',
      online: Boolean(status),
      version: status?.version ?? null,
      sessions: status?.sessions ?? null,
    }
  }))
}
