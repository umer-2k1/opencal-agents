import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Vendor-confirmed limit snapshots. Two sources, both read-only:
//  - codex: rate_limits blocks the CLI persists into rollout files (no network)
//  - claude: GET api.anthropic.com/api/oauth/usage with the CLI's own OAuth
//    token, polled gently (the endpoint 429s aggressively; never write the
//    token back — the CLI owns refresh).
// Snapshots override transcript inference wherever they're fresh.

export function recordSnapshot(db, bus, snap) {
  // snap: {provider, account, kind, usedPercent, resetsAt, plan, ts}
  const last = db.prepare(
    'SELECT used_percent, resets_at FROM limit_snapshots WHERE provider = ? AND account = ? AND kind = ? ORDER BY ts DESC LIMIT 1'
  ).get(snap.provider, snap.account, snap.kind)
  if (last && last.used_percent === snap.usedPercent && last.resets_at === snap.resetsAt) return false
  db.prepare(
    'INSERT INTO limit_snapshots (ts, provider, account, kind, used_percent, resets_at, plan) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(snap.ts, snap.provider, snap.account, snap.kind, snap.usedPercent, snap.resetsAt, snap.plan ?? null)
  bus.emit('limits.updated', {
    provider: snap.provider, account: snap.account,
    data: { kind: snap.kind, usedPercent: snap.usedPercent, resetsAt: snap.resetsAt, plan: snap.plan ?? null },
  })
  return true
}

// codex token_count payload -> snapshots. Windows are bucketed by duration,
// not field position (free plans can ship weekly data in primary_window).
export function codexSnapshots(rl, ts) {
  const out = []
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue
    const resetsAt = w.resets_at != null ? w.resets_at * 1000
      : w.resets_in_seconds != null ? ts + w.resets_in_seconds * 1000 : null
    if (resetsAt == null) continue
    const kind = w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? 'weekly' : `${w.window_minutes}m`
    out.push({ kind, usedPercent: w.used_percent ?? null, resetsAt, plan: rl.plan_type ?? null, ts })
  }
  return out
}

export function latestLimits(db) {
  return db.prepare(
    `SELECT l.* FROM limit_snapshots l
     JOIN (SELECT provider, account, kind, MAX(ts) mts FROM limit_snapshots GROUP BY provider, account, kind) m
       ON l.provider = m.provider AND l.account = m.account AND l.kind = m.kind AND l.ts = m.mts
     ORDER BY l.provider, l.kind`
  ).all()
}

// ---- claude usage endpoint poller ----

function freshToken(o) {
  return o?.accessToken && (!o.expiresAt || o.expiresAt > Date.now() + 60_000) ? o.accessToken : null
}

function claudeToken(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.credentials.json'), 'utf8'))
    const t = freshToken(raw.claudeAiOauth)
    if (t) return t
  } catch {}
  // macOS: the live token is in the Keychain; the file can be a stale copy.
  // Read-only via the security CLI (one-time "Always Allow"), like ClaudeBar.
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 3000, encoding: 'utf8' })
      return freshToken(JSON.parse(raw).claudeAiOauth)
    } catch {}
  }
  return null
}

const iso = (s) => (s ? Date.parse(s) : null)

export function startClaudePoller(db, cfg, bus, sources) {
  if (cfg.claudeUsagePoll === false) return
  const roots = sources.filter((s) => s.provider === 'claude')
  let blockedUntil = 0

  async function poll() {
    if (Date.now() < blockedUntil) return
    for (const src of roots) {
      const token = claudeToken(src.root)
      if (!token) continue
      try {
        const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: {
            authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            accept: 'application/json',
            'user-agent': 'claude-code/2.1.0',
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'))
          blockedUntil = Date.now() + Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 300_000, 3_600_000)
          return
        }
        if (!res.ok) continue
        const u = await res.json()
        const ts = Date.now()
        // plan name is opportunistic — field naming varies across responses
        const plan = u.subscription_type ?? u.plan_type ?? u.plan ?? u.subscription?.plan ?? null
        const put = (kind, pct, resetsAt) => {
          if (resetsAt != null) recordSnapshot(db, bus, {
            provider: 'claude', account: src.account, kind, usedPercent: pct ?? null, resetsAt, ts, plan,
          })
        }
        put('5h', u.five_hour?.utilization, iso(u.five_hour?.resets_at))
        put('weekly', u.seven_day?.utilization, iso(u.seven_day?.resets_at))
        if (u.seven_day_opus) put('weekly:opus', u.seven_day_opus.utilization, iso(u.seven_day_opus.resets_at))
        if (u.seven_day_sonnet) put('weekly:sonnet', u.seven_day_sonnet.utilization, iso(u.seven_day_sonnet.resets_at))
        for (const l of u.limits ?? []) {
          if (l.is_active === false) continue
          const label = l.scope?.model?.display_name ?? l.group ?? l.kind
          put(`weekly:${label}`, l.percent, iso(l.resets_at))
        }
      } catch {}
    }
  }

  poll()
  setInterval(poll, 15 * 60_000).unref()
}
