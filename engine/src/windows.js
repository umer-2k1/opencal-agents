// Rate-limit window inference. Vendors don't expose reset times via any API;
// the window model (Anthropic + OpenAI both use ~5h rolling windows that open
// at your first message) is reconstructed from observed activity. All values
// are estimates and flagged as such.

export function computeWindows(db, provider, account, windowMs, sinceDays = 14) {
  const since = Date.now() - sinceDays * 86_400_000
  const segs = db
    .prepare(
      'SELECT started_at, ended_at FROM segments WHERE provider = ? AND account = ? AND ended_at > ? ORDER BY started_at'
    )
    .all(provider, account, since)
  const windows = []
  let cur = null
  for (const seg of segs) {
    if (!cur || seg.started_at >= cur.end) {
      cur = { start: seg.started_at, end: seg.started_at + windowMs }
      windows.push(cur)
    }
    // continuous activity across a reset opens the next window immediately
    while (seg.ended_at > cur.end) {
      cur = { start: cur.end, end: cur.end + windowMs }
      windows.push(cur)
    }
  }
  return windows
}

export function windowStatus(db, cfg) {
  const now = Date.now()
  const out = []
  const accounts = db.prepare('SELECT DISTINCT provider, account FROM segments').all()
  const latest = (provider, account, kind) =>
    db.prepare(
      'SELECT ts, used_percent, resets_at, plan FROM limit_snapshots WHERE provider = ? AND account = ? AND kind = ? ORDER BY ts DESC LIMIT 1'
    ).get(provider, account, kind)

  for (const { provider, account } of accounts) {
    const windows = computeWindows(db, provider, account, cfg.windowMs)
    let current = windows.find((w) => w.start <= now && now < w.end) ?? null
    let source = 'inferred'
    let usedPercent = null
    let plan = null

    // vendor truth overrides inference while its reset is still in the future
    const v = latest(provider, account, '5h')
    if (v?.resets_at > now) {
      current = { start: v.resets_at - cfg.windowMs, end: v.resets_at }
      source = 'vendor'
      usedPercent = v.used_percent
      plan = v.plan
    } else if (v && !current) {
      // vendor window has reset and no new activity since: idle, capacity fresh
      current = null
    }

    const wk = latest(provider, account, 'weekly')
    const weekly = wk && (wk.resets_at == null || wk.resets_at > now - 86_400_000)
      ? { usedPercent: wk.used_percent, resetsAt: wk.resets_at, source: 'vendor', asOf: wk.ts }
      : null

    // per-model weekly limits (e.g. Fable/Opus) — often the binding constraint
    const modelWeeklies = db.prepare(
      `SELECT l.kind, l.used_percent, l.resets_at FROM limit_snapshots l
       JOIN (SELECT kind, MAX(ts) mts FROM limit_snapshots WHERE provider = ? AND account = ? AND kind LIKE 'weekly:%' GROUP BY kind) m
         ON l.kind = m.kind AND l.ts = m.mts
       WHERE l.provider = ? AND l.account = ? AND l.resets_at > ?`
    ).all(provider, account, provider, account, now)
      .map((r) => ({ model: r.kind.slice(7), usedPercent: r.used_percent, resetsAt: r.resets_at }))

    out.push({
      provider,
      account,
      source,
      estimated: source !== 'vendor',
      windowHours: cfg.windowHours,
      current,
      usedPercent,
      plan,
      weekly,
      modelWeeklies,
      nextResetAt: current ? current.end : null, // null = idle, capacity fresh
      recent: windows.slice(-10),
    })
  }
  return out
}

// Emits window.opened / window.reset.upcoming / window.reset as estimates change.
export function startWindowTracker(db, cfg, bus) {
  const seen = new Map() // provider:account -> {start, warned}
  const tick = () => {
    const now = Date.now()
    for (const w of windowStatus(db, cfg)) {
      const key = `${w.provider}:${w.account}`
      const prev = seen.get(key)
      if (w.current) {
        if (!prev || prev.start !== w.current.start) {
          seen.set(key, { start: w.current.start, warned: false })
          bus.emit('window.opened', {
            provider: w.provider, account: w.account,
            data: { start: w.current.start, resetAt: w.current.end, estimated: true },
          })
        } else if (!prev.warned && w.current.end - now <= 15 * 60_000) {
          prev.warned = true
          bus.emit('window.reset.upcoming', {
            provider: w.provider, account: w.account,
            data: { resetAt: w.current.end, inMinutes: Math.round((w.current.end - now) / 60_000), estimated: true },
          })
        }
      } else if (prev) {
        seen.delete(key)
        bus.emit('window.reset', {
          provider: w.provider, account: w.account,
          data: { resetAt: prev.start + cfg.windowMs, estimated: true },
        })
      }
    }
  }
  tick()
  setInterval(tick, 60_000).unref()
}
