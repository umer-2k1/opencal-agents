import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// OpenCode (anomalyco/opencode) stores everything under the XDG data dir,
// ~/.local/share/opencode. Two storage generations in the wild:
//   current: SQLite opencode.db (Drizzle) — session(id, directory, title,
//     model JSON {id, providerID}, cost, tokens_*, time_* epoch-ms) and
//     message(id, session_id, time_created, data JSON). Non-stable install
//     channels write opencode-<channel>.db instead.
//   legacy: flat JSON under storage/ — gen2 storage/session/<projectID>/
//     <ses>.json + storage/message/<sessionID>/*.json; gen1 nested the same
//     files under storage/session/{info,message}/. Message JSON carries
//     {role, time:{created}, modelID, providerID, tokens:{input,output}}.
// We read the db read-only with a rowid cursor over message (ids are ULIDs,
// not integers — rowid is the monotonic thing); legacy files scan on a
// named max-timestamp cursor. No cron system, so no external jobs.
export const provider = 'opencode'
export const custom = true

function dbPath(root) {
  try {
    const names = readdirSync(root).filter((f) => /^opencode[\w.-]*\.db$/.test(f))
    if (names.includes('opencode.db')) return join(root, 'opencode.db')
    if (names.length) return join(root, names.sort()[0])
  } catch {}
  return null
}

export function available(root) {
  return !!dbPath(root) || existsSync(join(root, 'storage', 'session'))
}

export function watchPaths(root) {
  const db = dbPath(root)
  return [
    db ? db + '-wal' : null,
    db,
    join(root, 'storage', 'message'),
    join(root, 'storage', 'session'),
  ].filter((p) => p && existsSync(p))
}

let handle = null
let handlePath = null
function open(path) {
  if (!handle || handlePath !== path) {
    handle?.close?.()
    handle = new DatabaseSync(path, { readOnly: true })
    handlePath = path
  }
  return handle
}

function scanDb(path, ctx) {
  let db
  try {
    db = open(path)
  } catch {
    return 0
  }
  const sessionMeta = new Map()
  const metaFor = (sessionId) => {
    if (!sessionMeta.has(sessionId)) {
      try {
        sessionMeta.set(sessionId, db.prepare(
          `SELECT title, directory, tokens_input, tokens_output,
                  json_extract(model, '$.providerID') AS provider_id,
                  json_extract(model, '$.id') AS model_id
           FROM session WHERE id = ?`
        ).get(sessionId) ?? {})
      } catch {
        sessionMeta.set(sessionId, {})
      }
    }
    return sessionMeta.get(sessionId)
  }

  let rows
  try {
    rows = db.prepare(
      'SELECT rowid AS rid, session_id, time_created FROM message WHERE rowid > ? ORDER BY rowid LIMIT 5000'
    ).all(ctx.cursor)
  } catch {
    return 0
  }
  let last = ctx.cursor
  for (const row of rows) {
    last = row.rid
    const ts = Number(row.time_created)
    if (!Number.isFinite(ts)) continue
    const meta = metaFor(row.session_id)
    const rec = {
      ts,
      sessionKey: row.session_id,
      cwd: meta.directory ?? null,
      title: meta.title ? String(meta.title).slice(0, 120) : null,
      model: meta.model_id ? [meta.provider_id, meta.model_id].filter(Boolean).join('/') : null,
    }
    if (meta.tokens_input || meta.tokens_output) {
      rec.tokensMode = 'set'
      rec.tokensIn = meta.tokens_input ?? 0
      rec.tokensOut = meta.tokens_output ?? 0
    }
    ctx.emit(rec)
  }
  if (last !== ctx.cursor) ctx.setCursor(last)
  return rows.length
}

// legacy flat-JSON eras. Sessions are few; message files land newest-last,
// so an mtime cursor (with a rewrite-tolerance slack) keeps rescans cheap.
const LEGACY_SLACK = 60_000

function legacyMeta(root, sessionId) {
  // gen1 keeps info flat; gen2 nests it under a projectID dir we can't
  // derive from the session id, so probe both then glob
  const flat = join(root, 'storage', 'session', 'info', sessionId + '.json')
  const candidates = [flat]
  try {
    for (const dir of readdirSync(join(root, 'storage', 'session'))) {
      candidates.push(join(root, 'storage', 'session', dir, sessionId + '.json'))
    }
  } catch {}
  for (const file of candidates) {
    try {
      const info = JSON.parse(readFileSync(file, 'utf8'))
      return { title: info.title ?? null, cwd: info.directory ?? null }
    } catch {}
  }
  return {}
}

function scanLegacy(root, ctx) {
  const cursorTs = ctx.stateGet('legacy')
  let maxTs = cursorTs
  let n = 0
  for (const base of [join(root, 'storage', 'message'), join(root, 'storage', 'session', 'message')]) {
    let sessions
    try {
      sessions = readdirSync(base)
    } catch {
      continue
    }
    for (const sessionId of sessions) {
      const dir = join(base, sessionId)
      let files
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      } catch {
        continue
      }
      let meta = null
      for (const f of files) {
        const file = join(dir, f)
        try {
          if (statSync(file).mtimeMs <= cursorTs - LEGACY_SLACK) continue
          const msg = JSON.parse(readFileSync(file, 'utf8'))
          const ts = Number(msg.time?.created)
          if (!Number.isFinite(ts) || ts <= cursorTs) continue
          meta ??= legacyMeta(root, sessionId)
          const rec = { ts, sessionKey: sessionId, cwd: meta.cwd ?? null, title: meta.title }
          if (msg.modelID) rec.model = [msg.providerID, msg.modelID].filter(Boolean).join('/')
          if (msg.role === 'assistant' && (msg.tokens?.input || msg.tokens?.output)) {
            rec.tokensMode = 'add'
            rec.tokensIn = msg.tokens.input ?? 0
            rec.tokensOut = msg.tokens.output ?? 0
          }
          ctx.emit(rec)
          if (ts > maxTs) maxTs = ts
          n++
        } catch {}
      }
    }
  }
  if (maxTs !== cursorTs) ctx.stateSet('legacy', maxTs)
  return n
}

export function scan(root, ctx) {
  const db = dbPath(root)
  if (db) return scanDb(db, ctx)
  return scanLegacy(root, ctx)
}
