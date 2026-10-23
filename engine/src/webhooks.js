import { randomUUID, createHmac } from 'node:crypto'

const RETRY_DELAYS = [2_000, 10_000, 30_000]

function matches(patterns, type) {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1)))
  )
}

export function createWebhooks(db, bus) {
  const setStatus = db.prepare('UPDATE webhooks SET last_status = ? WHERE id = ?')

  async function deliver(hook, evt, attempt = 0) {
    const body = JSON.stringify(evt)
    const headers = {
      'content-type': 'application/json',
      'x-agentcal-event': evt.type,
      'x-agentcal-delivery': randomUUID(),
    }
    if (hook.secret) {
      headers['x-agentcal-signature'] =
        'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex')
    }
    try {
      const res = await fetch(hook.url, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(10_000),
      })
      setStatus.run(`${res.status} ${new Date().toISOString()}`, hook.id)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      if (attempt < RETRY_DELAYS.length) {
        setTimeout(() => deliver(hook, evt, attempt + 1), RETRY_DELAYS[attempt]).unref()
      } else {
        setStatus.run(`failed: ${e.message} ${new Date().toISOString()}`, hook.id)
      }
    }
  }

  bus.on((evt) => {
    for (const hook of db.prepare('SELECT * FROM webhooks').all()) {
      let patterns
      try {
        patterns = JSON.parse(hook.events)
      } catch {
        continue
      }
      if (matches(patterns, evt.type)) deliver(hook, evt)
    }
  })

  return {
    list() {
      return db.prepare('SELECT id, url, events, created_at, last_status FROM webhooks').all()
        .map((h) => ({ ...h, events: JSON.parse(h.events) }))
    },
    create({ url, events = ['*'], secret = null }) {
      if (!url || !/^https?:\/\//.test(url)) throw new Error('url must be http(s)')
      if (!Array.isArray(events) || events.length === 0) throw new Error('events must be a non-empty array')
      const id = randomUUID()
      db.prepare('INSERT INTO webhooks (id, url, events, secret, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, url, JSON.stringify(events), secret, Date.now())
      return { id, url, events }
    },
    remove(id) {
      return db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0
    },
    test(id) {
      const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
      if (!hook) return false
      deliver(hook, {
        ts: Date.now(), type: 'webhook.test', provider: 'claude', account: 'example@example.com',
        sessionId: null, data: { note: 'sample delivery from agentcal', resetAt: Date.now() + 3_600_000 },
      })
      return true
    },
  }
}
