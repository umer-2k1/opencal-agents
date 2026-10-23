import { windowStatus } from './windows.js'

function icsTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n')
}

function vevent(uid, start, end, summary, description = '') {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@agentcal`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    'END:VEVENT',
  ].filter(Boolean)
}

const NICE = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor' }

// Subscribable calendar: agent sessions as events, upcoming resets as events.
// Point Google/Apple Calendar at http://localhost:PORT/calendar.ics
export function buildIcs(db, cfg) {
  const since = Date.now() - 30 * 86_400_000
  const segs = db
    .prepare(
      `SELECT g.id, g.provider, g.account, g.started_at, g.ended_at, s.project, s.title
       FROM segments g JOIN sessions s ON s.id = g.session_id
       WHERE g.ended_at > ? AND g.ended_at - g.started_at >= 60000 ORDER BY g.started_at`
    )
    .all(since)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//agentcal//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:AgentCal',
  ]
  for (const g of segs) {
    const name = NICE[g.provider] ?? g.provider
    lines.push(
      ...vevent(
        `seg-${g.id}`, g.started_at, g.ended_at,
        `${name} · ${g.project ?? g.account}`,
        g.title ?? ''
      )
    )
  }
  for (const w of windowStatus(db, cfg)) {
    if (!w.nextResetAt || w.nextResetAt < Date.now()) continue
    const name = NICE[w.provider] ?? w.provider
    lines.push(
      ...vevent(
        `reset-${w.provider}-${w.account}-${w.nextResetAt}`,
        w.nextResetAt, w.nextResetAt + 5 * 60_000,
        `⚡ ${name} window resets`,
        'Estimated by AgentCal from local activity'
      )
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
