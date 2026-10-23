import { readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

export const provider = 'claude'

export function watchDirs(root) {
  const d = join(root, 'projects')
  return existsSync(d) ? [d] : []
}

export function listFiles(root) {
  const out = []
  const pdir = join(root, 'projects')
  if (!existsSync(pdir)) return out
  for (const dir of readdirSync(pdir)) {
    const dp = join(pdir, dir)
    let entries
    try {
      entries = readdirSync(dp)
    } catch {
      continue
    }
    for (const f of entries) if (f.endsWith('.jsonl')) out.push(join(dp, f))
  }
  return out
}

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const c of content) if (c.type === 'text' && c.text) return c.text
  }
  return null
}

// One transcript line -> normalized activity record (or null to ignore).
export function ingest(obj, file) {
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN
  if (!Number.isFinite(ts)) return null
  const sessionKey = obj.sessionId || basename(file, '.jsonl')
  const rec = { ts, sessionKey }
  if (obj.cwd) rec.cwd = obj.cwd
  if (obj.type === 'user' && !obj.isSidechain) {
    const text = firstText(obj.message?.content)
    if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) {
      rec.title = text.slice(0, 120).replace(/\s+/g, ' ').trim()
    }
  } else if (obj.type === 'assistant' && obj.message) {
    if (obj.message.model) rec.model = obj.message.model
    const u = obj.message.usage
    if (u) {
      rec.tokensMode = 'add'
      rec.tokensIn = u.input_tokens || 0
      rec.tokensOut = u.output_tokens || 0
    }
  }
  return rec
}
