import { randomUUID } from 'node:crypto'

// Mission Control HQ — the employee layer over the scheduler.
//
// A role is a standing agent employee: a playbook (identity + duties +
// success criteria), its own notes (memory it writes across runs), a
// permission/budget envelope, and a status that doubles as the kill-switch.
// Schedules gain role_id, so a calendar block can be "the release-notes
// employee's Monday shift" rather than an anonymous job.
//
// Two rules make agent-created work safe, and both live HERE in code rather
// than in any prompt (the field's postmortems are unanimous: rails in
// prompts don't hold):
//   1. agents PROPOSE, humans dispose. A run can only create schedules with
//      status 'proposed'; they render as approval cards. "Approve always"
//      flips the role's auto_approve inside an envelope (max per week, how
//      far ahead) — outside it, back to proposing.
//   2. no privilege escalation, bounded lineage. A child job inherits its
//      parent's role and can never exceed its permissions; depth and
//      fan-out are capped so a self-scheduling loop dies at the second hop.

export const MAX_DEPTH = 2          // parent → child → grandchild stops here
export const MAX_FANOUT = 3         // proposals one run may create
export const PROPOSAL_TTL_MS = 7 * 86_400_000
export const NOTES_MAX = 16_384     // matches the OpenClaw state cap

const now = () => Date.now()
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}

export function createHq(db, bus) {
  const roleRow = db.prepare('SELECT * FROM roles WHERE id = ?')

  // ---- roles ---------------------------------------------------------
  function listRoles() {
    return db.prepare('SELECT * FROM roles ORDER BY created_at').all()
  }
  function getRole(id) {
    return roleRow.get(id) ?? null
  }
  function createRole(input = {}) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new Error('a role needs a name')
    const agent = ['claude', 'codex', 'openclaw', 'hermes', 'opencode'].includes(input.agent) ? input.agent : 'claude'
    const id = randomUUID()
    db.prepare(
      `INSERT INTO roles (id, name, agent, cwd, model, full_auto, playbook, notes,
                          budget_week_usd, auto_approve, env_max_per_week, env_horizon_days,
                          status, created_at, updated_at, mission_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?, 'active', ?, ?, ?)`
    ).run(
      id, name.slice(0, 80), agent, input.cwd ?? null, input.model ?? null,
      input.fullAuto ? 1 : 0, String(input.playbook ?? '').slice(0, 20_000),
      input.budgetWeekUsd == null ? null : Number(input.budgetWeekUsd),
      clampInt(input.envMaxPerWeek, 0, 50, 5), clampInt(input.envHorizonDays, 1, 90, 14),
      now(), now(), input.missionId ?? null,
    )
    bus?.emit('role.created', { data: { id, name } })
    return getRole(id)
  }
  function updateRole(id, patch = {}) {
    const role = getRole(id)
    if (!role) return null
    const fields = []
    const values = []
    const set = (col, val) => { fields.push(`${col} = ?`); values.push(val) }
    if (patch.name != null) set('name', String(patch.name).slice(0, 80))
    if (patch.cwd !== undefined) set('cwd', patch.cwd || null)
    if (patch.model !== undefined) set('model', patch.model || null)
    if (patch.playbook != null) set('playbook', String(patch.playbook).slice(0, 20_000))
    if (patch.fullAuto != null) set('full_auto', patch.fullAuto ? 1 : 0)
    // budgets are human-set only: no agent-facing path reaches this
    if (patch.budgetWeekUsd !== undefined) set('budget_week_usd', patch.budgetWeekUsd == null ? null : Number(patch.budgetWeekUsd))
    if (patch.autoApprove != null) set('auto_approve', patch.autoApprove ? 1 : 0)
    if (patch.envMaxPerWeek != null) set('env_max_per_week', clampInt(patch.envMaxPerWeek, 0, 50, 5))
    if (patch.envHorizonDays != null) set('env_horizon_days', clampInt(patch.envHorizonDays, 1, 90, 14))
    if (patch.status != null && ['active', 'paused'].includes(patch.status)) set('status', patch.status)
    if (!fields.length) return role
    set('updated_at', now())
    db.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`).run(...values, id)
    const updated = getRole(id)
    if (patch.status && patch.status !== role.status) {
      bus?.emit(patch.status === 'paused' ? 'role.paused' : 'role.resumed', { data: { id, name: updated.name } })
    }
    return updated
  }
  function deleteRole(id) {
    // schedules keep their history; they just lose the employee badge
    db.prepare('UPDATE schedules SET role_id = NULL WHERE role_id = ?').run(id)
    return db.prepare('DELETE FROM roles WHERE id = ?').run(id).changes > 0
  }

  // Notes are the role's memory. Agent-written, so: size-capped, and every
  // write is stamped with the run that made it (provenance — the memory
  // poisoning literature's one universal recommendation).
  function appendNotes(id, text, runId = null) {
    const role = getRole(id)
    if (!role) return null
    const stamp = `\n\n— ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${runId ? ` · run ${String(runId).slice(0, 8)}` : ''}\n`
    let next = (role.notes ?? '') + stamp + String(text ?? '').trim()
    if (next.length > NOTES_MAX) next = next.slice(-NOTES_MAX) // keep the newest
    db.prepare('UPDATE roles SET notes = ?, updated_at = ? WHERE id = ?').run(next, now(), id)
    return getRole(id)
  }
  function setNotes(id, text) {
    if (!getRole(id)) return null
    db.prepare('UPDATE roles SET notes = ?, updated_at = ? WHERE id = ?')
      .run(String(text ?? '').slice(0, NOTES_MAX), now(), id)
    return getRole(id)
  }

  // What a role has spent in the trailing week, from the runs themselves.
  function weekSpend(roleId) {
    const since = now() - 7 * 86_400_000
    let total = 0
    for (const r of db.prepare(
      "SELECT result FROM schedules WHERE role_id = ? AND fired_at >= ? AND result IS NOT NULL"
    ).all(roleId, since)) {
      try { total += Number(JSON.parse(r.result)?.costUsd) || 0 } catch {}
    }
    return total
  }

  // Fire-time gate. Returns null to proceed, or a reason string to block —
  // a blocked run is recorded and paged, never silently skipped.
  function gate(roleId) {
    const role = getRole(roleId)
    if (!role) return null
    if (role.status === 'paused') return `role "${role.name}" is paused`
    if (role.budget_week_usd != null) {
      const spent = weekSpend(roleId)
      if (spent >= role.budget_week_usd) {
        return `role "${role.name}" hit its weekly budget ($${spent.toFixed(2)} of $${Number(role.budget_week_usd).toFixed(2)})`
      }
    }
    return null
  }

  // The role's standing context, prepended to every run's prompt. Playbook
  // first (identity + duties), then its own notes (what it learned), then
  // the task. Kept plain text so any agent CLI can consume it.
  function composePrompt(role, prompt) {
    if (!role) return prompt
    const parts = [`You are "${role.name}", a standing agent role in this workspace.`]
    if (role.playbook?.trim()) parts.push(`## Your playbook\n${role.playbook.trim()}`)
    if (role.notes?.trim()) parts.push(`## Your notes from earlier runs\n${role.notes.trim()}`)
    parts.push(`## This run\n${prompt}`)
    return parts.join('\n\n')
  }

  // N consecutive failures pause the role — a broken employee stops showing
  // up rather than burning budget every morning.
  function noteRunOutcome(roleId, outcome) {
    if (!roleId) return
    const rows = db.prepare(
      "SELECT result FROM schedules WHERE role_id = ? AND status IN ('done','error') ORDER BY fired_at DESC LIMIT 3"
    ).all(roleId)
    if (rows.length < 3) return
    const bad = rows.every((r) => {
      try { return ['failed', 'blocked'].includes(JSON.parse(r.result)?.outcome) } catch { return false }
    })
    if (bad && outcome === 'failed') {
      updateRole(roleId, { status: 'paused' })
      addMessage({
        roleId, kind: 'attention',
        subject: 'Paused after three failed runs',
        body: 'This role failed three times in a row and has been paused. Review its recent runs, fix the playbook or the repo state, then resume it from the roster.',
      })
    }
  }

  // ---- inbox ---------------------------------------------------------
  function addMessage({ roleId = null, scheduleId = null, kind = 'info', subject = '', body = '' }) {
    const id = randomUUID()
    const k = ['info', 'attention', 'report'].includes(kind) ? kind : 'info'
    db.prepare(
      'INSERT INTO messages (id, role_id, schedule_id, kind, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, roleId, scheduleId, k, String(subject ?? '').slice(0, 200), String(body ?? '').slice(0, 20_000), now())
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    bus?.emit('inbox.message', { data: { id, roleId, kind: k, subject: row.subject } })
    return row
  }
  function listMessages({ archived = false, limit = 100 } = {}) {
    return db.prepare(
      `SELECT m.*, r.name AS role_name FROM messages m LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY m.created_at DESC LIMIT ?`
    ).all(clampInt(limit, 1, 500, 100))
  }
  const unreadCount = () =>
    db.prepare('SELECT COUNT(*) n FROM messages WHERE read_at IS NULL AND archived_at IS NULL').get().n
  function markRead(ids) {
    const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
    let n = 0
    for (const id of ids) n += stmt.run(now(), id).changes
    return n
  }
  function markAllRead() {
    return db.prepare('UPDATE messages SET read_at = ? WHERE read_at IS NULL AND archived_at IS NULL').run(now()).changes
  }
  function archiveMessage(id) {
    return db.prepare('UPDATE messages SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?')
      .run(now(), now(), id).changes > 0
  }

  // ---- proposals -----------------------------------------------------
  // Envelope check for auto-approval: the role opted in, the fire time is
  // inside the horizon, and it hasn't already booked its weekly allowance.
  function envelopeAllows(role, fireAt) {
    if (!role || !role.auto_approve) return false
    if (role.status !== 'active') return false
    const horizon = now() + role.env_horizon_days * 86_400_000
    if (fireAt != null && fireAt > horizon) return false
    // only AGENT-created bookings count against the allowance — the human's
    // own shifts for this role are not the agent spending its rope
    const weekAhead = db.prepare(
      `SELECT COUNT(*) n FROM schedules WHERE role_id = ? AND parent_id IS NOT NULL
       AND status IN ('pending','running') AND fire_at BETWEEN ? AND ?`
    ).get(role.id, now(), now() + 7 * 86_400_000).n
    return weekAhead < role.env_max_per_week
  }

  function listProposals() {
    return db.prepare("SELECT * FROM schedules WHERE status = 'proposed' ORDER BY created_at DESC").all()
  }

  // Unapproved proposals rot: expire them so the calendar doesn't fill with
  // suggestions nobody wanted.
  function expireProposals() {
    return db.prepare(
      "UPDATE schedules SET status = 'expired', result = ? WHERE status = 'proposed' AND created_at < ?"
    ).run(JSON.stringify({ skipped: 'proposal expired unanswered' }), now() - PROPOSAL_TTL_MS).changes
  }

  // How many proposals this run has already made (fan-out cap).
  const proposalsFrom = (parentId) =>
    db.prepare("SELECT COUNT(*) n FROM schedules WHERE parent_id = ?").get(parentId).n

  return {
    listRoles, getRole, createRole, updateRole, deleteRole,
    appendNotes, setNotes, weekSpend, gate, composePrompt, noteRunOutcome,
    addMessage, listMessages, unreadCount, markRead, markAllRead, archiveMessage,
    envelopeAllows, listProposals, expireProposals, proposalsFrom,
  }
}
