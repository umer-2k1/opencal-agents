import { randomUUID } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { windowStatus } from './windows.js'
import { DATA_DIR } from './config.js'
import { provisionVm, stopVm, proKey, machineEvents, machineRpc } from './cloud.js'
import { runClaudeJob, createPermissionBroker, permissionSocketPath, askSummary } from './drivers/claude.js'
import { runCodexJob } from './drivers/codex.js'
import { estimateCodexCostUsd } from './models.js'
import { gitHead, gitNumstat, createMirror } from './runner/acal-runner.js'
import { checkpoint, diffBetween, addJobWorktree, pruneWorktrees } from './vcs.js'
import { MAX_DEPTH, MAX_FANOUT } from './hq.js'
import { parseWhen } from './when.js'

// Schedules: when = at (ISO) | next_reset (provider[:account]) | daily (HH:MM).
// Actions:
//   command  – shell command
//   webhook  – POST a URL
//   claude   – run `claude -p <prompt>` in a repo, with safety rails:
//              dry-run by default, git-branch match, max runtime, full audit log.
// next_reset fires when the current (estimated or vendor) window ends; if no
// window is active, capacity is already fresh and it fires immediately.
// A pending job that misses its moment by >60min expires instead of firing.

const RUNS_DIR = join(DATA_DIR, 'runs')
const MISS_MS = 60 * 60_000
// "the box was never signed in" reported in prose rather than as a flag
const NOT_SIGNED_IN = /not logged in|not signed in|run \/login|please run `?\/login/i

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', timeout: 3000 }).trim()
  } catch {
    return null
  }
}

function nextDaily(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// Minimal 5-field cron (m h dom mon dow), evaluated by OUR ticker — system
// cron never runs jobs (it can't express next_reset and has env pitfalls).
function cronField(field, min, max) {
  const out = new Set()
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    let lo = min
    let hi = max
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number)
      lo = a
      hi = b ?? (stepRaw ? max : a)
    }
    if (![lo, hi, step].every(Number.isFinite) || step < 1 || lo < min || hi > max) {
      throw new Error(`invalid cron field "${field}"`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function nextCron(expr, from = Date.now()) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week')
  const [m, h, dom, mon, dow] = [
    cronField(parts[0], 0, 59), cronField(parts[1], 0, 23),
    cronField(parts[2], 1, 31), cronField(parts[3], 1, 12), cronField(parts[4], 0, 7),
  ]
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  const dowHas = (day) => dow.has(day) || (dow.has(7) && day === 0)
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < 366 * 1440; i++) {
    const dayOk = domAny && dowAny ? true
      : domAny ? dowHas(d.getDay())
      : dowAny ? dom.has(d.getDate())
      : dom.has(d.getDate()) || dowHas(d.getDay()) // standard cron OR semantics
    if (mon.has(d.getMonth() + 1) && dayOk && h.has(d.getHours()) && m.has(d.getMinutes())) return d.getTime()
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error('cron expression never fires within a year')
}

// what actually happened, beyond exit-ok: a run that had tools denied is
// blocked; a clean run that changed no files is no_changes. Rendering these
// distinctly is what keeps a green calendar honest.
function runOutcome(ok, denials, diff) {
  if (!ok) return 'failed'
  if (denials?.length) return 'blocked'
  if (diff) return diff.files === 0 ? 'no_changes' : 'changed'
  return 'done'
}

export function createScheduler(db, cfg, bus, hq = null) {
  mkdirSync(RUNS_DIR, { recursive: true })
  const setFireAt = db.prepare('UPDATE schedules SET fire_at = ? WHERE id = ?')
  const setStatus = db.prepare('UPDATE schedules SET status = ?, fired_at = ?, result = ? WHERE id = ?')
  const setResult = db.prepare('UPDATE schedules SET result = ? WHERE id = ?')
  const activeBrokers = new Map() // scheduleId -> permission broker (local runs)

  // Asks land in the schedule's result JSON (the calendar polls it) and on
  // the local bus — shared by the claude broker and the codex driver, which
  // deliver asks through different plumbing but the same shape.
  function askHandlers(s, audit, provider, mirror = null) {
    return {
      onAsk: (ask) => {
        // ExitPlanMode surfacing as a permission IS the plan approval (t3code's
        // trick): capture the plan text, render a plan card instead of a
        // yes/no — Implement spawns the executing block, Refine loops feedback
        const isPlan = ask.kind === 'permission' && ask.tool === 'ExitPlanMode'
        if (isPlan) audit.plan = String(ask.input?.plan ?? '')
        audit.pendingAsk = {
          id: ask.id, kind: isPlan ? 'plan' : ask.kind, tool: ask.tool,
          summary: isPlan ? (audit.plan.replace(/\s+/g, ' ').slice(0, 300) || 'Plan ready') : askSummary(ask),
          choices: ask.input?.choices ?? null, at: ask.at,
        }
        setResult.run(JSON.stringify(audit), s.id)
        mirror?.write({ type: 'ask', kind: ask.kind, tool: ask.tool, summary: askSummary(ask), choices: ask.input?.choices })
        bus.emit('job.needs_input', {
          provider,
          data: { scheduleId: s.id, name: s.name, ask: audit.pendingAsk },
        })
      },
      onResolve: (resolved) => {
        if (resolved.behavior === 'deny') {
          audit.denied = [...new Set([...(audit.denied ?? []), resolved.tool])]
        }
        delete audit.pendingAsk
        setResult.run(JSON.stringify(audit), s.id)
        mirror?.write({ type: 'answered', kind: resolved.kind, tool: resolved.tool, behavior: resolved.behavior, source: resolved.source })
        bus.emit('job.answered', {
          provider,
          data: { scheduleId: s.id, name: s.name, askId: resolved.id, behavior: resolved.behavior, source: resolved.source },
        })
      },
    }
  }

  // The agent's HQ tools, executed host-side. Each returns the sentence the
  // agent sees, so it knows what actually happened (proposed vs scheduled).
  function hqHandler(s, audit) {
    return async (tool, input) => {
      if (!hq) throw new Error('HQ is not enabled')
      if (tool === 'send_message') {
        hq.addMessage({
          roleId: s.role_id ?? null, scheduleId: s.id,
          kind: input.kind, subject: input.subject, body: input.body,
        })
        return "Delivered to the owner's inbox."
      }
      if (tool === 'update_notes') {
        if (!s.role_id) return 'This job has no role, so there are no notes to keep. Include it in your final summary instead.'
        hq.appendNotes(s.role_id, input.note, s.id)
        return 'Noted — you will see this in future runs of this role.'
      }
      if (tool === 'propose_job') {
        const when = String(input.when ?? '').trim()
        const spec = parseWhen(when)
        if (!spec) throw new Error(`could not read the time "${when}" — try "tomorrow at 9am", "every weekday at 08:00", or an ISO datetime`)
        if (spec.type === 'next_reset') spec.value = audit.agent ?? 'claude'
        const row = this.create({
          name: String(input.name ?? '').slice(0, 80),
          when: spec,
          action: {
            type: 'claude',
            value: {
              agent: audit.agent ?? 'claude', prompt: input.prompt, cwd: audit.cwd,
              why: input.why ?? null,
            },
          },
          by: { scheduleId: s.id },
        })
        return row.status === 'proposed'
          ? 'Proposed — it appears on the calendar for the owner to approve.'
          : `Scheduled for ${new Date(row.fire_at).toLocaleString()} (inside your role's pre-approved envelope).`
      }
      throw new Error(`unknown tool ${tool}`)
    }
  }

  // Local broker: same deal as the runner's. All claude jobs get one —
  // fullAuto skips the permission gate but keeps ask_user.
  function attachBroker(s, spec, audit, mirror = null) {
    if ((spec.agent ?? 'claude') !== 'claude') return null
    const broker = createPermissionBroker({
      socketPath: permissionSocketPath(RUNS_DIR, s.id),
      ...askHandlers(s, audit, 'claude', mirror),
      onHq: hq ? hqHandler.call(api, s, audit) : null,
    })
    activeBrokers.set(s.id, broker)
    spec.permissionSocket = broker.socketPath
    return broker
  }

  // Local job mirror: the driver stays the engine; a detached tmux session
  // runs `agentcalendar render` over the job's ndjson, so `tmux attach -t
  // agentcal-<id>` shows the run live and drops into a shell with the
  // takeover command pre-typed when it ends — the same mechanism the cloud
  // runner uses for its Join window. Replaces running the agent *inside*
  // tmux, which threw away every structured event the drivers produce.
  function createLocalMirror(s, spec) {
    const session = `agentcal-${s.id.slice(0, 8)}`
    const m = createMirror(session, s.id, spec, spec.cwd, {
      createSession: true,
      file: join(RUNS_DIR, `${s.id}-${Date.now()}.ndjson`),
      shell: process.env.SHELL || '/bin/zsh',
    })
    m.openWindow()
    return m
  }

  function detachBroker(id) {
    activeBrokers.get(id)?.close()
    activeBrokers.delete(id)
  }

  function resolveNextReset(whenValue) {
    const [provider, account] = String(whenValue || 'claude').split(':')
    const statuses = windowStatus(db, cfg).filter(
      (w) => w.provider === provider && (!account || w.account === account)
    )
    if (statuses.length === 0) return Date.now()
    const resets = statuses.map((w) => w.nextResetAt).filter(Boolean)
    return resets.length ? Math.max(...resets) : Date.now()
  }

  function finish(s, status, result) {
    // fired_at is about to become the FINISH time (the calendar sorts by it),
    // so stamp the wall-clock duration into the audit while the start time
    // (audit.firedAt) is still there to compute it from
    try {
      const audit = JSON.parse(result)
      if (audit && typeof audit === 'object' && audit.firedAt && audit.durationMs == null) {
        const started = Date.parse(audit.firedAt)
        if (Number.isFinite(started)) {
          audit.durationMs = Math.max(0, Date.now() - started)
          result = JSON.stringify(audit)
        }
      }
    } catch {}
    // employee accountability: three bad runs in a row pause the role
    if (s.role_id && hq) {
      try { hq.noteRunOutcome(s.role_id, JSON.parse(result)?.outcome) } catch {}
    }
    const recurring = s.when_type === 'daily' || s.when_type === 'cron'
    if (recurring && status !== 'error') {
      // recurring: record the run, then rearm (status back to pending or it never fires again)
      const next = s.when_type === 'cron' ? nextCron(s.when_value) : nextDaily(s.when_value)
      db.prepare("UPDATE schedules SET status = 'pending', fired_at = ?, result = ?, fire_at = ? WHERE id = ?")
        .run(Date.now(), String(result).slice(0, 4000), next, s.id)
    } else {
      setStatus.run(status, Date.now(), String(result).slice(0, 4000), s.id)
    }
    bus.emit('schedule.fired', {
      data: { id: s.id, name: s.name, action: s.action_type, ok: status !== 'error', result: String(result).slice(0, 300) },
    })
  }

  // Cloud runs (v2): provision wakes the customer's persistent VM, the
  // on-VM acal-runner dials the MachineHub, and the worker delivers the job
  // over hub RPC — nothing staged on disk. The block stays "running" while
  // the job streams events; pollCloudJob finishes it on job.done/failed (the
  // time cap stays as the backstop). We never send credentials — the user
  // logs the agent CLI in from the browser terminal themselves, once.
  async function fireCloud(s, spec) {
    const audit = {
      cloud: true, agent: spec.agent ?? 'claude', prompt: spec.prompt,
      model: spec.model ?? null, dryRun: spec.dryRun === true,
      maxRuntimeMin: Math.min(spec.maxRuntimeMin || 240, 480),
      firedAt: new Date().toISOString(),
    }
    if (audit.dryRun) {
      return finish(s, 'done', JSON.stringify({ ...audit, dryRunNote: 'would have provisioned a cloud VM; re-create with dryRun:false to execute' }))
    }
    setStatus.run('running', Date.now(), JSON.stringify(audit), s.id)
    try {
      const vm = await provisionVm({
        name: s.name || spec.prompt.slice(0, 40),
        prompt: spec.prompt, agent: spec.agent, model: spec.model ?? undefined,
        maxRuntimeMin: audit.maxRuntimeMin, fullAuto: !!spec.fullAuto,
        mode: spec.mode || undefined,
      })
      const full = {
        ...audit, provider: vm.provider ?? 'box',
        vmId: vm.vmId, machineName: vm.machineName, joinUrl: vm.joinUrl,
        credential: vm.credential, stopAt: Date.now() + audit.maxRuntimeMin * 60_000,
        machineId: vm.machineId ?? null, jobId: vm.job?.jobId ?? null,
        jobDispatched: vm.job?.dispatched ?? false, lastSeq: 0,
      }
      db.prepare('UPDATE schedules SET result = ? WHERE id = ?').run(JSON.stringify(full), s.id)
      if (vm.job?.reason === 'needs-login') {
        // First run on a fresh VM: it isn't signed in yet. Hold it up on a
        // short grace window (NOT the full cap) so the user can Join, run
        // `claude` + /login once, then re-create the job. No job is running,
        // so nothing to poll; the sweep auto-stops at graceStopAt.
        const grace = {
          ...full, jobId: null, jobDispatched: false, needsLogin: true,
          stopAt: Date.now() + 20 * 60_000,
        }
        db.prepare('UPDATE schedules SET result = ? WHERE id = ?').run(JSON.stringify(grace), s.id)
        const how = spec.agent === 'codex' ? 'codex login' : 'claude then /login'
        bus.emit('schedule.started', {
          data: { id: s.id, name: s.name, action: 'claude', ok: false,
            result: `Sign in needed — open your cloud box's desktop, run: ${how} (one time), then re-create this job. VM stays up ~20 min.` },
        })
        return
      }
      // 'pending' = the control plane is delivering the job in the background
      // so the VM became joinable immediately; the outcome arrives on the hub
      // event stream like any other job event
      if (vm.job?.holdOpen) {
        const grace = { ...full, jobId: null, jobDispatched: false, needsLogin: true, stopAt: Date.now() + 20 * 60_000 }
        db.prepare('UPDATE schedules SET result = ? WHERE id = ?').run(JSON.stringify(grace), s.id)
        bus.emit('schedule.started', {
          data: { id: s.id, name: s.name, action: 'claude', ok: false, result: vm.job.error ?? 'the VM is up but setup failed — Join to look' },
        })
        return
      }
      if (vm.job && vm.job.dispatched !== true && vm.job.dispatched !== 'pending') {
        // VM is up but the job never started — don't leave it billing until
        // the time cap; meter what we used and surface the error
        return await stopCloudRun(s, full, `job dispatch failed: ${vm.job.error ?? 'unknown'}`, 'error')
      }
      // started (NOT fired/finished): the Join button just became available
      bus.emit('schedule.started', {
        data: { id: s.id, name: s.name, action: 'claude', ok: true, result: `cloud box ${vm.machineName} is running the job — Join or watch it from the calendar` },
      })
    } catch (e) {
      finish(s, 'error', JSON.stringify({ ...audit, cloudError: e.message }))
    }
  }

  async function stopCloudRun(s, r, note, status = 'done') {
    // persist the in-flight marker so overlapping ticks don't double-stop
    db.prepare('UPDATE schedules SET result = ? WHERE id = ?')
      .run(JSON.stringify({ ...r, stopping: true, stoppingAt: Date.now() }), s.id)
    try {
      const res = await stopVm(r.vmId)
      finish(s, status, JSON.stringify({ ...r, stoppedAt: Date.now(), meteredSeconds: res.seconds ?? null, note }))
      return res
    } catch (e) {
      // clear the marker so the sweeper retries later
      db.prepare('UPDATE schedules SET result = ? WHERE id = ?')
        .run(JSON.stringify({ ...r, stopError: e.message }), s.id)
      throw e
    }
  }

  // Stream a running cloud job's hub events into the local bus and finish
  // the block the moment the job completes — same job.* vocabulary as local
  // driver runs, so webhooks/SSE/ics see cloud and local jobs identically.
  const cloudPolls = new Set() // in-flight guard: slow fetches must not stack across ticks
  async function pollCloudJob(s, r) {
    if (cloudPolls.has(s.id)) return
    cloudPolls.add(s.id)
    const prov = r.agent === 'codex' ? 'codex' : 'claude'
    try {
      const { events, lastSeq } = await machineEvents(r.machineId, r.lastSeq || 0)
      if (lastSeq === (r.lastSeq || 0)) return
      let updated = { ...r, lastSeq }
      let finished = null
      for (const e of events ?? []) {
        const d = e.data ?? {}
        if (d.jobId !== r.jobId) continue
        if (e.type === 'job.started') {
          updated.sessionId = d.sessionId
          if (d.model) updated.model = d.model
          bus.emit('job.started', {
            provider: prov,
            data: { scheduleId: s.id, name: s.name, cloud: true, sessionId: d.sessionId, model: d.model },
          })
        } else if (e.type === 'job.handoff') {
          // the user pulled the run into the terminal: no job.done will ever
          // come. Keep the block running (Stop / time cap still apply).
          if (d.sessionId) updated.sessionId = d.sessionId
          if (!updated.takenOver) {
            updated.takenOver = true
            bus.emit('job.handoff', {
              provider: prov,
              data: { scheduleId: s.id, name: s.name, cloud: true, sessionId: d.sessionId ?? null },
            })
          }
        } else if (e.type === 'job.ask') {
          // the VM's run wants a permission — amber block until answered
          updated.pendingAsk = d.ask
          // a plan ask carries the full plan so Implement can spawn the block
          if (d.ask?.kind === 'plan' && d.ask.plan) updated.plan = d.ask.plan
          bus.emit('job.needs_input', {
            provider: prov,
            data: { scheduleId: s.id, name: s.name, cloud: true, ask: d.ask },
          })
        } else if (e.type === 'job.answered') {
          if (updated.pendingAsk?.id === d.askId) delete updated.pendingAsk
          bus.emit('job.answered', {
            provider: prov,
            data: { scheduleId: s.id, name: s.name, cloud: true, askId: d.askId, behavior: d.behavior, source: d.source },
          })
        } else if (e.type === 'job.failed' && (d.needsLogin || NOT_SIGNED_IN.test(`${d.error ?? ''} ${d.result ?? ''}`))) {
          // the box is up but its agent CLI was never signed in. Keep it
          // running on a short grace window so the user can open it, log in
          // once, and re-run — stopping now would kill the VM they need.
          updated.needsLogin = true
          updated.jobId = null // nothing is running; stop polling for it
          updated.stopAt = Date.now() + 20 * 60_000
          bus.emit('schedule.started', {
            data: { id: s.id, name: s.name, action: 'claude', ok: false, result: d.error },
          })
        } else if (e.type === 'job.done' || e.type === 'job.failed') {
          finished = { ok: e.type === 'job.done', ...d }
        }
      }
      if (!finished) {
        db.prepare('UPDATE schedules SET result = ? WHERE id = ?').run(JSON.stringify(updated), s.id)
        return
      }
      bus.emit(finished.ok ? 'job.done' : 'job.failed', {
        provider: prov,
        data: {
          scheduleId: s.id, name: s.name, cloud: true, ok: finished.ok,
          outcome: finished.outcome ?? null, denials: finished.denials ?? null,
          costUsd: finished.cost ?? null, turns: finished.turns ?? null,
          stopReason: finished.stopReason ?? null, diff: finished.diff ?? null,
        },
      })
      delete updated.pendingAsk
      updated = {
        ...updated, jobOk: finished.ok, costUsd: finished.cost ?? null,
        outcome: finished.outcome ?? null, denials: finished.denials ?? null,
        turns: finished.turns ?? null, stopReason: finished.stopReason ?? null,
        diff: finished.diff ?? null, jobResult: (finished.result || '').slice(-1500),
      }
      await stopCloudRun(s, updated, finished.ok ? 'job finished' : 'job failed', finished.ok ? 'done' : 'error')
    } finally {
      cloudPolls.delete(s.id)
    }
  }

  async function fireClaude(s) {
    let spec
    try {
      spec = JSON.parse(s.action_value)
    } catch {
      return finish(s, 'error', 'invalid claude action spec')
    }
    // employee gate: a paused role or one over its weekly budget doesn't run.
    // Blocked is recorded and paged — never a silent skip.
    if (s.role_id && hq) {
      const blocked = hq.gate(s.role_id)
      if (blocked) {
        hq.addMessage({
          roleId: s.role_id, scheduleId: s.id, kind: 'attention',
          subject: 'Shift skipped', body: blocked,
        })
        return finish(s, 'error', JSON.stringify({ outcome: 'blocked', skipped: blocked, roleId: s.role_id }))
      }
      const role = hq.getRole(s.role_id)
      if (role) {
        // the role's standing context rides in front of the task prompt
        spec.prompt = hq.composePrompt(role, spec.prompt)
        spec.cwd = spec.cwd || role.cwd
        spec.model = spec.model || role.model || undefined
        spec.agent = spec.agent || role.agent
        if (!role.full_auto) spec.fullAuto = false
      }
    }
    if (spec.cloud) return fireCloud(s, spec)
    // no repo named (inbox replies, role follow-ups): run from home like
    // missions do rather than erroring on a missing cwd
    if (!spec.cwd) spec.cwd = homedir()
    const audit = {
      agent: spec.agent ?? 'claude',
      roleId: s.role_id ?? null,
      prompt: spec.prompt, cwd: spec.cwd, model: spec.model ?? null, effort: spec.effort ?? null,
      autoReview: !!spec.autoReview,
      branchAtCreation: spec.branch ?? null, dryRun: spec.dryRun === true,
      maxRuntimeMin: Math.min(spec.maxRuntimeMin || 30, 240),
      firedAt: new Date().toISOString(),
    }
    // safety rails
    if (!existsSync(spec.cwd)) return finish(s, 'error', JSON.stringify({ ...audit, skipped: 'cwd no longer exists' }))
    const branchNow = gitBranch(spec.cwd)
    audit.branchAtFire = branchNow
    if (spec.branch && branchNow && spec.branch !== branchNow) {
      return finish(s, 'expired', JSON.stringify({ ...audit, skipped: `branch changed ${spec.branch} -> ${branchNow}` }))
    }
    if (audit.dryRun) {
      return finish(s, 'done', JSON.stringify({ ...audit, dryRunNote: 'would have run; re-create with dryRun:false to execute' }))
    }
    const logFile = join(RUNS_DIR, `${s.id}-${Date.now()}.log`)
    audit.logFile = logFile
    if ((spec.agent ?? 'claude') === 'claude') {
      spec.sessionId = randomUUID()
      audit.sessionId = spec.sessionId
    }

    // Isolation (opt-in via spec.worktree): the job gets its own worktree +
    // acal/<id> branch, so concurrent jobs never interleave in one tree, the
    // diff is exactly this job's work, and takeover lands somewhere safe.
    // The branch survives worktree pruning — finished work stays mergeable.
    if (spec.worktree) {
      try {
        const wt = await addJobWorktree(spec.cwd, s.id.slice(0, 8))
        audit.repo = spec.cwd
        audit.worktree = wt.path
        audit.workBranch = wt.branch
        spec.cwd = wt.path
        audit.cwd = wt.path
      } catch (e) {
        return finish(s, 'error', JSON.stringify({ ...audit, worktreeError: e.message }))
      }
    }

    // tmux is the VIEWING surface, not the engine: structured agents (claude,
    // codex) always run through their drivers — real completion, tokens,
    // cost, ask brokering — and, when tmux exists, mirror into a live render
    // window the user can attach and take over. spec.headless skips only the
    // window. Text-only agents keep the old run-inside-tmux path below.
    let hasTmux = false
    try {
      execFileSync('sh', ['-lc', 'command -v tmux'], { timeout: 2000 })
      hasTmux = true
    } catch {}
    const agent = spec.agent ?? 'claude'
    if (agent === 'claude' || agent === 'codex') {
      const mirror = hasTmux && !spec.headless ? createLocalMirror(s, spec) : null
      if (agent === 'claude') return fireClaudeDriver(s, spec, audit, logFile, mirror)
      return fireCodexDriver(s, spec, audit, logFile, mirror)
    }
    if (hasTmux && !spec.headless) return fireClaudeTmux(s, spec, audit, logFile)
    const basePromise = gitHead(spec.cwd)
    const [bin, ...args] = agentCommand(spec)
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      // spawn() changes cwd but leaves PWD inherited from the app. CLIs that
      // trust PWD (OpenCode does) run in the wrong directory and can hang.
      env: { ...process.env, PWD: spec.cwd || process.cwd() },
      // Headless one-shot CLIs must not inherit an open stdin pipe: OpenCode
      // blocks waiting for EOF and the job stays "running" forever.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = createWriteStream(logFile)
    log.write(`# agentcal run ${s.id}\n# ${JSON.stringify(audit)}\n\n`)
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    const killer = setTimeout(() => child.kill('SIGTERM'), audit.maxRuntimeMin * 60_000)
    child.on('close', (code) => {
      clearTimeout(killer)
      log.end()
      basePromise.then((base) => gitNumstat(spec.cwd, base)).then((diff) => {
        audit.diff = diff
        audit.outcome = runOutcome(code === 0, null, diff)
        let tail = ''
        try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch {}
        finish(s, code === 0 ? 'done' : 'error', JSON.stringify({ ...audit, exitCode: code, outputTail: tail }))
      }).catch((e) => {
        try { setStatus.run('error', Date.now(), JSON.stringify({ ...audit, internalError: e.message }), s.id) } catch {}
      })
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      finish(s, 'error', JSON.stringify({ ...audit, spawnError: e.message }))
    })
    setStatus.run('running', Date.now(), JSON.stringify(audit), s.id)
  }

  // Headless claude via the stream-json driver: prompt over stdin (never
  // argv), completion from the real `result` event, normalized events into
  // the run log + semantic job.* events onto the bus (webhooks/SSE get cloud
  // parity for free).
  async function fireClaudeDriver(s, spec, audit, logFile, mirror = null) {
    audit.executor = 'stream-json'
    if (mirror) {
      audit.tmuxSession = mirror.session
      audit.mirrorFile = mirror.file
    }
    const base = await gitHead(spec.cwd)
    audit.baseHead = base
    // checkpoint bracket: park the pre-run tree on a hidden ref now, the
    // final tree at done — the diff is tree-to-tree, staging area untouched
    const cp = await checkpoint(spec.cwd, `jobs/${s.id}/base`).catch(() => null)
    if (cp) audit.checkpointBase = cp.commit
    const log = createWriteStream(logFile)
    log.write(`# agentcalendar run ${s.id}\n# ${JSON.stringify(audit)}\n\n`)
    const line = (t) => { try { log.write(t + '\n') } catch {} }
    // native protocol stream alongside the pretty log: what the CLI actually
    // said, before normalization — the artifact that answers "did we drop an
    // event or did the CLI change its protocol?"
    const native = createWriteStream(logFile + '.native.ndjson')
    const raw = (r) => { try { native.write(JSON.stringify({ ts: Date.now(), ...r }) + '\n') } catch {} }
    attachBroker(s, spec, audit, mirror)
    const job = runClaudeJob({
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model || undefined,
      effort: spec.effort || undefined,
      fullAuto: !!spec.fullAuto,
      autoReview: !!spec.autoReview,
      mode: spec.mode || undefined,
      permissionSocket: spec.permissionSocket,
      sessionId: spec.sessionId,
      maxRuntimeMs: audit.maxRuntimeMin * 60_000,
      onRaw: raw,
      onEvent: (e) => {
        if (e.type === 'done') mirror?.write({ ...e, sessionId: spec.sessionId })
        else mirror?.write(e)
        if (e.type === 'session') {
          audit.model = e.model
          line(`▸ session ${e.sessionId} · ${e.model}`)
          bus.emit('job.started', {
            provider: 'claude',
            data: { scheduleId: s.id, name: s.name, sessionId: e.sessionId, model: e.model },
          })
        } else if (e.type === 'assistant') {
          line(e.text)
          // zero-cost auto-title: the first assistant sentence names an
          // unnamed job; a user-given name always wins (we never overwrite)
          if (!s.name && !audit.autoTitle && e.text.trim()) {
            audit.autoTitle = e.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 64)
            setResult.run(JSON.stringify(audit), s.id)
          }
        }
        else if (e.type === 'tool_use') line(`⏺ ${e.name}`)
        else if (e.type === 'tool_result' && !e.ok) line('  ⎿ tool failed')
        else if (e.type === 'tokens') audit.tokens = { in: e.input, out: e.output }
        else if (e.type === 'error') line(`✗ ${e.message}`)
      },
    })
    setStatus.run('running', Date.now(), JSON.stringify(audit), s.id)
    job.done.then(async (r) => {
      detachBroker(s.id)
      const diff = await finalizeDiff(s, spec, audit, cp, base, logFile)
      const denials = [...new Set([...(r.denials ?? []), ...(audit.denied ?? [])])]
      delete audit.pendingAsk
      audit.costUsd = r.cost
      audit.turns = r.turns
      audit.stopReason = r.stopReason
      audit.diff = diff
      audit.denials = denials
      audit.outcome = runOutcome(r.ok, denials, diff)
      line(`\n— ${audit.outcome}${diff ? ` · ${diff.files} files +${diff.insertions} −${diff.deletions}` : ''}${denials.length ? ` · denied: ${denials.join(', ')}` : ''} —`)
      log.end()
      native.end()
      bus.emit(r.ok ? 'job.done' : 'job.failed', {
        provider: 'claude',
        data: {
          scheduleId: s.id, name: s.name, ok: r.ok, outcome: audit.outcome,
          costUsd: r.cost ?? null, turns: r.turns ?? null, diff, denials,
          stopReason: r.stopReason ?? null, tokens: audit.tokens ?? null,
        },
      })
      if (mirror) {
        await mirror.preType(spec.sessionId ? `claude --resume ${spec.sessionId}` : 'claude --continue')
        mirror.close()
      }
      finish(s, r.ok ? 'done' : 'error',
        JSON.stringify({ ...audit, exitCode: r.code, outputTail: (r.result || '').slice(-1500) }))
    }).catch((e) => {
      // a finalize throw must never strand the row as running-forever
      detachBroker(s.id)
      try { mirror?.close() } catch {}
      try { setStatus.run('error', Date.now(), JSON.stringify({ ...audit, internalError: e.message }), s.id) } catch {}
    })
  }

  // Headless codex via the app-server driver: JSON-RPC thread/turn instead
  // of parsing `codex exec` text, completion from the real turn/completed
  // event, and approvals surfacing as calendar asks — codex sends them as
  // in-process server→client requests, so no MCP proxy or socket is needed.
  async function fireCodexDriver(s, spec, audit, logFile, mirror = null) {
    audit.executor = 'app-server'
    if (mirror) {
      audit.tmuxSession = mirror.session
      audit.mirrorFile = mirror.file
    }
    const base = await gitHead(spec.cwd)
    audit.baseHead = base
    const cp = await checkpoint(spec.cwd, `jobs/${s.id}/base`).catch(() => null)
    if (cp) audit.checkpointBase = cp.commit
    const log = createWriteStream(logFile)
    log.write(`# agentcalendar run ${s.id}\n# ${JSON.stringify(audit)}\n\n`)
    const line = (t) => { try { log.write(t + '\n') } catch {} }
    const native = createWriteStream(logFile + '.native.ndjson')
    const raw = (r) => { try { native.write(JSON.stringify({ ts: Date.now(), ...r }) + '\n') } catch {} }
    const job = runCodexJob({
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model || undefined,
      effort: spec.effort || undefined,
      fullAuto: !!spec.fullAuto,
      autoReview: !!spec.autoReview,
      maxRuntimeMs: audit.maxRuntimeMin * 60_000,
      onRaw: raw,
      ...askHandlers(s, audit, 'codex', mirror),
      onEvent: (e) => {
        if (e.type === 'done') mirror?.write({ ...e, sessionId: audit.sessionId })
        else mirror?.write(e)
        if (e.type === 'session') {
          audit.model = e.model
          audit.sessionId = e.sessionId // takeover: codex resume <id>
          line(`▸ session ${e.sessionId} · ${e.model ?? 'default model'}`)
          bus.emit('job.started', {
            provider: 'codex',
            data: { scheduleId: s.id, name: s.name, sessionId: e.sessionId, model: e.model },
          })
        } else if (e.type === 'assistant') {
          line(e.text)
          if (!s.name && !audit.autoTitle && e.text.trim()) {
            audit.autoTitle = e.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 64)
            setResult.run(JSON.stringify(audit), s.id)
          }
        }
        else if (e.type === 'tool_use') line(`⏺ ${e.name}`)
        else if (e.type === 'tool_result' && !e.ok) line('  ⎿ tool failed')
        else if (e.type === 'tokens') audit.tokens = { in: e.input, out: e.output }
        else if (e.type === 'error') line(`✗ ${e.message}`)
      },
    })
    activeBrokers.set(s.id, job) // the handle answers asks like a broker would
    setStatus.run('running', Date.now(), JSON.stringify(audit), s.id)
    job.done.then(async (r) => {
      detachBroker(s.id)
      const diff = await finalizeDiff(s, spec, audit, cp, base, logFile)
      const denials = [...new Set([...(r.denials ?? []), ...(audit.denied ?? [])])]
      delete audit.pendingAsk
      // codex reports tokens, never dollars — estimate from list prices so
      // role budget caps and cost rollups see codex work instead of $0
      audit.costUsd = estimateCodexCostUsd(audit.model ?? spec.model, audit.tokens)
      if (audit.costUsd != null) audit.costEstimated = true
      audit.turns = r.turns
      audit.stopReason = r.stopReason
      audit.diff = diff
      audit.denials = denials
      audit.outcome = runOutcome(r.ok, denials, diff)
      line(`\n— ${audit.outcome}${diff ? ` · ${diff.files} files +${diff.insertions} −${diff.deletions}` : ''}${denials.length ? ` · denied: ${denials.join(', ')}` : ''} —`)
      log.end()
      native.end()
      bus.emit(r.ok ? 'job.done' : 'job.failed', {
        provider: 'codex',
        data: {
          scheduleId: s.id, name: s.name, ok: r.ok, outcome: audit.outcome,
          costUsd: audit.costUsd ?? null, turns: r.turns ?? null, diff, denials,
          stopReason: r.stopReason ?? null, tokens: audit.tokens ?? null,
        },
      })
      if (mirror) {
        await mirror.preType(audit.sessionId ? `codex resume ${audit.sessionId}` : 'codex resume --last')
        mirror.close()
      }
      finish(s, r.ok ? 'done' : 'error',
        JSON.stringify({ ...audit, exitCode: r.code, outputTail: (r.result || '').slice(-1500) }))
    }).catch((e) => {
      detachBroker(s.id)
      try { mirror?.close() } catch {}
      try { setStatus.run('error', Date.now(), JSON.stringify({ ...audit, internalError: e.message }), s.id) } catch {}
    })
  }

  // headless command per agent; all run fine under tmux or plain spawn
  function agentCommand(spec) {
    if (spec.agent === 'codex') {
      return ['codex', 'exec', '--sandbox', 'workspace-write',
        ...(spec.model ? ['-m', spec.model] : []),
        ...(spec.effort ? ['-c', `model_reasoning_effort="${spec.effort}"`] : []),
        spec.prompt]
    }
    if (spec.agent === 'openclaw') {
      // one-shot turn through the user's own OpenClaw setup (gateway when
      // running); --json puts a structured result line in the run log.
      // A target agent is required — 'main' is OpenClaw's default id.
      return ['openclaw', 'agent', '--agent', spec.openclawAgent || 'main', '-m', spec.prompt, '--json',
        ...(spec.model ? ['--model', spec.model] : [])]
    }
    if (spec.agent === 'hermes') {
      // chat -q = non-interactive single query, -Q = final answer only (the
      // `claude -p` analog); --yolo only when the user opted into full auto
      return ['hermes', 'chat', '-q', spec.prompt, '-Q',
        ...(spec.model ? ['-m', spec.model] : []),
        ...(spec.fullAuto ? ['--yolo'] : [])]
    }
    if (spec.agent === 'opencode') {
      // run = the non-interactive mode; model is provider/model form
      // (e.g. openrouter/moonshotai/kimi-k3); --auto approves permissions
      // OpenCal patch: a scheduled run must not depend on the desktop app's
      // background service — --standalone starts a private server per run.
      return ['opencode', 'run', '--standalone',
        ...(spec.model ? ['-m', spec.model] : []),
        ...(spec.fullAuto ? ['--auto'] : []),
        spec.prompt]
    }
    // headless runs cannot answer permission prompts, so grant up front:
    // default lets the agent edit files; fullAuto also unblocks shell commands.
    // With a permission socket, whatever acceptEdits would deny becomes an
    // ask on the calendar instead (see the driver's broker/proxy).
    const perms = spec.fullAuto ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']
    return ['claude', '-p', spec.prompt,
      ...perms,
      ...(spec.permissionSocket && !spec.fullAuto ? [
        '--permission-prompt-tool', 'mcp__acal__approve',
        '--mcp-config', JSON.stringify({
          mcpServers: { acal: { command: process.execPath, args: [process.argv[1], 'permission-proxy', spec.permissionSocket] } },
        }),
      ] : []),
      // pin the session id so takeover resumes THIS conversation, not
      // whatever ran most recently in the same directory
      ...(spec.sessionId ? ['--session-id', spec.sessionId] : []),
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--effort', spec.effort] : [])]
  }

  function takeoverHint(spec) {
    if (spec.agent === 'codex') return 'codex resume --last'
    if (spec.agent === 'openclaw') return 'openclaw tui' // attaches the last session
    if (spec.agent === 'hermes') return 'hermes -c' // continue the latest session
    if (spec.agent === 'opencode') return 'opencode --continue'
    return spec.sessionId ? `claude --resume ${spec.sessionId}` : 'claude --continue'
  }

  // Final checkpoint + real patch for a finished driver run. Falls back to
  // numstat wherever the checkpoint bracket isn't available (non-git cwd,
  // repo with no commits yet).
  async function finalizeDiff(s, spec, audit, cp, base, logFile) {
    if (cp) {
      try {
        const fin = await checkpoint(spec.cwd, `jobs/${s.id}/final`)
        if (fin) {
          audit.checkpointFinal = fin.commit
          const d = await diffBetween(spec.cwd, cp.tree, fin.tree)
          audit.patchFile = logFile + '.patch'
          audit.patchTruncated = d.truncated
          writeFileSync(audit.patchFile, d.patch)
          return d.stat
        }
      } catch {}
    }
    return gitNumstat(spec.cwd, base)
  }

  // Watch a tmux job's exit file and finish the schedule when it lands.
  // Split out of fireClaudeTmux because the tmux session and exit file
  // OUTLIVE this process — after a restart, reapOrphans re-attaches this
  // watch instead of declaring the row dead.
  function watchTmuxExit(s, audit, startedAt) {
    const logFile = audit.logFile
    const exitFile = logFile + '.exit'
    const poll = setInterval(() => {
      if (existsSync(exitFile)) {
        clearInterval(poll)
        detachBroker(s.id)
        let code = NaN
        try { code = Number(readFileSync(exitFile, 'utf8').trim()) } catch {}
        gitNumstat(audit.cwd, audit.baseHead).then((diff) => {
          delete audit.pendingAsk
          audit.diff = diff
          audit.denials = audit.denied ?? []
          audit.outcome = runOutcome(code === 0, audit.denials, diff)
          let tail = ''
          try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch {}
          finish(s, code === 0 ? 'done' : 'error', JSON.stringify({ ...audit, exitCode: code, outputTail: tail }))
        }).catch((e) => {
          try { setStatus.run('error', Date.now(), JSON.stringify({ ...audit, internalError: e.message }), s.id) } catch {}
        })
      } else if (Date.now() - startedAt > audit.maxRuntimeMin * 60_000) {
        clearInterval(poll)
        detachBroker(s.id)
        execFile('tmux', ['kill-session', '-t', audit.tmuxSession], () => {})
        finish(s, 'error', JSON.stringify({ ...audit, exitCode: 'timeout', note: `killed after ${audit.maxRuntimeMin}min` }))
      }
    }, 5000)
    poll.unref?.()
  }

  async function fireClaudeTmux(s, spec, audit, logFile) {
    const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
    const session = `agentcal-${s.id.slice(0, 8)}`
    const exitFile = logFile + '.exit'
    audit.tmuxSession = session
    const base = await gitHead(spec.cwd)
    audit.baseHead = base // survives restarts: the reaper's diff needs it
    attachBroker(s, spec, audit) // claude jobs surface asks even under tmux
    writeFileSync(logFile, `# agentcalendar run ${s.id}\n# ${JSON.stringify(audit)}\n\n`)
    const inner = agentCommand(spec).map(shq).join(' ')
    // when the headless run ends, drop the session straight into the
    // interactive continuation: attaching later = you're in the conversation,
    // ready to approve or steer, no commands to type
    // exit code is captured INSIDE the group: `cmd | tee; echo $?` records
    // tee's status (always 0) and masked every agent failure as success
    const wrapped = `{ ${inner}; echo $? > ${shq(exitFile)}; } 2>&1 | tee -a ${shq(logFile)}; echo; echo '[agentcalendar] job finished, resuming interactively:'; ${takeoverHint(spec)}; exec zsh -i`
    execFile('tmux', ['new-session', '-d', '-s', session, '-c', spec.cwd, wrapped], (err) => {
      if (err) {
        detachBroker(s.id)
        return finish(s, 'error', JSON.stringify({ ...audit, spawnError: `tmux: ${err.message}` }))
      }
      setStatus.run('running', Date.now(), JSON.stringify(audit), s.id)
      watchTmuxExit(s, audit, Date.now())
    })
  }

  function fire(s) {
    if (s.action_type === 'claude') {
      return fireClaude(s).catch((e) => {
        try { setStatus.run('error', Date.now(), JSON.stringify({ internalError: e.message }), s.id) } catch {}
      })
    }
    setStatus.run('running', Date.now(), null, s.id)
    if (s.action_type === 'command') {
      execFile('/bin/zsh', ['-lc', s.action_value], { timeout: 15 * 60_000 }, (err, stdout, stderr) => {
        if (err) finish(s, 'error', `${err.message}\n${stderr}`.trim())
        else finish(s, 'done', stdout.trim().slice(-4000) || 'ok')
      })
    } else if (s.action_type === 'webhook') {
      fetch(s.action_value, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'schedule.trigger', schedule: { id: s.id, name: s.name }, ts: Date.now() }),
        signal: AbortSignal.timeout(15_000),
      })
        .then((r) => finish(s, r.ok ? 'done' : 'error', `HTTP ${r.status}`))
        .catch((e) => finish(s, 'error', e.message))
    } else {
      finish(s, 'error', `unknown action_type ${s.action_type}`)
    }
  }

  let lastProposalSweep = 0
  function tick() {
    const now = Date.now()
    // unanswered proposals rot out rather than piling up on the calendar
    if (hq && now - lastProposalSweep > 3_600_000) {
      lastProposalSweep = now
      try { hq.expireProposals() } catch {}
    }
    for (const s of db.prepare("SELECT * FROM schedules WHERE status = 'pending'").all()) {
      let fireAt = s.fire_at
      if (s.when_type === 'next_reset') {
        // keep the earliest reset seen; re-resolving after a rollover would chase forever
        const resolved = resolveNextReset(s.when_value)
        fireAt = fireAt == null ? resolved : Math.min(fireAt, resolved)
        if (fireAt !== s.fire_at) setFireAt.run(fireAt, s.id)
      }
      if (fireAt == null || fireAt > now) continue
      if (now - fireAt > MISS_MS && s.when_type !== 'daily' && s.when_type !== 'cron') {
        setStatus.run('expired', now, 'missed fire window by >60min (agentcal was not running)', s.id)
        continue
      }
      // claim atomically before firing: several instances can share one db
      // (extra ports, scratch copies) and each runs this ticker — only the
      // one that flips pending→running gets to execute the job
      const claimed = db.prepare(
        "UPDATE schedules SET status = 'running' WHERE id = ? AND status = 'pending'"
      ).run(s.id).changes
      if (!claimed) continue
      // the block just flipped to running — tell the UI now, not when the
      // (possibly minutes-long) provision/run eventually reports back
      bus.emit('schedule.started', { data: { id: s.id, name: s.name, action: s.action_type } })
      fire(s)
    }
    // running cloud blocks: stream hub events (finishes on job.done/failed)
    // and keep the time cap as the backstop
    for (const s of db.prepare("SELECT * FROM schedules WHERE status = 'running'").all()) {
      let r = null
      try { r = JSON.parse(s.result) } catch {}
      if (!r?.cloud || !r.vmId) continue
      if (r.stopping && now - (r.stoppingAt ?? 0) < 120_000) continue
      if (r.machineId && r.jobId && !r.stopping) pollCloudJob(s, r).catch(() => {})
      if (r.stopAt && r.stopAt <= now) stopCloudRun(s, r, 'auto-stopped at time limit').catch(() => {})
    }
  }

  // Boot-time reaper: rows left 'running' by a previous process. Cloud rows
  // recover through tick() (their state lives in the DB and the hub). A tmux
  // row's job may well have survived us — or finished while we were down —
  // so re-attach the exit-file watch instead of declaring it dead. Anything
  // else ran in-process and died with the process: without this, one crash
  // mid-job left the row 'running' forever.
  function reapOrphans() {
    for (const s of db.prepare("SELECT * FROM schedules WHERE status = 'running'").all()) {
      let r = {}
      try { r = JSON.parse(s.result) ?? {} } catch {}
      if (r.cloud && r.vmId) continue // tick() streams events / enforces stopAt
      // only tmux-ENGINE rows (no executor field) can be re-watched: a driver
      // row's tmuxSession is just its mirror window — the engine died with us
      if (r.tmuxSession && r.logFile && !r.executor) {
        let alive = false
        try {
          execFileSync('tmux', ['has-session', '-t', r.tmuxSession], { timeout: 2000 })
          alive = true
        } catch {}
        if (alive || existsSync(r.logFile + '.exit')) {
          watchTmuxExit(s, r, s.fired_at ?? Date.now())
          continue
        }
      }
      setStatus.run('error', s.fired_at ?? Date.now(),
        JSON.stringify({ ...r, interrupted: 'agentcalendar restarted while this job was running' }), s.id)
    }
  }
  reapOrphans()
  // clean, week-old job worktrees go; dirty ones are never auto-deleted
  pruneWorktrees().catch(() => {})

  setInterval(tick, 15_000).unref()

  // named so internals (hqHandler's propose_job) can reuse the public create
  // path — proposals must go through the same validation the API does
  const api = {
    tick,
    list() {
      return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC LIMIT 100').all()
    },
    // `by` is the authorship context: absent = the human (direct create),
    // present = a running job proposing work. Agent-authored rows land as
    // 'proposed' unless the role's envelope covers them; the caps below are
    // the whole anti-runaway story and they live here, not in any prompt.
    create({ name, when, action, roleId = null, by = null, missionId = null }) {
      if (!when?.type || !['at', 'next_reset', 'daily', 'cron'].includes(when.type)) {
        throw new Error("when.type must be 'at', 'next_reset', 'daily' or 'cron'")
      }
      if (!action?.type || !['command', 'webhook', 'claude'].includes(action.type)) {
        throw new Error("action.type must be 'command', 'webhook' or 'claude'")
      }
      let parent = null
      if (by) {
        parent = db.prepare('SELECT * FROM schedules WHERE id = ?').get(by.scheduleId)
        if (!parent) throw new Error('unknown proposing job')
        if ((parent.depth ?? 0) + 1 > MAX_DEPTH) {
          throw new Error(`delegation depth limit reached (max ${MAX_DEPTH})`)
        }
        if (hq && hq.proposalsFrom(parent.id) >= MAX_FANOUT) {
          throw new Error(`this run already proposed ${MAX_FANOUT} jobs`)
        }
        // agents may only schedule agent work, never raw shell/webhooks
        if (action.type !== 'claude') throw new Error('agents may only propose claude jobs')
        // privilege non-escalation: inherit the parent's role, and never
        // grant a child more autonomy than the parent ran with
        let parentSpec = {}
        try { parentSpec = JSON.parse(parent.action_value) } catch {}
        roleId = parent.role_id ?? roleId
        const v = typeof action.value === 'object' ? action.value : JSON.parse(action.value)
        if (!parentSpec.fullAuto) v.fullAuto = false
        v.cloud = parentSpec.cloud ? v.cloud : undefined
        action = { ...action, value: v }
      }
      let fireAt = null
      let actionValue = action.value
      if (when.type === 'at') {
        fireAt = Date.parse(when.value)
        if (!Number.isFinite(fireAt)) throw new Error('when.value must be a parseable datetime')
      } else if (when.type === 'daily') {
        if (!/^\d{1,2}:\d{2}$/.test(when.value ?? '')) throw new Error("when.value must be 'HH:MM' for daily")
        fireAt = nextDaily(when.value)
      } else if (when.type === 'cron') {
        fireAt = nextCron(when.value) // validates the expression too
      }
      if (action.type === 'claude') {
        const spec = typeof action.value === 'object' ? action.value : JSON.parse(action.value)
        spec.agent = spec.agent ?? 'claude'
        if (!['claude', 'codex', 'openclaw', 'hermes', 'opencode'].includes(spec.agent)) {
          throw new Error("agent must be 'claude', 'codex', 'openclaw', 'hermes' or 'opencode'")
        }
        if (spec.cloud && !['claude', 'codex'].includes(spec.agent)) {
          throw new Error('cloud runs support Claude and Codex for now — run OpenClaw/Hermes jobs on this machine or a BYO runner')
        }
        // plan-first: the run is read-only until the plan is approved from the
        // calendar; implementing spawns a separate block
        if (spec.mode != null && spec.mode !== 'plan') delete spec.mode
        if (spec.mode === 'plan' && spec.agent !== 'claude') {
          throw new Error('plan-first runs are Claude-only for now')
        }
        // dry runs are explicit opt-in only (legacy rows/API callers) — plan
        // mode is the real preview path; everything else executes
        spec.dryRun = spec.dryRun === true
        if (spec.cloud) {
          if (!spec.prompt) throw new Error('cloud action needs {prompt}')
          if (!proKey()) throw new Error('cloud runs need a license key — run: agentcalendar login <ACAL-… key>')
          delete spec.cwd // the repo lives on the VM, not this machine
        } else {
          if (!spec.prompt || !spec.cwd) throw new Error('claude action needs {prompt, cwd}')
          spec.branch = gitBranch(spec.cwd) // context lock: skip if branch changed by fire time
        }
        actionValue = JSON.stringify(spec)
      } else if (!actionValue) {
        throw new Error('action.value required')
      }
      const id = randomUUID()
      const role = roleId && hq ? hq.getRole(roleId) : null
      if (roleId && !role) throw new Error('unknown role')
      // agent-authored work waits for a human unless the role's envelope
      // already covers it; a human-authored row is pending immediately
      const autoOk = by && role && hq.envelopeAllows(role, fireAt)
      const status = by && !autoOk ? 'proposed' : 'pending'
      db.prepare(
        `INSERT INTO schedules (id, name, when_type, when_value, action_type, action_value, fire_at, created_at,
                                status, role_id, parent_id, root_id, depth, mission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, name ?? null, when.type, when.value ?? null, action.type, actionValue, fireAt, Date.now(),
        status, roleId ?? null, parent?.id ?? null,
        parent ? (parent.root_id ?? parent.id) : null, parent ? (parent.depth ?? 0) + 1 : 0,
        missionId ?? (parent?.mission_id ?? role?.mission_id ?? null),
      )
      if (status === 'proposed') {
        bus.emit('job.proposed', {
          data: { id, name: name ?? null, roleId: roleId ?? null, fireAt, by: parent?.id ?? null },
        })
      } else if (fireAt != null && fireAt <= Date.now()) {
        // "start now": an at-schedule already due shouldn't wait for the next
        // 15s tick — kick one as soon as the create response is on the wire
        setTimeout(() => tick(), 20)
      }
      return this.list().find((x) => x.id === id)
    },
    // A proposal the human accepted becomes a normal pending block. Denying
    // records the reason so the roster shows what was turned down.
    approveProposal(id, { when = null } = {}) {
      const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'proposed'").get(id)
      if (!s) return null
      let fireAt = s.fire_at
      let whenType = s.when_type
      let whenValue = s.when_value
      if (when?.type) {
        if (when.type === 'at') {
          fireAt = Date.parse(when.value)
          if (!Number.isFinite(fireAt)) throw new Error('when.value must be a parseable datetime')
        } else if (when.type === 'daily') {
          fireAt = nextDaily(when.value)
        } else if (when.type === 'cron') {
          fireAt = nextCron(when.value)
        } else if (when.type === 'next_reset') {
          fireAt = resolveNextReset(when.value || 'claude')
        }
        whenType = when.type
        whenValue = when.value ?? null
      }
      db.prepare("UPDATE schedules SET status = 'pending', when_type = ?, when_value = ?, fire_at = ? WHERE id = ?")
        .run(whenType, whenValue, fireAt, id)
      bus.emit('job.approved', { data: { id, name: s.name, fireAt } })
      if (fireAt != null && fireAt <= Date.now()) setTimeout(() => tick(), 20)
      return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
    },
    denyProposal(id, reason = null) {
      const changed = db.prepare("UPDATE schedules SET status = 'cancelled', result = ? WHERE id = ? AND status = 'proposed'")
        .run(JSON.stringify({ denied: reason ?? 'not approved' }), id).changes
      if (changed) bus.emit('job.denied', { data: { id, reason } })
      return changed > 0
    },
    cancel(id) {
      return db.prepare("UPDATE schedules SET status = 'cancelled' WHERE id = ? AND status IN ('pending','proposed')").run(id).changes > 0
    },
    // stop a running cloud VM from the calendar (meters + finishes the block)
    async stopCloud(id) {
      const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'running'").get(id)
      if (!s) return null
      let r = null
      try { r = JSON.parse(s.result) } catch {}
      if (!r?.cloud || !r.vmId) return null
      const res = await stopCloudRun(s, r, 'stopped from calendar')
      return { ok: true, seconds: res.seconds ?? null }
    },
    // Take over a running cloud job: the runner stops the headless process
    // and turns the job's tmux window into `claude --resume`, so the browser
    // terminal (Join) becomes the live conversation. The block stays running —
    // the user is now driving — with the time cap extended to at least an
    // hour so the takeover isn't cut off mid-thought.
    async takeoverCloud(id) {
      const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'running'").get(id)
      if (!s) return null
      let r = null
      try { r = JSON.parse(s.result) } catch {}
      if (!r?.cloud || !r.machineId || !r.jobId || r.stopping || r.takenOver) return null
      cloudPolls.add(s.id) // hold the event poll off while the handoff is in flight
      try {
        const res = await machineRpc(r.machineId, 'job.handoff', { jobId: r.jobId })
        if (!res.ok || res.result?.ok === false) {
          throw new Error(res.result?.error || res.error || 'handoff failed')
        }
        const sessionId = res.result?.sessionId ?? null
        // re-read: a poll that raced us may have advanced lastSeq/sessionId
        let r2 = r
        try { r2 = JSON.parse(db.prepare('SELECT result FROM schedules WHERE id = ?').get(id)?.result) ?? r } catch {}
        const updated = {
          ...r2, takenOver: true, takenOverAt: Date.now(), sessionId: sessionId ?? r2.sessionId,
          stopAt: Math.max(r2.stopAt ?? 0, Date.now() + 60 * 60_000),
        }
        db.prepare('UPDATE schedules SET result = ? WHERE id = ?').run(JSON.stringify(updated), s.id)
        return {
          ok: true, sessionId: updated.sessionId, interactive: res.result?.interactive ?? false,
          joinUrl: r.joinUrl ?? null, credential: r.credential ?? null, stopAt: updated.stopAt,
        }
      } finally {
        cloudPolls.delete(s.id)
      }
    },
    // Answer a running job's pending permission ask (allow | deny) — works
    // for local runs (in-process broker) and cloud runs (job.answer RPC to
    // the machine's runner). Returns null when there's nothing to answer.
    async answer(id, askId, behavior, message) {
      // allow/deny/allow_always resolve permission asks; answer (+ message
      // text) resolves questions; plan_now/plan_reset/plan_refine resolve a
      // captured plan (implement spawns the executing block)
      const behaviors = ['allow', 'deny', 'answer', 'allow_always', 'plan_now', 'plan_reset', 'plan_refine']
      if (!behaviors.includes(behavior)) throw new Error(`behavior must be one of: ${behaviors.join(', ')}`)
      if (behavior === 'answer' && !String(message ?? '').trim()) throw new Error('answering a question needs message text')
      if (behavior === 'plan_refine' && !String(message ?? '').trim()) throw new Error('refining a plan needs feedback text')
      const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'running'").get(id)
      if (!s) return null
      let r = null
      try { r = JSON.parse(s.result) } catch {}
      // Plan decisions ride the deny channel either way — the plan approval is
      // hoisted OUT of the agent's turn: the planning run ends cleanly, and an
      // approved plan becomes its own calendar block (now, or at next reset —
      // "plan on today's tokens, build on tomorrow's").
      let planApproved = false
      let sendBehavior = behavior
      let sendMessage = message
      if (['plan_now', 'plan_reset', 'plan_refine'].includes(behavior)) {
        sendBehavior = 'deny'
        if (behavior === 'plan_refine') {
          sendMessage = `The user wants changes to this plan: ${message}\nRevise the plan and call ExitPlanMode again when it's ready.`
        } else {
          if (!r?.plan) throw new Error('no captured plan on this job')
          sendMessage = 'AgentCalendar captured your plan — the user approved it. Stop here; the implementation runs as a separate scheduled job.'
          planApproved = true
        }
      }
      const spawnFollowUp = () => {
        if (!planApproved) return null
        let spec = {}
        try { spec = JSON.parse(s.action_value) } catch {}
        return this.create({
          name: s.name ? `${s.name} — implement` : 'Implement plan',
          when: behavior === 'plan_now'
            ? { type: 'at', value: new Date().toISOString() }
            : { type: 'next_reset', value: 'claude' },
          action: {
            type: 'claude',
            value: {
              ...spec, mode: undefined, dryRun: false, planFrom: s.id,
              prompt: `Implement this approved plan:\n\n${r.plan}`,
            },
          },
        })
      }
      if (r?.cloud) {
        if (!r.machineId || !r.jobId) return null
        const res = await machineRpc(r.machineId, 'job.answer', { jobId: r.jobId, askId, behavior: sendBehavior, message: sendMessage })
        if (!res.ok || res.result?.ok === false) {
          throw new Error(res.result?.error || res.error || 'answer failed')
        }
        // optimistic clear so the amber flips now, not at the next event poll
        let r2 = r
        try { r2 = JSON.parse(db.prepare('SELECT result FROM schedules WHERE id = ?').get(id)?.result) ?? r } catch {}
        if (r2.pendingAsk?.id === askId) {
          delete r2.pendingAsk
          setResult.run(JSON.stringify(r2), s.id)
        }
        const follow = spawnFollowUp()
        return { ok: true, ...(follow ? { followUpId: follow.id } : {}) }
      }
      const broker = activeBrokers.get(id)
      if (!broker) return null
      if (!broker.answer(askId, sendBehavior, sendMessage)) throw new Error('no such ask — it may have timed out')
      const follow = spawnFollowUp()
      return { ok: true, ...(follow ? { followUpId: follow.id } : {}) }
    },
    // Move a pending job: drag-to-schedule. when = {type:'at'|'next_reset'|'daily', value}
    reschedule(id, when) {
      const s = db.prepare("SELECT * FROM schedules WHERE id = ? AND status = 'pending'").get(id)
      if (!s) return null
      let fireAt = null
      if (when.type === 'at') {
        fireAt = Date.parse(when.value)
        if (!Number.isFinite(fireAt)) throw new Error('when.value must be a parseable datetime')
      } else if (when.type === 'daily') {
        if (!/^\d{1,2}:\d{2}$/.test(when.value ?? '')) throw new Error("when.value must be 'HH:MM'")
        fireAt = nextDaily(when.value)
      } else if (when.type === 'next_reset') {
        fireAt = resolveNextReset(when.value || 'claude')
      } else if (when.type === 'cron') {
        fireAt = nextCron(when.value)
      } else {
        throw new Error('unsupported when.type')
      }
      db.prepare('UPDATE schedules SET when_type = ?, when_value = ?, fire_at = ? WHERE id = ?')
        .run(when.type, when.value ?? null, fireAt, id)
      bus.emit('schedule.moved', { data: { id, name: s.name, whenType: when.type, fireAt } })
      return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
    },
    // Resize a future job's time box: drag the block edge on the calendar.
    // maxRuntimeMin is the kill-timer the run is given when it fires.
    setTimeBox(id, minutes) {
      const m = Math.round(Number(minutes))
      if (!Number.isFinite(m) || m < 5 || m > 240) throw new Error('time box must be 5–240 minutes')
      const s = db.prepare(
        "SELECT * FROM schedules WHERE id = ? AND status IN ('pending', 'proposed') AND action_type = 'claude'"
      ).get(id)
      if (!s) return null
      let spec
      try {
        spec = JSON.parse(s.action_value)
      } catch {
        return null
      }
      spec.maxRuntimeMin = m
      db.prepare('UPDATE schedules SET action_value = ? WHERE id = ?').run(JSON.stringify(spec), id)
      bus.emit('schedule.moved', { data: { id, name: s.name, maxRuntimeMin: m } })
      return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
    },
  }
  return api
}
