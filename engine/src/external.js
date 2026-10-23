import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Two-way sync for OTHER schedulers' jobs: OpenClaw and Hermes cron jobs are
// mirrored onto the calendar as external blocks; dragging one writes the new
// time back through the agent's own CLI (never by editing their state behind
// the daemon's back — except reading, which is how the collectors work too).

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 20_000 }, (error, out, err) => {
    if (error) {
      const detail = String(err || error.message).trim().slice(-300)
      reject(new Error(detail || `${bin} failed`))
    } else {
      resolve(String(out))
    }
  })
})

// keep the job's day/month fields, move its time-of-day to the drop point
function replaceCronTime(expr, at) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cannot rewrite schedule "${expr}"`)
  parts[0] = String(at.getMinutes())
  parts[1] = String(at.getHours())
  return parts.join(' ')
}

export async function rescheduleExternalJob(db, id, atMs) {
  const row = db.prepare('SELECT * FROM external_jobs WHERE id = ?').get(id)
  if (!row) throw new Error('unknown external job')
  if (!['openclaw', 'hermes'].includes(row.provider)) {
    throw new Error(`${row.provider} jobs are read-only here`)
  }
  const at = new Date(Number(atMs))
  if (!Number.isFinite(at.getTime())) throw new Error('bad target time')
  const jobId = String(id).split(':').slice(2).join(':')
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  if (row.provider === 'openclaw') {
    if (row.kind === 'once') {
      await run('openclaw', ['cron', 'edit', jobId, '--at', at.toISOString()])
    } else if (row.kind === 'cron') {
      const raw = await run('openclaw', ['cron', 'get', jobId, '--json'])
      let job = {}
      try { job = JSON.parse(raw) } catch {}
      const expr = job?.schedule?.expr ?? job?.schedule?.cron ?? job?.cron
        ?? (typeof job?.schedule === 'string' ? job.schedule : null)
      if (!expr) throw new Error('could not read the cron expression from OpenClaw')
      await run('openclaw', ['cron', 'edit', jobId, '--cron', replaceCronTime(expr, at), '--tz', tz])
    } else {
      throw new Error('interval jobs repeat on a duration — change that in OpenClaw itself')
    }
  } else {
    if (row.kind === 'cron') {
      let jobs = []
      try {
        jobs = JSON.parse(readFileSync(join(homedir(), '.hermes', 'cron', 'jobs.json'), 'utf8')).jobs ?? []
      } catch {}
      const expr = jobs.find((job) => job.id === jobId)?.schedule?.expr
      if (!expr) throw new Error('could not read the schedule from Hermes')
      await run('hermes', ['cron', 'edit', jobId, '--schedule', replaceCronTime(expr, at)])
    } else {
      // one-shot: hermes speaks delays, not datetimes
      const minutes = Math.max(1, Math.round((at.getTime() - Date.now()) / 60_000))
      await run('hermes', ['cron', 'edit', jobId, '--schedule', `${minutes}m`])
    }
  }
  // reflect immediately; the collector's next sweep re-reads the truth
  db.prepare('UPDATE external_jobs SET next_run_at = ?, seen_at = ? WHERE id = ?')
    .run(at.getTime(), Date.now(), id)
  return db.prepare('SELECT * FROM external_jobs WHERE id = ?').get(id)
}
