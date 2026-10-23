import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

export const provider = 'codex'

// rollout-2026-06-13T08-36-40-<uuid>.jsonl -> uuid
const FILE_KEY = /rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/

const titlesByRoot = new Map()

function titles(root) {
  if (!titlesByRoot.has(root)) {
    const map = new Map()
    try {
      const raw = readFileSync(join(root, 'session_index.jsonl'), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const o = JSON.parse(line)
          if (o.id && o.thread_name) map.set(o.id, o.thread_name)
        } catch {}
      }
    } catch {}
    titlesByRoot.set(root, map)
  }
  return titlesByRoot.get(root)
}

export function watchDirs(root) {
  const d = join(root, 'sessions')
  return existsSync(d) ? [d] : []
}

export function listFiles(root) {
  const out = []
  const sdir = join(root, 'sessions')
  if (!existsSync(sdir)) return out
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (e.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(sdir)
  return out
}

export function ingest(obj, file, root) {
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN
  if (!Number.isFinite(ts)) return null
  const sessionKey = FILE_KEY.exec(basename(file))?.[1] || basename(file, '.jsonl')
  const rec = { ts, sessionKey }
  if (obj.type === 'session_meta' && obj.payload) {
    if (obj.payload.cwd) rec.cwd = obj.payload.cwd
    const t = titles(root).get(obj.payload.id)
    if (t) rec.title = t
  } else if (obj.type === 'event_msg' && obj.payload?.type === 'token_count') {
    const u = obj.payload.info?.total_token_usage
    if (u) {
      // codex reports cumulative totals, not per-message deltas
      rec.tokensMode = 'set'
      rec.tokensIn = u.input_tokens || 0
      rec.tokensOut = u.output_tokens || 0
    }
    // vendor-confirmed rate-limit snapshot the CLI persists every turn
    const rl = obj.payload.rate_limits
    if (rl && (rl.limit_id == null || rl.limit_id === 'codex')) rec.rateLimits = rl
  } else if (obj.type === 'turn_context' && obj.payload?.model) {
    rec.model = obj.payload.model
  }
  return rec
}
