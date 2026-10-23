import { randomUUID } from 'node:crypto'

// Instance heartbeat: several agentcal processes can share one SQLite db —
// deliberately (extra ports, BYO scratch copies) or by accident (a launchd
// daemon still running an OLD global npm build next to a fresh npx run: jobs
// won't double-fire thanks to atomic claiming, but the stale build quietly
// wins races and "cloud runner did not come online" ensues). Each process
// writes a heartbeat row; the UI warns when more than one is alive, and
// LOUDLY when their versions differ.

const BEAT_MS = 20_000
const LIVE_MS = 70_000 // a peer missing ~3 beats is gone

export function startInstanceHeartbeat(db, { port, version }) {
  const id = randomUUID()
  const exe = process.argv[1] ?? ''
  db.prepare(
    `INSERT INTO instances (id, pid, port, version, exe, started_at, beat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, process.pid, port ?? null, String(version ?? ''), exe, Date.now(), Date.now())

  const beat = db.prepare('UPDATE instances SET beat_at = ?, port = ? WHERE id = ?')
  const prune = db.prepare('DELETE FROM instances WHERE beat_at < ?')
  const timer = setInterval(() => {
    try {
      beat.run(Date.now(), port ?? null, id)
      prune.run(Date.now() - 10 * 60_000) // crashed processes leave rows; sweep them
    } catch {}
  }, BEAT_MS)
  timer.unref?.()

  const remove = () => { try { db.prepare('DELETE FROM instances WHERE id = ?').run(id) } catch {} }
  process.on('exit', remove)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { remove(); process.exit(0) })
  }

  return {
    id,
    setPort(p) { port = p },
    peers() { return livePeers(db, id) },
    stop() { clearInterval(timer); remove() },
  }
}

export function livePeers(db, selfId) {
  try {
    return db.prepare('SELECT id, pid, port, version, exe, started_at, beat_at FROM instances WHERE beat_at >= ? AND id != ?')
      .all(Date.now() - LIVE_MS, selfId ?? '')
  } catch {
    return []
  }
}
