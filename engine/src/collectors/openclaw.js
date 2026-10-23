import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// OpenClaw has two storage eras and we support both:
//   new (post "SQLite flip"): <root>/agents/<id>/agent/openclaw-agent.sqlite
//     (transcript_events.event_json per seq) + <root>/state/openclaw.sqlite
//     (cron_jobs with job_json/next_run_at_ms)
//   legacy (shipped <= 2026.6.x): <root>/agents/<id>/sessions/<sid>.jsonl
//     (line 1 header, then a tree of entries) + <root>/cron/jobs.json
// Heartbeat turns are excluded from activity: a 30-minute poll is not work.
export const provider = 'openclaw'
export const custom = true

const HEARTBEAT_PROMPT = '[OpenClaw heartbeat poll]'

export function available(root) {
  return existsSync(join(root, 'agents')) || existsSync(join(root, 'state'))
}

export function watchPaths(root) {
  const paths = []
  const push = (p) => existsSync(p) && paths.push(p)
  push(join(root, 'cron', 'jobs.json'))
  push(join(root, 'state', 'openclaw.sqlite-wal'))
  const agents = join(root, 'agents')
  if (existsSync(agents)) {
    for (const id of safeList(agents)) {
      push(join(agents, id, 'sessions'))
      push(join(agents, id, 'agent', 'openclaw-agent.sqlite-wal'))
    }
  }
  return paths
}

function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isHeartbeatUser(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : ''
  return text === HEARTBEAT_PROMPT || text.trimEnd().endsWith('reply HEARTBEAT_OK.')
}

function isHeartbeatAck(content) {
  const text = Array.isArray(content)
    ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ')
    : String(content ?? '')
  return text.replace(/^[*<b>\s]+/i, '').startsWith('HEARTBEAT_OK')
}

// One transcript entry object (same shape in JSONL lines and event_json rows)
// -> normalized record, or null.
function entryToRecord(entry, sessionKey, meta) {
  if (entry.type === 'session') {
    if (entry.cwd) meta.cwd = entry.cwd
    return null
  }
  if (entry.type !== 'message' || !entry.message) return null
  const msg = entry.message
  if (msg.provider === 'openclaw') return null // delivery-mirror bookkeeping rows
  if (msg.role === 'user' && isHeartbeatUser(msg.content)) {
    meta.inHeartbeat = true
    return null
  }
  if (msg.role === 'assistant' && (meta.inHeartbeat || isHeartbeatAck(msg.content))) {
    meta.inHeartbeat = false
    return null
  }
  if (msg.role === 'user') meta.inHeartbeat = false
  const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : Date.parse(entry.timestamp)
  if (!Number.isFinite(ts)) return null
  const rec = { ts, sessionKey }
  if (meta.cwd) rec.cwd = meta.cwd
  else rec.project = 'openclaw'
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim() && !msg.content.startsWith('<')) {
    rec.title = msg.content.slice(0, 120).replace(/\s+/g, ' ').trim()
  }
  if (msg.role === 'assistant') {
    if (msg.model) rec.model = msg.model
    if (msg.usage) {
      rec.tokensMode = 'add'
      rec.tokensIn = msg.usage.input ?? 0
      rec.tokensOut = msg.usage.output ?? 0
    }
  }
  return rec
}

function scanLegacyFiles(root, ctx) {
  const agents = join(root, 'agents')
  for (const agentId of safeList(agents)) {
    const dir = join(agents, agentId, 'sessions')
    for (const file of safeList(dir)) {
      // primary transcripts only: skip checkpoints, topics, archives, tmp
      if (!file.endsWith('.jsonl') || file.includes('.checkpoint.') || file.includes('-topic-') ||
          file.includes('.trajectory') || /\.jsonl\.(reset|deleted|bak)\./.test(file)) continue
      const path = join(dir, file)
      const stateKey = `f:${agentId}:${file}`
      let size
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      let offset = ctx.stateGet(stateKey)
      if (offset >= size) continue
      const fd = openSync(path, 'r')
      const buf = Buffer.alloc(size - offset)
      try {
        readSync(fd, buf, 0, buf.length, offset)
      } finally {
        closeSync(fd)
      }
      const text = buf.toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      const complete = lastNl === -1 ? '' : text.slice(0, lastNl)
      const sessionKey = basename(file, '.jsonl')
      const meta = { cwd: null, inHeartbeat: false }
      for (const line of complete.split('\n')) {
        if (!line) continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue // torn or partial line: tolerate
        }
        const rec = entryToRecord(entry, sessionKey, meta)
        if (rec) ctx.emit(rec)
      }
      if (lastNl !== -1) ctx.stateSet(stateKey, offset + Buffer.byteLength(complete) + 1)
    }
  }
}

function scanAgentDbs(root, ctx) {
  const agents = join(root, 'agents')
  for (const agentId of safeList(agents)) {
    const dbPath = join(agents, agentId, 'agent', 'openclaw-agent.sqlite')
    if (!existsSync(dbPath)) continue
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
    } catch {
      continue
    }
    try {
      const stateKey = `db:${agentId}`
      const cursor = ctx.stateGet(stateKey)
      const rows = db.prepare(
        'SELECT rowid, session_id, event_json FROM transcript_events WHERE rowid > ? ORDER BY rowid LIMIT 5000'
      ).all(cursor)
      const metaBySession = new Map()
      let last = cursor
      for (const row of rows) {
        last = row.rowid
        let entry
        try {
          entry = JSON.parse(row.event_json)
        } catch {
          continue
        }
        if (!metaBySession.has(row.session_id)) metaBySession.set(row.session_id, { cwd: null, inHeartbeat: false })
        const rec = entryToRecord(entry, row.session_id, metaBySession.get(row.session_id))
        if (rec) ctx.emit(rec)
      }
      if (last !== cursor) ctx.stateSet(stateKey, last)
    } catch {} finally {
      try { db.close() } catch {}
    }
  }
}

function mapJob(job) {
  const schedule = job.schedule ?? {}
  const kind = schedule.kind === 'at' ? 'once'
    : schedule.kind === 'every' ? 'interval'
    : schedule.kind === 'cron' ? 'cron' : schedule.kind ?? 'once'
  const detail = schedule.kind === 'cron' ? schedule.expr
    : schedule.kind === 'every' ? `every ${Math.round((schedule.everyMs ?? 0) / 60000)}m`
    : schedule.kind === 'at' ? 'once' : ''
  return {
    jobId: job.id,
    name: job.name || 'openclaw job',
    kind,
    detail,
    nextRunAt: job.state?.nextRunAtMs ?? (schedule.at ? Date.parse(schedule.at) : null),
    lastRunAt: job.state?.lastRunAtMs ?? null,
    state: job.enabled === false ? 'paused' : 'scheduled',
    enabled: job.enabled !== false,
  }
}

function collectJobs(root) {
  // new era first: shared state DB
  const statePath = join(root, 'state', 'openclaw.sqlite')
  if (existsSync(statePath)) {
    try {
      const db = new DatabaseSync(statePath, { readOnly: true })
      try {
        const rows = db.prepare('SELECT job_json, next_run_at_ms, enabled FROM cron_jobs').all()
        return rows.map((row) => {
          const job = JSON.parse(row.job_json)
          const mapped = mapJob(job)
          if (row.next_run_at_ms != null) mapped.nextRunAt = row.next_run_at_ms
          mapped.enabled = row.enabled !== 0
          if (!mapped.enabled) mapped.state = 'paused'
          return mapped
        })
      } finally {
        try { db.close() } catch {}
      }
    } catch {}
  }
  try {
    const raw = JSON.parse(readFileSync(join(root, 'cron', 'jobs.json'), 'utf8'))
    return (raw.jobs ?? []).map(mapJob)
  } catch {
    return []
  }
}

export function scan(root, ctx) {
  scanLegacyFiles(root, ctx)
  scanAgentDbs(root, ctx)
  ctx.syncJobs(collectJobs(root))
  return 1
}
