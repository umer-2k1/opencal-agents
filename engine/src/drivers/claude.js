import { spawn } from 'node:child_process'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
// aliased: this file is bundle-concatenated with acal-runner.js, which
// imports unlinkSync under its own name (see agentcal-api/scripts/bundle-runner.mjs)
import { unlinkSync as unlinkSocket } from 'node:fs'
import { randomUUID } from 'node:crypto'

// Claude job driver. Drives the official `claude` CLI headless over the
// stream-json protocol (both directions) and turns its output into a small,
// normalized event vocabulary the scheduler + calendar can consume.
//
// Why stream-json instead of parsing `claude -p` text (what schedules.js does
// today): the prompt goes over stdin as a JSON message — never argv, so no
// shell quoting or ARG_MAX limits — and completion is a real `result` event,
// not a guess from the process exiting. (Verified against claude 2.1.211.)
//
// Normalized events (onEvent):
//   {type:'session',    sessionId, model}
//   {type:'assistant',  text}                        one settled text block
//   {type:'thinking',   tokens}                       progress pulse
//   {type:'tool_use',   id, name}                     agent started a tool
//   {type:'tool_result',id, ok}                       tool finished
//   {type:'tokens',     input, output}                cumulative usage so far
//   {type:'rate_limit', info}                         vendor snapshot in-stream
//   {type:'done',       ok, result, cost, turns, stopReason}
//   {type:'error',      message}                      driver-level failure
//
// Returns a handle: { done: Promise<result>, stop(), get sessionId() }.
// `done` resolves with {ok, result, cost, turns, stopReason, code} and never
// rejects — a crash surfaces as {ok:false, ...} plus an 'error' event.

const CLI = 'claude'

function argsFor(spec) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose', // required by stream-json output
  ]
  // headless runs can't answer prompts: acceptEdits lets the agent edit files;
  // autoReview runs the CLI's risk-tiered 'auto' mode (routine actions
  // proceed, risky ones still surface as asks — t3code's Auto rung);
  // bypassPermissions (fullAuto) also unblocks shell commands. mode 'plan'
  // makes the run read-only until ExitPlanMode — which lands on the broker as
  // a plan ask the calendar renders with Implement/Refine buttons.
  args.push('--permission-mode',
    spec.mode === 'plan' ? 'plan'
    : spec.fullAuto ? 'bypassPermissions'
    : spec.autoReview ? 'auto'
    : 'acceptEdits')
  // With a permission socket, the job gets two human-in-the-loop channels
  // through one MCP server (the proxy below, talking to the broker over the
  // socket): permission asks (everything acceptEdits would silently deny
  // becomes an ask on the calendar) and ask_user (the agent can pose a
  // decision/question mid-run and wait for the answer). fullAuto keeps
  // ask_user but skips the permission gate entirely.
  // CONTRACT: process.argv[1] must dispatch `permission-proxy <socket>` —
  // bin/main.js and the sprite runner bundle both do (same deal as `render`).
  // An embedder whose entry does NOT dispatch `permission-proxy` would
  // re-run its whole program for every tool call — a fork bomb. The child is
  // marked, and a marked process refuses to wire the proxy at all, so a
  // contract violation costs one broken job instead of the machine.
  if (spec.permissionSocket && process.env.ACAL_PROXY_CHILD !== '1') {
    if (!spec.fullAuto || spec.mode === 'plan') args.push('--permission-prompt-tool', 'mcp__acal__approve')
    // pre-allow the HQ tools: needing permission to ask a question, file a
    // report or propose follow-up work would defeat the point
    args.push('--allowedTools', 'mcp__acal__ask_user,mcp__acal__send_message,mcp__acal__propose_job,mcp__acal__update_notes')
    args.push('--mcp-config', JSON.stringify({
      mcpServers: {
        acal: {
          command: process.execPath,
          args: [process.argv[1], 'permission-proxy', spec.permissionSocket],
          env: { ACAL_PROXY_CHILD: '1' },
        },
      },
    }))
  }
  // pin the session so a later --resume takeover continues THIS conversation
  if (spec.sessionId) args.push('--session-id', spec.sessionId)
  if (spec.model) args.push('--model', spec.model)
  if (spec.effort) args.push('--effort', spec.effort)
  return args
}

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('')
  }
  return ''
}

export function runClaudeJob(spec) {
  const onEvent = spec.onEvent ?? (() => {})
  // native passthrough: every protocol message as parsed, before any
  // normalization — diffing this stream against the normalized events is how
  // a CLI/protocol drift gets debugged
  const onRaw = spec.onRaw ?? null
  const env = { ...process.env, NPM_CONFIG_LOGLEVEL: 'error' }
  // subscription users get billed pay-as-you-go if this leaks through; the CLI
  // owns its own OAuth login, so an API key here is never what we want.
  delete env.ANTHROPIC_API_KEY
  // if agentcal itself was launched from inside a Claude Code session
  // (dogfooding), don't let the nested CLI inherit that session's identity
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  // spawn() changes cwd but leaves PWD inherited from the app.
  env.PWD = spec.cwd

  const child = spawn(CLI, argsFor(spec), {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group, so killing -pid reaps child MCP servers
  })

  const state = { sessionId: null, settled: false, tokens: { input: 0, output: 0 } }
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  const settle = (result) => {
    if (state.settled) return
    state.settled = true
    clearTimeout(killer)
    onEvent({ type: 'done', ...result })
    resolveDone(result)
  }

  const handleLine = (line) => {
    let o
    try { o = JSON.parse(line) } catch { return }
    onRaw?.({ dir: 'in', msg: o })
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init') {
          state.sessionId = o.session_id
          onEvent({ type: 'session', sessionId: o.session_id, model: o.model })
        } else if (o.subtype === 'thinking_tokens') {
          onEvent({ type: 'thinking', tokens: o.estimated_tokens })
        }
        break
      case 'assistant': {
        const msg = o.message ?? {}
        const text = firstText(msg.content)
        if (text.trim()) onEvent({ type: 'assistant', text })
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b.type === 'tool_use') onEvent({ type: 'tool_use', id: b.id, name: b.name })
        }
        if (msg.usage) {
          state.tokens = {
            input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
            output: msg.usage.output_tokens || 0,
          }
          onEvent({ type: 'tokens', ...state.tokens })
        }
        break
      }
      case 'user':
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (b.type === 'tool_result') {
            onEvent({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error })
          }
        }
        break
      case 'rate_limit_event':
        if (o.rate_limit_info) onEvent({ type: 'rate_limit', info: o.rate_limit_info })
        break
      case 'result':
        settle({
          ok: o.is_error !== true,
          result: o.result ?? '',
          cost: o.total_cost_usd ?? null,
          turns: o.num_turns ?? null,
          stopReason: o.stop_reason ?? o.terminal_reason ?? null,
          // tools the run wanted but never got — the "looked done, did
          // nothing" tell. Vendor-reported, so it also catches denials that
          // never went through our broker (no socket, or acceptEdits refusals).
          denials: Array.isArray(o.permission_denials)
            ? [...new Set(o.permission_denials.map((d) => d.tool_name ?? d.tool ?? 'tool'))]
            : [],
          code: 0,
        })
        break
    }
  }

  // line-buffer stdout; tolerate chunk splits
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) handleLine(line)
    }
  })

  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 8192) stderr = stderr.slice(-8192) })

  child.on('error', (e) => {
    onEvent({ type: 'error', message: `spawn failed: ${e.message}` })
    settle({ ok: false, result: '', code: null, stopReason: 'spawn_error' })
  })

  child.on('close', (code) => {
    // a clean run settled on the `result` event; reaching close unsettled means
    // the CLI died before finishing (crash, kill, auth failure)
    if (!state.settled) {
      onEvent({ type: 'error', message: `claude exited ${code} before result${stderr ? `: ${stderr.trim().slice(-300)}` : ''}` })
      settle({ ok: false, result: '', code, stopReason: 'exit_before_result' })
    }
  })

  const killer = spec.maxRuntimeMs
    ? setTimeout(() => {
        onEvent({ type: 'error', message: `killed after ${Math.round(spec.maxRuntimeMs / 60000)}min` })
        stop()
        settle({ ok: false, result: '', code: null, stopReason: 'timeout' })
      }, spec.maxRuntimeMs)
    : null

  function stop() {
    try { process.kill(-child.pid, 'SIGTERM') } catch {
      try { child.kill('SIGTERM') } catch {}
    }
  }

  // deliver the prompt as a stream-json user message, then close stdin
  try {
    const promptMsg = { type: 'user', message: { role: 'user', content: spec.prompt } }
    child.stdin.write(JSON.stringify(promptMsg) + '\n')
    child.stdin.end()
    onRaw?.({ dir: 'out', msg: promptMsg })
  } catch (e) {
    onEvent({ type: 'error', message: `stdin write failed: ${e.message}` })
  }

  return {
    done,
    stop,
    get sessionId() { return state.sessionId },
  }
}

// --- permission broker + proxy -----------------------------------------------
// A headless job that hits a permission the mode doesn't cover shouldn't
// stall silently OR get blanket-denied — it should ask the user. The pieces:
//   broker  (this process): net server on a per-job socket; turns asks into
//           events the calendar can show, and answers into socket replies.
//   proxy   (child of the claude CLI): a minimal MCP stdio server exposing
//           one `approve` tool; forwards each call over the socket and waits.
// An unanswered ask denies after timeoutMs with a note telling the agent to
// finish what it can — the job keeps moving and the denial marks the outcome.

export function permissionSocketPath(dir, id) {
  const tag = String(id).replace(/[^\w-]/g, '').slice(0, 8)
  if (process.platform === 'win32') return `\\\\.\\pipe\\acal-perm-${tag}`
  return `${dir}/perm-${tag}.sock`
}

// one human-readable line for an ask — what the calendar block and the toast show
export function askSummary(ask) {
  const input = ask.input ?? {}
  if (typeof input.question === 'string') return input.question.slice(0, 300)
  if (typeof input.command === 'string') return input.command.slice(0, 200)
  if (typeof input.url === 'string') return input.url.slice(0, 200)
  const text = JSON.stringify(input)
  return text === '{}' ? (ask.tool ?? 'tool') : text.slice(0, 200)
}

const DENY_TIMEOUT_NOTE =
  'AgentCalendar: nobody answered this permission request in time. Skip this action and finish what you can without it.'
const QUESTION_TIMEOUT_NOTE =
  'AgentCalendar: nobody answered in time. Use your best judgment and continue.'

export function createPermissionBroker({ socketPath, onAsk = () => {}, onResolve = () => {}, onHq = null, timeoutMs = 15 * 60_000 }) {
  const pending = new Map() // askId -> { ask, finish }
  const sessionRules = new Set() // tools the user answered "always allow" for THIS job
  if (process.platform !== 'win32') { try { unlinkSocket(socketPath) } catch {} }
  const server = createNetServer((conn) => {
    conn.on('error', () => {})
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        // HQ tools (send_message / propose_job / update_notes): handled by
        // the host, answered immediately — they never park the agent
        if (msg.t === 'hq') {
          const reply = (message) => {
            try { conn.write(JSON.stringify({ t: 'answer', id: msg.id, message }) + '\n') } catch {}
          }
          if (!onHq) return reply('AgentCalendar: not available for this run.')
          Promise.resolve()
            .then(() => onHq(msg.tool, msg.input ?? {}))
            .then((r) => reply(typeof r === 'string' ? r : 'ok'))
            .catch((e) => reply(`AgentCalendar could not do that: ${e.message}`))
          continue
        }
        if (msg.t !== 'ask') continue
        const askId = msg.id || randomUUID()
        // kind 'permission' (approve a tool use → allow/deny) or 'question'
        // (ask_user → free-text answer, optional choices)
        const kind = msg.kind === 'question' ? 'question' : 'permission'
        const ask = { id: askId, kind, tool: msg.tool ?? 'tool', input: msg.input ?? {}, at: Date.now() }
        // an earlier "always allow" for this tool auto-answers without asking
        // anyone — resolved with source 'session-rule' so the audit shows it
        if (kind === 'permission' && sessionRules.has(ask.tool)) {
          try { conn.write(JSON.stringify({ t: 'answer', id: askId, behavior: 'allow' }) + '\n') } catch {}
          onResolve({ ...ask, behavior: 'allow', source: 'session-rule' })
          continue
        }
        const finish = (behavior, message, source, extra = {}) => {
          if (!pending.delete(askId)) return
          clearTimeout(timer)
          try { conn.write(JSON.stringify({ t: 'answer', id: askId, behavior, message, ...(extra.always ? { always: true } : {}) }) + '\n') } catch {}
          onResolve({ ...ask, behavior, source, ...(extra.always ? { always: true } : {}) })
        }
        // an unanswered question is guidance, not a denial — it must not
        // mark the run blocked the way an unanswered permission does
        const timer = setTimeout(() => (kind === 'question'
          ? finish('answer', QUESTION_TIMEOUT_NOTE, 'timeout')
          : finish('deny', DENY_TIMEOUT_NOTE, 'timeout')), timeoutMs)
        timer.unref?.()
        pending.set(askId, { ask, finish })
        onAsk(ask)
      }
    })
  })
  server.on('error', () => {})
  server.listen(socketPath)
  return {
    socketPath,
    get pending() { return [...pending.values()].map((p) => p.ask) },
    answer(askId, behavior, message) {
      const p = pending.get(askId)
      if (!p) return false
      const valid = p.ask.kind === 'question' ? ['answer'] : ['allow', 'deny', 'allow_always']
      if (!valid.includes(behavior)) return false
      if (behavior === 'allow_always') {
        // remember for the rest of this job; the proxy also forwards claude's
        // own suggested permission rules so the CLI stops asking at its layer
        sessionRules.add(p.ask.tool)
        p.finish('allow', message, 'user', { always: true })
      } else {
        p.finish(behavior, message, 'user')
      }
      return true
    },
    close() {
      for (const p of [...pending.values()]) {
        if (p.ask.kind === 'question') p.finish('answer', 'AgentCalendar: the job is ending — wrap up.', 'shutdown')
        else p.finish('deny', 'AgentCalendar: the job ended', 'shutdown')
      }
      try { server.close() } catch {}
      if (process.platform !== 'win32') { try { unlinkSocket(socketPath) } catch {} }
    },
  }
}

// `permission-proxy <socket>` mode: the MCP server the claude CLI spawns for
// --permission-prompt-tool. stdout is the MCP channel — never console.log here.
export function runPermissionProxy(socketPath) {
  // belt and braces with the ACAL_PROXY_CHILD env the driver sets: if this
  // process was started as the proxy, nothing downstream may spawn jobs
  process.env.ACAL_PROXY_CHILD = '1'
  const waiting = new Map() // askId -> resolve
  const conn = netConnect(socketPath)
  const dead = () => {
    for (const resolve of waiting.values()) {
      resolve({ behavior: 'deny', message: 'AgentCalendar: permission broker unavailable — skip this action' })
    }
    waiting.clear()
  }
  conn.on('error', dead)
  conn.on('close', dead)
  let connBuf = ''
  conn.on('data', (chunk) => {
    connBuf += chunk
    let nl
    while ((nl = connBuf.indexOf('\n')) !== -1) {
      const line = connBuf.slice(0, nl)
      connBuf = connBuf.slice(nl + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.t === 'answer') {
        waiting.get(msg.id)?.(msg)
        waiting.delete(msg.id)
      }
    }
  })

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const handle = async (msg) => {
    if (msg.method === 'initialize') {
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentcal-permissions', version: '1' },
        },
      })
    }
    if (msg.method === 'tools/list') {
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: [{
            name: 'approve',
            description: 'Ask the AgentCalendar user whether a tool use is allowed',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
              required: ['tool_name', 'input'],
            },
          }, {
            name: 'ask_user',
            description: 'Ask the human who scheduled this job a question and wait for their answer. Use this whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.',
            inputSchema: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question, with enough context to answer from a phone' },
                choices: { type: 'array', items: { type: 'string' }, description: 'Optional 2-5 suggested answers, shown as one-tap buttons' },
              },
              required: ['question'],
            },
          }, {
            name: 'send_message',
            description: "Send a message to the owner's inbox. Use for reports, findings and status the owner should read but does not need to answer right now — it does NOT block your run. Use ask_user instead when you need an answer to continue.",
            inputSchema: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'One line, like an email subject' },
                body: { type: 'string', description: 'The detail, in markdown' },
                kind: { type: 'string', enum: ['info', 'attention', 'report'], description: "'attention' flags it for a closer look; 'report' is routine output" },
              },
              required: ['subject', 'body'],
            },
          }, {
            name: 'propose_job',
            description: 'Propose a follow-up job on the calendar. It is a PROPOSAL: the owner approves it before it runs (unless they have pre-approved your role). Use for work that should happen later — a follow-up after a deploy, a recurring check you think is worth doing, or handing work to another time slot.',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short title for the calendar block' },
                prompt: { type: 'string', description: 'The full instruction for the future run — it will not remember this conversation' },
                when: { type: 'string', description: "'now', an ISO datetime, 'HH:MM' for daily, a 5-field cron expression, or 'next_reset'" },
                why: { type: 'string', description: 'One line: why this is worth doing (shown on the approval card)' },
              },
              required: ['name', 'prompt', 'when'],
            },
          }, {
            name: 'update_notes',
            description: 'Append to your role notes — the memory you carry into future runs of this role. Use for durable facts and conventions you learned (repo quirks, where things live, decisions made). Keep it short; the owner reviews it. Not for run-by-run logs.',
            inputSchema: {
              type: 'object',
              properties: { note: { type: 'string', description: 'What to remember, in a sentence or two' } },
              required: ['note'],
            },
          }],
        },
      })
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      const askId = randomUUID()
      const isQuestion = name === 'ask_user'
      // HQ tools: fire-and-forget over the same socket. They don't block the
      // run (unlike an ask) — the broker records them and answers instantly
      // so an offline/unsupported host can never stall the agent.
      if (name === 'send_message' || name === 'propose_job' || name === 'update_notes') {
        const reply = await new Promise((resolve) => {
          waiting.set(askId, resolve)
          if (conn.destroyed) return dead()
          try { conn.write(JSON.stringify({ t: 'hq', id: askId, tool: name, input: args }) + '\n') } catch { dead() }
          // never hang the agent on an HQ tool
          setTimeout(() => {
            if (waiting.delete(askId)) resolve({ message: 'AgentCalendar did not confirm — continue your work.' })
          }, 20_000).unref?.()
        })
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: reply.message ?? 'ok' }] } })
      }
      // the CLI may include its own suggested permission rules; on "always
      // allow" we hand them straight back as updatedPermissions — claude then
      // stops asking at its own layer, no invented rule syntax needed
      const suggestions = Array.isArray(args.permission_suggestions) ? args.permission_suggestions
        : Array.isArray(args.suggestions) ? args.suggestions : null
      const answer = await new Promise((resolve) => {
        waiting.set(askId, resolve)
        if (conn.destroyed) return dead()
        const ask = isQuestion
          ? { t: 'ask', id: askId, kind: 'question', tool: 'ask_user', input: { question: args.question, choices: args.choices } }
          : { t: 'ask', id: askId, tool: args.tool_name, input: args.input }
        try { conn.write(JSON.stringify(ask) + '\n') } catch { dead() }
      })
      // questions return the human's words verbatim; permission calls return
      // the JSON contract --permission-prompt-tool expects
      const text = isQuestion
        ? (answer.message || 'No answer was given — use your best judgment.')
        : JSON.stringify(answer.behavior === 'allow'
          ? {
              behavior: 'allow', updatedInput: args.input ?? {},
              ...(answer.always && suggestions ? { updatedPermissions: suggestions } : {}),
            }
          : { behavior: 'deny', message: answer.message || 'Denied from AgentCalendar' })
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
    }
    if (String(msg.method ?? '').startsWith('notifications/')) return
    if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }

  let inBuf = ''
  process.stdin.on('data', (chunk) => {
    inBuf += chunk
    let nl
    while ((nl = inBuf.indexOf('\n')) !== -1) {
      const line = inBuf.slice(0, nl)
      inBuf = inBuf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
