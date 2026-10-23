// Plain-language time → a schedule spec. Agents propose work in words
// ("every weekday at 9am", "tomorrow morning", "in 2 hours"), and typing a
// cron expression is a bad ask for a human too. Returns
// {type, value, natural} for the scheduler, or null if it can't tell —
// callers should refuse rather than guess a time to run something.
//
// Deliberately regex-only and zero-dep: a wrong guess about WHEN an agent
// runs is worse than asking again, so the grammar stays small and legible.

const DAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 }
const NAMED = { midnight: [0, 0], noon: [12, 0], morning: [9, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0] }

// "9am" | "9:30 pm" | "17:00" | "noon" → [h, m]
function parseTime(text) {
  if (!text) return null
  const t = text.trim().toLowerCase()
  for (const [word, hm] of Object.entries(NAMED)) if (t === word) return hm
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (h > 23 || min > 59) return null
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  return [h, min]
}

const hhmm = ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

export function parseWhen(input, from = Date.now()) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const text = raw.toLowerCase().replace(/\s+/g, ' ')
  const spec = (type, value) => ({ type, value, natural: raw })

  if (text === 'now' || text === 'right now' || text === 'immediately') {
    return spec('at', new Date(from).toISOString())
  }
  if (text === 'next reset' || text === 'at the next reset' || text === 'next_reset') {
    return spec('next_reset', 'claude')
  }
  // already a 5-field cron
  if (raw.split(/\s+/).length === 5 && /^[\d*,\-/ ]+$/.test(raw)) return spec('cron', raw)
  // already HH:MM
  if (/^\d{1,2}:\d{2}$/.test(raw)) return spec('daily', raw)

  // "in 30 minutes" / "in 2 hours" / "in 3 days"
  const rel = text.match(/^in (\d+) ?(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2][0] === 'm' ? 60_000 : rel[2][0] === 'h' ? 3_600_000 : rel[2][0] === 'w' ? 7 * 86_400_000 : 86_400_000
    return spec('at', new Date(from + n * unit).toISOString())
  }

  const timeAt = text.match(/(?:at|@) ([\d: ]+(?:am|pm)?|midnight|noon|morning|afternoon|evening|night)$/)
    ?? text.match(/\b(morning|afternoon|evening|night|midnight|noon)$/)
  const time = parseTime(timeAt?.[1]) ?? null

  // "every day at 9am" / "daily at 09:00" / "every morning"
  if (/^(every day|each day|daily|every morning|every evening|every night|every afternoon)\b/.test(text)) {
    const implied = text.match(/^every (morning|evening|night|afternoon)/)
    return spec('daily', hhmm(time ?? (implied ? NAMED[implied[1]] : [9, 0])))
  }

  // "every weekday at 8am" → cron Mon-Fri
  if (/^(every weekday|weekdays|each weekday)\b/.test(text)) {
    const [h, m] = time ?? [9, 0]
    return spec('cron', `${m} ${h} * * 1-5`)
  }

  // "every monday at 10am" / "weekly on friday" / "every week"
  const dayWord = text.match(/\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/)
  if (dayWord && /^(every|each|weekly|on)\b/.test(text)) {
    const [h, m] = time ?? [9, 0]
    return spec('cron', `${m} ${h} * * ${DAYS[dayWord[1]]}`)
  }
  if (/^(every week|weekly)\b/.test(text)) {
    const [h, m] = time ?? [9, 0]
    return spec('cron', `${m} ${h} * * 1`) // Monday, the working week's start
  }

  // "every hour" / "hourly" / "every 15 minutes"
  if (/^(every hour|hourly)$/.test(text)) return spec('cron', '0 * * * *')
  const everyN = text.match(/^every (\d+) ?(min|mins|minutes|hours|hrs)$/)
  if (everyN) {
    const n = Number(everyN[1])
    if (everyN[2].startsWith('h')) return n >= 1 && n <= 23 ? spec('cron', `0 */${n} * * *`) : null
    return n >= 1 && n <= 59 ? spec('cron', `*/${n} * * * *`) : null
  }

  // "every month" / "monthly on the 1st"
  if (/^(every month|monthly)\b/.test(text)) {
    const [h, m] = time ?? [9, 0]
    const dom = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/)
    return spec('cron', `${m} ${h} ${dom ? Number(dom[1]) : 1} * *`)
  }

  // "tomorrow at 9am" / "today at 6pm" / "tonight"
  const dayOffset = /^tomorrow\b/.test(text) ? 1 : /^(today|tonight)\b/.test(text) ? 0 : null
  if (dayOffset != null) {
    const d = new Date(from)
    d.setDate(d.getDate() + dayOffset)
    const [h, m] = time ?? (/tonight/.test(text) ? NAMED.night : [9, 0])
    d.setHours(h, m, 0, 0)
    // "today at 9am" when it's already noon means the next one, not the past
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
    return spec('at', d.toISOString())
  }

  // "next monday [at 10am]"
  if (dayWord && /^next\b/.test(text)) {
    const d = new Date(from)
    const [h, m] = time ?? [9, 0]
    const target = DAYS[dayWord[1]]
    let delta = (target - d.getDay() + 7) % 7
    if (delta === 0) delta = 7
    d.setDate(d.getDate() + delta)
    d.setHours(h, m, 0, 0)
    return spec('at', d.toISOString())
  }

  // a plain datetime the runtime understands
  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return spec('at', new Date(parsed).toISOString())

  return null
}
