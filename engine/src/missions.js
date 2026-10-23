import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import { agentModels } from './models.js'

// Missions: "ask your squad to start a mission." One prompt → Claude drafts a
// mission brief (roles + recurring shifts + one-off jobs) → the human approves
// the brief once → apply() creates everything, tagged with a mission id so the
// calendar can show a per-mission view.
//
// The planner NEVER creates anything itself — plan() returns a brief for the
// human to review, and apply() is only reachable from the local API (i.e. a
// human click). Agents proposing further work inside a mission go through the
// existing propose_job → envelope → approval path; children inherit mission_id
// through parent lineage in scheduler.create.

const AGENTS = new Set(['claude', 'codex', 'openclaw', 'hermes', 'opencode'])
const MAX_ROLES = 4
const MAX_SHIFTS_PER_ROLE = 3
const MAX_ONE_OFFS = 5

const PLAN_TIMEOUT_MS = 240_000

// The model guide is what lets the planner staff a MIXTURE of models: cheap
// fast models on high-frequency shifts, heavyweights on weekly strategy.
function modelGuide(catalog) {
  const codexList = (catalog?.codex ?? [])
    .filter((m) => m.id)
    .slice(0, 6)
    .map((m) => m.id)
    .join(', ')
  return `MODEL & AGENT GUIDE — pick the cheapest tool that does each shift well; mix freely across roles and shifts:
- agent "claude" (Claude Code CLI): the best all-rounder for agentic work — research, writing,
  coding, tool use. Models, cheapest first:
    haiku  → fast + cheap: routine sweeps, monitoring, collection, formatting, short summaries
    sonnet → balanced default: most real work (writing, editing, coding)
    opus   → deep reasoning: strategy, hard debugging, long-horizon analysis
    fable  → frontier: only the single hardest weekly planning/retro shift, if any
  Optional "effort" (low|medium|high) scales thinking time; omit for default.
- agent "codex" (OpenAI Codex CLI): a genuinely different perspective — strong for code review,
  second opinions, cross-checking claude's work, and coding. Models: ${codexList || 'gpt-5.6-sol, gpt-5.5, gpt-5.4-mini'}.
Guidance: daily high-frequency shifts should usually run haiku or a mini/cheap model; give each
role's weekly strategy or review shift a heavier model. Use codex for at least one review/second-
opinion shift when the mission involves code or high-stakes output — but don't force a mixture
where one agent honestly fits everything.`
}

function plannerPrompt(goal, context, catalog) {
  const today = new Date().toISOString().slice(0, 10)
  return `You are the chief of staff for a small workforce of AI agents that run on a calendar.
Today is ${today}. The user wants to start a mission. Draft the smallest team and schedule
that credibly moves this goal every week.

THE GOAL:
${goal}

${context ? `CONTEXT (from the user's machine — real recent activity, run outcomes, and quota.
Ground the plan in it: prefer repos/cwds the user actually works in, agents and models with a
recent track record, and don't lean on a model whose weekly quota is nearly used up):
${context}
` : ''}
Rules:
- 1 to ${MAX_ROLES} standing roles. Each role is one clear job (like an employee), with a
  playbook: identity, duties, success criteria, and what to put in its reports.
- Each role gets 1 to ${MAX_SHIFTS_PER_ROLE} recurring shifts. Be conservative with cadence:
  prefer "every weekday" or 2-3x/week over hourly. Spread shift times across the day.
- Optionally up to ${MAX_ONE_OFFS} one-off kickoff jobs (research, setup) that run soon.
- Every shift prompt must be fully self-contained: restate the mission goal, the role's
  focus for that shift, concrete steps, and end with: file a short report of what you did
  and what you found (the send_message tool), and propose follow-up jobs only when a
  concrete next step emerged (the propose_job tool).
- Include one measurable metric for the mission and where to read it.
- If the goal involves a code repository the user named, set that role's cwd to it;
  otherwise omit cwd.

${modelGuide(catalog)}

First write 2-4 short progress notes — plain one-line sentences, one per line, no braces or
bullets — narrating the team as you settle it (e.g. Staffing a Researcher on haiku for the
daily sweep.). These stream live to the user while they wait. Then output the JSON object
(no markdown fences). The JSON must be the last thing you output:
{
  "name": "short mission name (max 40 chars)",
  "summary": "2-3 sentences: the strategy this team executes",
  "metric": "what success is measured by and where to read it",
  "roles": [
    {
      "name": "Role title",
      "agent": "claude",
      "cwd": "/abs/path or omit",
      "playbook": "identity, duties, success criteria, reporting format",
      "shifts": [
        { "name": "shift name", "when": { "type": "daily", "value": "09:00" }, "model": "haiku", "effort": "low", "prompt": "full self-contained instructions" }
      ]
    }
  ],
  "oneOff": [
    { "name": "kickoff job name", "role": "Role title", "inMinutes": 10, "model": "sonnet", "prompt": "full instructions" }
  ]
}
"model" and "effort" are optional per shift/one-off (omit for the agent's default).
when.type is "daily" (value "HH:MM" 24h) or "cron" (value is a 5-field cron expression, use for weekday/weekly cadence e.g. "0 9 * * 1-5").`
}

// Repair-parse an incomplete JSON stream into whatever object it holds so
// far (Vercel streamObject's trick, ~40 lines): close open strings/brackets,
// drop trailing commas, and when a dangling fragment still breaks the parse,
// trim back to the last comma and try again. Returns null until parseable.
function parsePartialJson(buf) {
  let s = String(buf ?? '').trim()
  for (let attempt = 0; attempt < 4 && s.length > 1; attempt++) {
    let inStr = false
    let esc = false
    const closers = []
    for (const ch of s) {
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') closers.push('}')
      else if (ch === '[') closers.push(']')
      else if (ch === '}' || ch === ']') closers.pop()
    }
    const candidate = (s + (inStr ? '"' : '') + closers.reverse().join(''))
      .replace(/,(\s*[}\]])/g, '$1')
    try {
      return JSON.parse(candidate)
    } catch {}
    const cut = s.lastIndexOf(',')
    if (cut === -1) return null
    s = s.slice(0, cut)
  }
  return null
}

// The planner narrates before the JSON, so parsing starts at each '{' in turn
// until one yields a valid object — a brace in the narration can't break it.
function extractJson(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/g, '')
  const end = cleaned.lastIndexOf('}')
  let start = cleaned.indexOf('{')
  while (start !== -1 && start < end) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {}
    start = cleaned.indexOf('{', start + 1)
  }
  throw new Error('the planner returned no JSON')
}

const isDaily = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v ?? ''))
const isCron = (v) => String(v ?? '').trim().split(/\s+/).length === 5

// Model/effort pass through only when they exist in the agent's real catalog —
// a hallucinated model name silently falls back to the agent's default.
function checkedModel(agent, model, effort, catalog) {
  if (!catalog) {
    return {
      model: typeof model === 'string' && model.length <= 40 ? model : undefined,
      effort: typeof effort === 'string' && effort.length <= 10 ? effort : undefined,
    }
  }
  const list = catalog[agent] ?? []
  const entry = list.find((m) => m.id && m.id === model)
  const okEffort = entry?.efforts?.includes(effort) ? effort : undefined
  return { model: entry?.id, effort: entry ? okEffort : undefined }
}

export function sanitizePlan(raw, goal, catalog = null) {
  const plan = {
    goal: String(goal).slice(0, 2000),
    name: String(raw?.name ?? 'Mission').slice(0, 40),
    summary: String(raw?.summary ?? '').slice(0, 600),
    metric: String(raw?.metric ?? '').slice(0, 300),
    roles: [],
    oneOff: [],
  }
  for (const r of (Array.isArray(raw?.roles) ? raw.roles : []).slice(0, MAX_ROLES)) {
    const role = {
      name: String(r?.name ?? '').slice(0, 60).trim(),
      agent: AGENTS.has(r?.agent) ? r.agent : 'claude',
      cwd: typeof r?.cwd === 'string' && r.cwd.startsWith('/') ? r.cwd : null,
      playbook: String(r?.playbook ?? '').slice(0, 4000),
      shifts: [],
    }
    if (!role.name) continue
    for (const s of (Array.isArray(r?.shifts) ? r.shifts : []).slice(0, MAX_SHIFTS_PER_ROLE)) {
      const type = s?.when?.type
      const value = s?.when?.value
      const ok = (type === 'daily' && isDaily(value)) || (type === 'cron' && isCron(value))
      if (!ok || !s?.prompt) continue
      role.shifts.push({
        name: String(s.name ?? role.name).slice(0, 60),
        when: { type, value: String(value).trim() },
        prompt: String(s.prompt).slice(0, 6000),
        ...checkedModel(role.agent, s.model, s.effort, catalog),
      })
    }
    if (role.shifts.length) plan.roles.push(role)
  }
  for (const j of (Array.isArray(raw?.oneOff) ? raw.oneOff : []).slice(0, MAX_ONE_OFFS)) {
    if (!j?.prompt) continue
    plan.oneOff.push({
      name: String(j.name ?? 'Kickoff').slice(0, 60),
      role: String(j.role ?? '').slice(0, 60),
      inMinutes: Math.min(24 * 60, Math.max(2, Number(j.inMinutes) || 10)),
      prompt: String(j.prompt).slice(0, 6000),
      ...checkedModel('claude', j.model, j.effort, catalog),
    })
  }
  if (!plan.roles.length) throw new Error('the planner produced no usable roles — try rephrasing the goal')
  return plan
}

export function createMissions({ db, bus, hq, scheduler, cfg = null }) {
  const catalog = () => {
    try {
      return cfg ? agentModels(cfg) : null
    } catch {
      return null
    }
  }

  // What the planner knows about this machine when the caller sends no
  // context of their own: the most recent real sessions per agent CLI (the
  // collectors already ingest claude/codex/hermes/openclaw/opencode), recent
  // scheduled-run outcomes, and current quota headroom. Read-only, local,
  // and capped well under the 4000-char context budget.
  function planContext() {
    const ago = (ts, future = false) => {
      if (!ts) return ''
      const d = Math.abs(future ? ts - Date.now() : Date.now() - ts)
      const h = Math.round(d / 3600_000)
      const label = h < 1 ? `${Math.max(1, Math.round(d / 60_000))}m` : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
      return future ? `in ${label}` : `${label} ago`
    }
    const out = []
    try {
      const rows = db.prepare(
        'SELECT provider, title, cwd, model, input_tokens, output_tokens, last_at FROM sessions ORDER BY last_at DESC LIMIT 120'
      ).all()
      const byProv = new Map()
      for (const r of rows) {
        const list = byProv.get(r.provider) ?? []
        if (list.length < 8) byProv.set(r.provider, [...list, r])
      }
      if (byProv.size) {
        out.push('RECENT AGENT SESSIONS (newest first):')
        for (const list of byProv.values()) {
          for (const r of list) {
            const tok = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
            const title = String(r.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 56)
            out.push(
              `- ${r.provider}: ${title ? `"${title}"` : '(untitled)'}` +
              `${r.cwd ? ` in ${r.cwd}` : ''}${r.model ? ` · ${r.model}` : ''}` +
              `${tok >= 1000 ? ` · ${Math.round(tok / 1000)}k tok` : ''} · ${ago(r.last_at)}`
            )
          }
        }
      }
    } catch {}
    try {
      const runs = db.prepare(
        "SELECT name, fired_at, result FROM schedules WHERE fired_at IS NOT NULL AND action_type = 'claude' ORDER BY fired_at DESC LIMIT 12"
      ).all()
      const lines = []
      for (const r of runs) {
        let a = null
        try { a = JSON.parse(r.result) } catch {}
        if (!a?.outcome) continue
        lines.push(
          `- "${String(r.name ?? a.autoTitle ?? 'job').slice(0, 48)}" (${a.agent ?? 'claude'}${a.model ? ` ${a.model}` : ''}): ` +
          `${a.outcome}${typeof a.costUsd === 'number' ? ` · $${a.costUsd.toFixed(2)}${a.costEstimated ? ' est' : ''}` : ''} · ${ago(r.fired_at)}`
        )
      }
      if (lines.length) out.push('', 'RECENT SCHEDULED RUNS (what worked and what it cost):', ...lines)
    } catch {}
    try {
      // latest snapshot per provider/account/kind — SQLite's bare-column-with-
      // MAX(ts) picks the newest row of each group
      const snaps = db.prepare(
        'SELECT provider, kind, used_percent, resets_at, MAX(ts) AS ts FROM limit_snapshots WHERE ts > ? GROUP BY provider, account, kind'
      ).all(Date.now() - 48 * 3600_000)
      const lines = snaps
        .filter((s) => s.used_percent != null)
        .map((s) => `- ${s.provider} ${s.kind}: ${Math.round(s.used_percent)}% used${s.resets_at ? `, resets ${ago(s.resets_at, true)}` : ''}`)
      if (lines.length) out.push('', 'QUOTA RIGHT NOW:', ...lines)
    } catch {}
    return out.join('\n').slice(0, 3800)
  }

  let activePlan = null // { child, cancelled } — one planner at a time is plenty

  function plan(goal, { context = '', model = null } = {}) {
    const cat = catalog()
    const ctx = String(context ?? '').trim() || planContext()
    const args = [
      '-p', plannerPrompt(goal, ctx, cat),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ]
    if (model) args.push('--model', model)
    return new Promise((resolvePlan, reject) => {
      // stream-json + partial messages: the planner's narration lines fan out
      // on the bus as mission.plan.progress while it works (the home view
      // renders them live); the final `result` event carries the full text
      // the JSON is extracted from.
      const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      try { activePlan?.child.kill('SIGTERM') } catch {}
      const me = { child, cancelled: false }
      activePlan = me
      bus?.emit('mission.plan.started', { data: { goal: goal.slice(0, 200) } })
      // instant first line — the model thinks for most of the run before it
      // writes anything, and an empty feed for a minute reads as "stuck"
      bus?.emit('mission.plan.progress', {
        data: { line: 'Reading your recent sessions, run history, and quota…' },
      })

      let settled = false
      const settle = (fn, arg) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (activePlan === me) activePlan = null
        fn(arg)
      }
      const fail = (msg) => {
        bus?.emit('mission.plan.failed', { data: { error: String(msg).slice(0, 200) } })
        settle(reject, new Error(msg))
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        fail('planner timed out — try again or simplify the goal')
      }, PLAN_TIMEOUT_MS)

      const emitProgress = (data) => bus?.emit('mission.plan.progress', { data })

      // The whole 90-130s run stays alive with honest signals only (the same
      // contract as Claude Code's own spinner): stage lines fire on REAL
      // stream transitions, the token ticker rides system/thinking_tokens
      // (thinking TEXT never streams headless — display is omitted — but the
      // CLI heartbeats a token estimate every ~1.3s), and once the JSON tail
      // starts the buffer is repair-parsed so the roster assembles live.
      let announcedThinking = false
      let lastTick = 0
      const thinkTick = (tokens) => {
        const now = Date.now()
        if (now - lastTick < 2500) return
        lastTick = now
        emitProgress({ thinking: tokens })
      }

      let lineBuf = ''
      let jsonStarted = false
      let jsonBuf = ''
      let lastDraftKey = ''
      let lastDraftAt = 0
      const draftTick = () => {
        const now = Date.now()
        if (now - lastDraftAt < 1500) return
        lastDraftAt = now
        const raw = parsePartialJson(jsonBuf)
        if (!raw || typeof raw !== 'object') return
        const draft = {
          name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : undefined,
          roles: (Array.isArray(raw.roles) ? raw.roles : [])
            .slice(0, MAX_ROLES)
            .map((r) => ({
              name: String(r?.name ?? '').slice(0, 60),
              agent: typeof r?.agent === 'string' ? r.agent : undefined,
              shifts: Array.isArray(r?.shifts) ? r.shifts.length : 0,
            }))
            .filter((r) => r.name),
          oneOff: Array.isArray(raw.oneOff) ? raw.oneOff.length : 0,
        }
        const key = JSON.stringify(draft)
        if (key === lastDraftKey) return
        lastDraftKey = key
        emitProgress({ draft })
      }
      const startJson = (rest) => {
        jsonStarted = true
        jsonBuf = rest
        lineBuf = ''
        emitProgress({ line: 'Assembling the plan…' })
      }
      const progress = (chunk) => {
        if (jsonStarted) {
          jsonBuf += chunk
          draftTick()
          return
        }
        lineBuf += chunk
        let nl
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const lineText = lineBuf.slice(0, nl).trim()
          const rest = lineBuf.slice(nl + 1)
          lineBuf = rest
          if (lineText.startsWith('{')) return startJson(lineText + '\n' + rest)
          if (lineText) emitProgress({ line: lineText.slice(0, 200) })
        }
        if (lineBuf.trimStart().startsWith('{')) startJson(lineBuf.trimStart())
      }

      let resultText = null
      let stderr = ''
      let buf = ''
      child.stdout.on('data', (c) => {
        buf += c
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
            const tok = Number(msg.estimated_tokens) || 0
            if (tok) thinkTick(tok)
          } else if (msg.type === 'stream_event') {
            const ev = msg.event ?? {}
            if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking' && !announcedThinking) {
              announcedThinking = true
              emitProgress({ line: 'Thinking through the goal and your recent history…' })
            }
            const d = ev.delta
            if (d?.type === 'text_delta' && d.text) progress(d.text)
          } else if (msg.type === 'result') {
            resultText = msg.result ?? null
          }
        }
      })
      child.stderr.on('data', (c) => {
        stderr += c
        if (stderr.length > 4096) stderr = stderr.slice(-4096)
      })
      child.on('error', (e) => {
        fail(/ENOENT/.test(e.message)
          ? 'planner failed: Claude Code is not installed — install it and sign in, then retry'
          : `planner failed: ${e.message.slice(0, 200)}`)
      })
      child.on('close', () => {
        if (settled) return
        if (me.cancelled) return fail('planning cancelled')
        try {
          if (resultText == null) throw new Error(stderr.trim().slice(-200) || 'planner exited without a result')
          const p = sanitizePlan(extractJson(resultText), goal, cat)
          bus?.emit('mission.plan.done', { data: { name: p.name, roles: p.roles.length } })
          settle(resolvePlan, p)
        } catch (e) {
          // when extraction failed, the "result" is usually the CLI's own
          // error prose — showing its head beats a generic no-JSON message
          const hint = resultText && !/^\s*\{/.test(resultText) ? ` — ${resultText.trim().slice(0, 140)}` : ''
          fail(`planner failed: ${e.message.slice(0, 200)}${hint}`)
        }
      })
    })
  }

  // Cancel button on the home view: kill the active planner child; its close
  // handler rejects the pending plan() promise with "planning cancelled".
  function cancelPlan() {
    if (!activePlan) return false
    activePlan.cancelled = true
    try { process.kill(activePlan.child.pid, 'SIGTERM') } catch {}
    return true
  }

  // apply() is human-approval-only: reached exclusively from the local API.
  // { cloud: true } runs every shift on the user's cloud box instead of this
  // machine (claude/codex only; scheduler enforces the license).
  function apply(rawPlan, { cloud = false } = {}) {
    const plan = sanitizePlan(rawPlan, rawPlan?.goal ?? '', catalog())
    const id = randomUUID()
    db.prepare(
      'INSERT INTO missions (id, name, goal, summary, metric, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, plan.name, plan.goal, plan.summary, plan.metric, 'active', Date.now())

    const roleIds = new Map()
    let shifts = 0
    for (const r of plan.roles) {
      const role = hq.createRole({
        name: r.name,
        agent: r.agent,
        cwd: r.cwd,
        playbook: `MISSION: ${plan.goal}\n\n${r.playbook}`,
        missionId: id,
      })
      roleIds.set(r.name, role.id)
      for (const s of r.shifts) {
        scheduler.create({
          name: s.name,
          when: s.when,
          action: {
            type: 'claude',
            value: {
              agent: r.agent,
              prompt: s.prompt,
              model: s.model || undefined,
              effort: s.effort || undefined,
              // risk-tiered approvals (t3code's Auto rung): routine actions
              // proceed, risky ones still land on the calendar as asks —
              // claude runs --permission-mode auto, codex routes approvals
              // through its auto_review subagent
              autoReview: true,
              ...(cloud ? { cloud: true } : { cwd: r.cwd ?? homedir() }),
            },
          },
          roleId: role.id,
          missionId: id,
        })
        shifts++
      }
    }
    for (const j of plan.oneOff) {
      const roleId = roleIds.get(j.role) ?? null
      const role = roleId ? hq.getRole(roleId) : null
      scheduler.create({
        name: j.name,
        when: { type: 'at', value: new Date(Date.now() + j.inMinutes * 60_000).toISOString() },
        action: {
          type: 'claude',
          value: {
            agent: role?.agent ?? 'claude',
            prompt: j.prompt,
            model: j.model || undefined,
            effort: j.effort || undefined,
            autoReview: true,
            ...(cloud ? { cloud: true } : { cwd: role?.cwd ?? homedir() }),
          },
        },
        roleId,
        missionId: id,
      })
    }
    bus?.emit('mission.created', { data: { id, name: plan.name, roles: plan.roles.length, shifts } })
    return { ...get(id), roles: plan.roles.length, shifts, oneOff: plan.oneOff.length }
  }

  function get(id) {
    return db.prepare('SELECT * FROM missions WHERE id = ?').get(id) ?? null
  }

  function list() {
    return db.prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM roles r WHERE r.mission_id = m.id) AS role_count,
              (SELECT COUNT(*) FROM schedules s WHERE s.mission_id = m.id) AS schedule_count
       FROM missions m ORDER BY created_at DESC LIMIT 50`
    ).all()
  }

  function archive(id) {
    const m = get(id)
    if (!m) return null
    // pause every mission role (kill-switch: their shifts stop firing) and
    // cancel anything still queued
    for (const r of db.prepare('SELECT id FROM roles WHERE mission_id = ?').all(id)) {
      hq.updateRole(r.id, { status: 'paused' })
    }
    db.prepare(
      "UPDATE schedules SET status = 'cancelled' WHERE mission_id = ? AND status IN ('pending', 'proposed')"
    ).run(id)
    db.prepare("UPDATE missions SET status = 'archived' WHERE id = ?").run(id)
    return get(id)
  }

  return { plan, cancelPlan, planContext, apply, list, get, archive }
}
