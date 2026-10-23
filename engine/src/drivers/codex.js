import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// Codex job driver. Drives the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio) and turns
// the stream into the same normalized event vocabulary as drivers/claude.js,
// so the scheduler + calendar consume both identically.
//
// Why app-server instead of parsing `codex exec` text (what schedules.js did
// before): completion is a real `turn/completed` notification, the thread id
// comes back for `codex resume <id>` takeover, and approval requests arrive
// as in-process JSON-RPC server→client requests — no MCP proxy or unix
// socket needed, unlike claude. (Verified against codex-cli 0.144.4:
// initialize → thread/start → turn/start; the server never self-exits, so
// the process group is killed once the turn settles.)
//
// The thread is written to ~/.codex/sessions/** as a normal rollout file,
// which the codex collector already tails — driver runs land on the calendar
// (and their rate_limits blocks land in limit_snapshots) with no extra wiring.
//
// Normalized events (onEvent): session / assistant / thinking / tool_use /
// tool_result / tokens / rate_limit / done / error — see drivers/claude.js.
//
// Asks: approval requests surface through onAsk/onResolve using the broker's
// ask shape ({id, kind:'permission'|'question', tool, input, at}); the
// returned handle exposes answer(askId, behavior, message) and close() so
// the scheduler can register it wherever a permission broker would go.
// behavior 'allow'|'deny' answers permissions, 'answer' answers questions.
//
// Returns { done, stop, answer, close, get sessionId() }. `done` resolves
// {ok, result, cost, turns, stopReason, denials, code} and never rejects.

// CODEX_-prefixed module constants: this file is bundle-concatenated with
// drivers/claude.js (agentcal-api/scripts/bundle-runner.mjs), which declares
// CLI and the timeout notes under those names
const CODEX_CLI = 'codex'

const CODEX_DENY_TIMEOUT_NOTE =
  'AgentCalendar: nobody answered this permission request in time. Skip this action and finish what you can without it.'
const CODEX_QUESTION_TIMEOUT_NOTE = 'No answer was given — use your best judgment.'

// best-effort one-line input for askSummary(): command for shell approvals,
// reason/paths for patch approvals, question text for request_user_input
function askInputFor(method, params) {
  if (params?.command) return { command: String(params.command) }
  if (Array.isArray(params?.questions) && params.questions.length) {
    const q = params.questions[0]
    return {
      question: params.questions.map((x) => x.question ?? x.header).filter(Boolean).join(' · '),
      choices: Array.isArray(q.options) ? q.options.map((o) => o.label).slice(0, 5) : undefined,
    }
  }
  if (params?.reason) return { question: String(params.reason) }
  if (params?.grantRoot) return { command: `write access under ${params.grantRoot}` }
  return { tool: method }
}

export function runCodexJob(spec) {
  const onEvent = spec.onEvent ?? (() => {})
  const onAsk = spec.onAsk ?? (() => {})
  const onResolve = spec.onResolve ?? (() => {})
  // native passthrough, both directions — see drivers/claude.js
  const onRaw = spec.onRaw ?? null
  const askTimeoutMs = spec.askTimeoutMs ?? 15 * 60_000

  const env = { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' }
  // same deal as ANTHROPIC_API_KEY in the claude driver: the CLI owns its own
  // ChatGPT login, and a leaked API key silently flips billing to pay-as-you-go
  delete env.OPENAI_API_KEY

  const child = spawn(CODEX_CLI, ['app-server'], {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group: killing -pid reaps the MCP servers it spawns
  })

  const state = {
    sessionId: null,
    settled: false,
    lastText: '',
    turns: 0,
    denials: new Set(),
    sessionRules: new Set(), // tools the user answered "always allow" for this job
  }
  let nextId = 1
  const rpcPending = new Map() // request id -> {resolve, reject}
  const asks = new Map() // askId -> {ask, finish}
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  const send = (obj) => {
    try { child.stdin.write(JSON.stringify(obj) + '\n') } catch {}
    onRaw?.({ dir: 'out', msg: obj })
  }
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    rpcPending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

  const settle = (result) => {
    if (state.settled) return
    state.settled = true
    clearTimeout(killer)
    for (const a of [...asks.values()]) {
      if (a.ask.kind === 'question') a.finish('answer', 'AgentCalendar: the job is ending — wrap up.', 'shutdown')
      else a.finish('deny', 'AgentCalendar: the job ended', 'shutdown')
    }
    for (const p of rpcPending.values()) p.reject(new Error('job settled'))
    rpcPending.clear()
    const denials = [...state.denials]
    onEvent({ type: 'done', ...result, denials })
    resolveDone({ ...result, denials })
    stop() // the app-server never exits on its own
  }

  // server→client approval request. kind 'permission' unless it's
  // request_user_input; the reply shape depends on the method generation
  // (v2 item/* take accept/decline, legacy take approved/denied).
  const handleServerRequest = (msg) => {
    const method = msg.method
    const params = msg.params ?? {}
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
    const isQuestion = method === 'item/tool/requestUserInput'
    const tool = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval' ? 'edit'
      : isQuestion ? 'ask_user'
      : method === 'item/permissions/requestApproval' ? 'permissions'
      : 'shell'
    // fullAuto never asks (danger-full-access + approvalPolicy never), but if
    // one slips through, waving it on matches bypassPermissions semantics
    if (spec.fullAuto && !isQuestion) {
      return send({ jsonrpc: '2.0', id: msg.id, result: { decision: legacy ? 'approved' : 'accept' } })
    }
    // an earlier "always allow" for this tool auto-answers; resolved with
    // source 'session-rule' so the audit/mirror still show it happened
    if (!isQuestion && state.sessionRules.has(tool)) {
      send({ jsonrpc: '2.0', id: msg.id, result: { decision: legacy ? 'approved' : 'accept' } })
      return onResolve({ id: randomUUID(), kind: 'permission', tool, input: askInputFor(method, params), at: Date.now(), behavior: 'allow', source: 'session-rule' })
    }
    const askId = randomUUID()
    const ask = { id: askId, kind: isQuestion ? 'question' : 'permission', tool, input: askInputFor(method, params), at: Date.now() }
    const finish = (behavior, message, source) => {
      if (!asks.delete(askId)) return
      clearTimeout(timer)
      if (isQuestion) {
        const answers = {}
        for (const q of Array.isArray(params.questions) ? params.questions : []) {
          answers[q.id] = { answers: [message || CODEX_QUESTION_TIMEOUT_NOTE] }
        }
        send({ jsonrpc: '2.0', id: msg.id, result: { answers } })
      } else {
        if (behavior === 'deny') state.denials.add(ask.input.command?.slice(0, 80) ?? tool)
        send({ jsonrpc: '2.0', id: msg.id, result: { decision: behavior === 'allow' ? (legacy ? 'approved' : 'accept') : (legacy ? 'denied' : 'decline') } })
      }
      onResolve({ ...ask, behavior, message, source })
    }
    const timer = setTimeout(() => (isQuestion
      ? finish('answer', CODEX_QUESTION_TIMEOUT_NOTE, 'timeout')
      : finish('deny', CODEX_DENY_TIMEOUT_NOTE, 'timeout')), askTimeoutMs)
    timer.unref?.()
    asks.set(askId, { ask, finish })
    onAsk(ask)
  }

  const handleNotification = (msg) => {
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'item/started': {
        const item = p.item ?? {}
        if (item.type === 'commandExecution') {
          onEvent({ type: 'tool_use', id: item.id, name: String(item.command ?? 'shell').slice(0, 80) })
        } else if (item.type === 'fileChange') {
          onEvent({ type: 'tool_use', id: item.id, name: 'edit' })
        } else if (item.type === 'mcpToolCall') {
          onEvent({ type: 'tool_use', id: item.id, name: item.tool ?? item.name ?? 'mcp' })
        } else if (item.type === 'webSearch') {
          onEvent({ type: 'tool_use', id: item.id, name: 'web_search' })
        }
        break
      }
      case 'item/completed': {
        const item = p.item ?? {}
        if (item.type === 'agentMessage') {
          if (item.text?.trim()) {
            state.lastText = item.text
            onEvent({ type: 'assistant', text: item.text })
          }
        } else if (item.type === 'commandExecution') {
          onEvent({ type: 'tool_result', id: item.id, ok: item.status !== 'failed' && item.status !== 'declined' })
        } else if (item.type === 'fileChange') {
          onEvent({ type: 'tool_result', id: item.id, ok: item.status !== 'failed' && item.status !== 'declined' })
        } else if (item.type === 'mcpToolCall') {
          onEvent({ type: 'tool_result', id: item.id, ok: item.status !== 'failed' })
        } else if (item.type === 'reasoning') {
          onEvent({ type: 'thinking', tokens: null })
        }
        break
      }
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage?.total
        if (t) onEvent({ type: 'tokens', input: t.inputTokens ?? 0, output: t.outputTokens ?? 0 })
        break
      }
      case 'account/rateLimits/updated':
        if (p.rateLimits) onEvent({ type: 'rate_limit', info: p.rateLimits })
        break
      case 'turn/started':
        state.turns += 1
        break
      case 'turn/completed': {
        const turn = p.turn ?? {}
        const ok = turn.status === 'completed'
        settle({
          ok,
          result: state.lastText,
          cost: null, // codex reports tokens, not dollars
          turns: state.turns || null,
          stopReason: ok ? null : (turn.error?.message ?? turn.status ?? 'failed'),
          code: 0,
        })
        break
      }
      case 'error':
        if (p.message) onEvent({ type: 'error', message: p.message })
        break
    }
  }

  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      onRaw?.({ dir: 'in', msg })
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = rpcPending.get(msg.id)
        if (p) {
          rpcPending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
      } else if (msg.id !== undefined && msg.method) {
        handleServerRequest(msg)
      } else if (msg.method) {
        handleNotification(msg)
      }
    }
  })

  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 8192) stderr = stderr.slice(-8192) })

  child.on('error', (e) => {
    onEvent({ type: 'error', message: `spawn failed: ${e.message}` })
    settle({ ok: false, result: '', code: null, stopReason: 'spawn_error' })
  })

  child.on('close', (code) => {
    if (!state.settled) {
      onEvent({ type: 'error', message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ''}` })
      settle({ ok: false, result: state.lastText, code, stopReason: 'exit_before_result' })
    }
  })

  const killer = spec.maxRuntimeMs
    ? setTimeout(() => {
        onEvent({ type: 'error', message: `killed after ${Math.round(spec.maxRuntimeMs / 60000)}min` })
        settle({ ok: false, result: state.lastText, code: null, stopReason: 'timeout' })
      }, spec.maxRuntimeMs)
    : null

  function stop() {
    try { process.kill(-child.pid, 'SIGTERM') } catch {
      try { child.kill('SIGTERM') } catch {}
    }
  }

  // handshake + job kickoff; any refusal (bad auth, bad cwd, unknown model)
  // surfaces as a driver-level failure instead of a hang
  ;(async () => {
    try {
      await request('initialize', { clientInfo: { name: 'agentcalendar', version: '1' } })
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      const started = await request('thread/start', {
        cwd: spec.cwd,
        model: spec.model || null,
        sandbox: spec.fullAuto ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: spec.fullAuto ? 'never' : 'on-request',
        // autoReview routes approvals through codex's own risk-based reviewer
        // subagent (t3code's Auto rung) instead of asking the human for every
        // routine command; whatever it escalates still arrives as an ask.
        // Threads are fresh per job, so no stickiness concern across modes.
        ...(spec.autoReview && !spec.fullAuto ? { approvalsReviewer: 'auto_review' } : {}),
        ephemeral: false,
      })
      state.sessionId = started?.thread?.id ?? null
      onEvent({ type: 'session', sessionId: state.sessionId, model: started?.model ?? spec.model ?? null })
      await request('turn/start', {
        threadId: state.sessionId,
        input: [{ type: 'text', text: spec.prompt }],
        ...(spec.effort ? { effort: spec.effort } : {}),
      })
      // completion arrives as the turn/completed notification, not this response
    } catch (e) {
      if (!state.settled) {
        onEvent({ type: 'error', message: e.message })
        settle({ ok: false, result: '', code: null, stopReason: 'rpc_error' })
      }
    }
  })()

  return {
    done,
    stop,
    // broker-compatible surface so the scheduler can register this handle
    // where a claude job would register its permission broker
    answer(askId, behavior, message) {
      const a = asks.get(askId)
      if (!a) return false
      const valid = a.ask.kind === 'question' ? ['answer'] : ['allow', 'deny', 'allow_always']
      if (!valid.includes(behavior)) return false
      if (behavior === 'allow_always') {
        state.sessionRules.add(a.ask.tool)
        a.finish('allow', message, 'user')
      } else {
        a.finish(behavior, message, 'user')
      }
      return true
    },
    close() {
      if (!state.settled) stop()
    },
    get pending() { return [...asks.values()].map((a) => a.ask) },
    get sessionId() { return state.sessionId },
  }
}
