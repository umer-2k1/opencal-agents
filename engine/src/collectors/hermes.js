import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Hermes Agent (Nous Research) stores everything in ~/.hermes/state.db:
//   sessions(id, source, model, started_at REAL epoch-sec, ended_at, *_tokens)
//   messages(id INTEGER rowid-ish, session_id, role, content, timestamp REAL)
// We read it read-only with a rowid cursor; no files to tail.
export const provider = 'hermes'
export const custom = true

export function available(root) {
  return existsSync(join(root, 'state.db'))
}

export function watchPaths(root) {
  // the WAL file changes on every write; watching it triggers rescans
  return [join(root, 'state.db-wal'), join(root, 'state.db')].filter(existsSync)
}

let handle = null
function open(root) {
  if (!handle) handle = new DatabaseSync(join(root, 'state.db'), { readOnly: true })
  return handle
}

// ctx: { cursor, setCursor, emit } — emit takes the same record shape the
// JSONL collectors produce; the engine handles sessions/segments/events.
export function scan(root, ctx) {
  let db
  try {
    db = open(root)
  } catch {
    return 0
  }
  const sessionMeta = new Map()
  const metaFor = (sessionId) => {
    if (!sessionMeta.has(sessionId)) {
      try {
        sessionMeta.set(sessionId, db.prepare(
          'SELECT source, model, input_tokens, output_tokens FROM sessions WHERE id = ?'
        ).get(sessionId) ?? {})
      } catch {
        sessionMeta.set(sessionId, {})
      }
    }
    return sessionMeta.get(sessionId)
  }

  let rows
  try {
    rows = db.prepare(
      'SELECT id, session_id, role, content, timestamp FROM messages WHERE id > ? ORDER BY id LIMIT 5000'
    ).all(ctx.cursor)
  } catch {
    return 0
  }
  let last = ctx.cursor
  for (const row of rows) {
    last = row.id
    const ts = Math.round(row.timestamp * 1000)
    if (!Number.isFinite(ts)) continue
    const meta = metaFor(row.session_id)
    const rec = {
      ts,
      sessionKey: row.session_id,
      model: meta.model ?? null,
      project: meta.source ? `hermes · ${meta.source}` : 'hermes',
    }
    if (row.role === 'user' && typeof row.content === 'string' && row.content.trim()) {
      rec.title = row.content.slice(0, 120).replace(/\s+/g, ' ').trim()
    }
    if (meta.input_tokens || meta.output_tokens) {
      rec.tokensMode = 'set'
      rec.tokensIn = meta.input_tokens ?? 0
      rec.tokensOut = meta.output_tokens ?? 0
    }
    ctx.emit(rec)
  }
  if (last !== ctx.cursor) ctx.setCursor(last)

  // hermes cron jobs -> external schedule blocks (read-only render).
  // one-shot jobs are agent wake-ups and self-delete after firing.
  try {
    const raw = JSON.parse(readFileSync(join(root, 'cron', 'jobs.json'), 'utf8'))
    const jobs = (Array.isArray(raw) ? raw : raw.jobs ?? []).map((job) => ({
      jobId: job.id,
      name: job.name || job.prompt?.slice(0, 60) || 'hermes job',
      kind: job.schedule?.kind ?? 'once',
      detail: job.schedule_display || job.schedule?.expr ||
        (job.schedule?.minutes ? `every ${job.schedule.minutes}m` : ''),
      nextRunAt: job.next_run_at ? Date.parse(job.next_run_at) : null,
      lastRunAt: job.last_run_at ? Date.parse(job.last_run_at) : null,
      state: job.state ?? 'scheduled',
      enabled: job.enabled !== false,
    }))
    ctx.syncJobs(jobs)
  } catch {
    ctx.syncJobs([])
  }
  return rows.length
}
