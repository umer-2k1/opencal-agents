import { watch, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as claude from './claude.js'
import * as codex from './codex.js'
import * as hermes from './hermes.js'
import * as openclaw from './openclaw.js'
import * as opencode from './opencode.js'
import { labelFor } from '../accounts.js'
import { recordSnapshot, codexSnapshots } from '../limits.js'

const MODULES = { claude, codex, hermes, openclaw, opencode }
const MAX_PARSE_LINE = 512 * 1024 // huge lines (embedded images etc.): regex fallback
const TS_RE = /"timestamp":"([^"]+)"/

// The ingest engine. Providers only turn a JSONL line into a normalized
// record; everything else (offsets, sessions, segments, events) lives here.
export function createCollectors(cfg, db, bus) {
  const q = {
    fileState: db.prepare('SELECT offset FROM file_state WHERE path = ?'),
    setFileState: db.prepare(
      'INSERT INTO file_state (path, offset, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime'
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, provider, account, session_key, project, title, cwd, model, state, started_at, last_at, input_tokens, output_tokens, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    ),
    updateSession: db.prepare(
      `UPDATE sessions SET project = COALESCE(project, ?), title = COALESCE(title, ?), cwd = COALESCE(cwd, ?),
       model = COALESCE(?, model), started_at = MIN(started_at, ?), last_at = MAX(last_at, ?),
       input_tokens = ?, output_tokens = ?, state = ? WHERE id = ?`
    ),
    setState: db.prepare('UPDATE sessions SET state = ? WHERE id = ?'),
    lastSegment: db.prepare(
      'SELECT id, started_at, ended_at FROM segments WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1'
    ),
    insertSegment: db.prepare(
      'INSERT INTO segments (session_id, provider, account, started_at, ended_at) VALUES (?, ?, ?, ?, ?)'
    ),
    extendSegment: db.prepare('UPDATE segments SET ended_at = MAX(ended_at, ?) WHERE id = ?'),
    idleSessions: db.prepare("SELECT id, provider, account FROM sessions WHERE state = 'active' AND last_at < ?"),
  }

  const segCache = new Map() // session_id -> {id, started_at, ended_at}
  const sources = []
  for (const [name, pcfg] of Object.entries(cfg.providers)) {
    const mod = MODULES[name]
    if (!mod) continue
    for (const root of pcfg.roots) {
      if (!existsSync(root.path)) continue
      if (mod.custom && !mod.available(root.path)) continue
      // account label: explicit config label wins, else the logged-in email, else dir name
      const account = root.explicitLabel ? root.label : labelFor(name, root)
      sources.push({ mod, provider: name, account, root: root.path })
    }
  }

  // custom collectors (SQLite etc.) manage their own cursor through file_state
  function runCustom(src) {
    const key = `${src.provider}:${src.root}`
    db.exec('BEGIN')
    try {
      src.mod.scan(src.root, {
        cursor: Number(db.prepare('SELECT offset FROM file_state WHERE path = ?').get(key)?.offset ?? 0),
        setCursor: (value) =>
          db.prepare('INSERT INTO file_state (path, offset, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime')
            .run(key, value, Date.now()),
        emit: (rec) => applyRecord(src, rec, key),
        // generic named cursors for collectors tracking many files/tables
        stateGet: (name) =>
          Number(db.prepare('SELECT offset FROM file_state WHERE path = ?').get(`${key}#${name}`)?.offset ?? 0),
        stateSet: (name, value) =>
          db.prepare('INSERT INTO file_state (path, offset, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, mtime = excluded.mtime')
            .run(`${key}#${name}`, value, Date.now()),
        syncJobs: (jobs) => {
          const now = Date.now()
          for (const job of jobs) {
            db.prepare(
              `INSERT INTO external_jobs (id, provider, account, name, kind, detail, next_run_at, last_run_at, state, enabled, seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, detail=excluded.detail,
                 next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at, state=excluded.state,
                 enabled=excluded.enabled, seen_at=excluded.seen_at`
            ).run(
              `${src.provider}:${src.account}:${job.jobId}`, src.provider, src.account,
              job.name, job.kind, job.detail ?? '', job.nextRunAt, job.lastRunAt,
              job.state, job.enabled ? 1 : 0, now
            )
          }
          // anything not seen this sync is gone from the source (fired one-shots etc.)
          db.prepare('DELETE FROM external_jobs WHERE provider = ? AND account = ? AND seen_at < ?')
            .run(src.provider, src.account, now)
        },
      })
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  function readNewBytes(path) {
    let size
    try {
      size = statSync(path).size
    } catch {
      return null
    }
    let offset = q.fileState.get(path)?.offset ?? 0
    if (offset > size) offset = 0 // truncated/rotated
    if (offset === size) return null
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(size - offset)
    try {
      readSync(fd, buf, 0, buf.length, offset)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return null // partial line, wait for more
    q.setFileState.run(path, offset + Buffer.byteLength(text.slice(0, lastNl + 1)), Date.now())
    return text.slice(0, lastNl)
  }

  function applyRecord(src, rec, file) {
    const id = `${src.provider}:${src.account}:${rec.sessionKey}`
    let s = q.getSession.get(id)
    // custom collectors can name the project directly (no cwd on disk)
    const project = rec.project ?? (rec.cwd ? basename(rec.cwd) : null)
    if (!s) {
      q.insertSession.run(
        id, src.provider, src.account, rec.sessionKey, project, rec.title ?? null, rec.cwd ?? null,
        rec.model ?? null, rec.ts, rec.ts, rec.tokensIn ?? 0, rec.tokensOut ?? 0, file
      )
      s = { state: 'new', input_tokens: rec.tokensIn ?? 0, output_tokens: rec.tokensOut ?? 0 }
      bus.emit('session.started', {
        provider: src.provider, account: src.account, sessionId: id,
        data: { project, title: rec.title ?? null },
      })
    } else {
      let tin = s.input_tokens, tout = s.output_tokens
      if (rec.tokensMode === 'add') {
        tin += rec.tokensIn
        tout += rec.tokensOut
      } else if (rec.tokensMode === 'set') {
        tin = Math.max(tin, rec.tokensIn)
        tout = Math.max(tout, rec.tokensOut)
      }
      const wasIdle = s.state === 'idle'
      q.updateSession.run(
        project, rec.title ?? null, rec.cwd ?? null, rec.model ?? null,
        rec.ts, rec.ts, tin, tout, 'active', id
      )
      if (wasIdle) {
        bus.emit('session.active', {
          provider: src.provider, account: src.account, sessionId: id,
          data: { project: s.project ?? project },
        })
      }
    }

    if (rec.rateLimits) {
      for (const snap of codexSnapshots(rec.rateLimits, rec.ts)) {
        recordSnapshot(db, bus, { ...snap, provider: src.provider, account: src.account })
      }
    }

    let seg = segCache.get(id)
    if (!seg) {
      seg = q.lastSegment.get(id) ?? null
      if (seg) segCache.set(id, seg)
    }
    if (seg && rec.ts >= seg.started_at && rec.ts - seg.ended_at <= cfg.gapMs) {
      if (rec.ts > seg.ended_at) {
        q.extendSegment.run(rec.ts, seg.id)
        seg.ended_at = rec.ts
      }
    } else if (!seg || rec.ts > seg.ended_at) {
      const { lastInsertRowid } = q.insertSegment.run(id, src.provider, src.account, rec.ts, rec.ts)
      segCache.set(id, { id: Number(lastInsertRowid), started_at: rec.ts, ended_at: rec.ts })
      bus.emit('segment.started', {
        provider: src.provider, account: src.account, sessionId: id, data: {},
      })
    }
    // out-of-order lines older than the current segment are ignored for segments
  }

  function ingestFile(src, file) {
    const chunk = readNewBytes(file)
    if (chunk === null) return 0
    let n = 0
    db.exec('BEGIN')
    try {
      for (const line of chunk.split('\n')) {
        if (!line) continue
        let obj = null
        if (line.length <= MAX_PARSE_LINE) {
          try {
            obj = JSON.parse(line)
          } catch {
            continue
          }
        } else {
          const m = TS_RE.exec(line.slice(0, 2000))
          if (!m) continue
          obj = { timestamp: m[1] }
        }
        const rec = src.mod.ingest(obj, file, src.root)
        if (rec) {
          applyRecord(src, rec, file)
          n++
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return n
  }

  function initialScan() {
    const cutoff = Date.now() - cfg.scanDays * 86_400_000
    bus.setLive(false) // don't replay history as live events
    let files = 0
    for (const src of sources) {
      if (src.mod.custom) {
        try {
          runCustom(src)
          files++
        } catch {}
        continue
      }
      for (const f of src.mod.listFiles(src.root)) {
        try {
          if (statSync(f).mtimeMs < cutoff) continue
          ingestFile(src, f)
          files++
        } catch {}
      }
    }
    // settle states: anything stale is idle, silently
    db.prepare("UPDATE sessions SET state = 'idle' WHERE last_at < ?").run(Date.now() - cfg.gapMs)
    bus.setLive(true)
    return files
  }

  function startWatchers() {
    const timers = new Map()
    for (const src of sources) {
      if (src.mod.custom) {
        for (const path of src.mod.watchPaths(src.root)) {
          try {
            watch(path, () => {
              clearTimeout(timers.get(path))
              timers.set(path, setTimeout(() => {
                timers.delete(path)
                try { runCustom(src) } catch {}
              }, 800))
            })
          } catch {}
        }
        continue
      }
      for (const dir of src.mod.watchDirs(src.root)) {
        watch(dir, { recursive: true }, (_ev, filename) => {
          if (!filename || !filename.endsWith('.jsonl')) return
          const full = join(dir, filename)
          clearTimeout(timers.get(full))
          timers.set(
            full,
            setTimeout(() => {
              timers.delete(full)
              try {
                ingestFile(src, full)
              } catch {}
            }, 400)
          )
        })
      }
    }
    // idle sweeper
    setInterval(() => {
      const stale = q.idleSessions.all(Date.now() - cfg.gapMs)
      for (const s of stale) {
        q.setState.run('idle', s.id)
        bus.emit('session.idle', { provider: s.provider, account: s.account, sessionId: s.id, data: {} })
      }
    }, 30_000).unref()
  }

  return { sources, initialScan, startWatchers }
}
