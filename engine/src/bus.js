import { EventEmitter } from 'node:events'

// Central event bus. Everything AgentCal knows flows through here as typed
// events, persisted to the events table and fanned out to SSE + webhooks.
//
// Event types:
//   session.started         first ever activity for a session
//   session.active          session resumed after being idle
//   session.idle            no activity for gapMinutes
//   segment.started         a new calendar block began (activity after a gap)
//   window.opened           a rate-limit window opened (first activity)
//   window.reset.upcoming   current window resets within 15 minutes
//   window.reset            window reset passed, capacity is fresh
//   schedule.started        a schedule began executing (cloud: Join is coming up)
//   schedule.fired          a schedule executed
//   job.started             a driver-run job began (sessionId, model)
//   job.done                job finished ok (cost, turns, tokens)
//   job.failed              job crashed, timed out, or errored
export function createBus(db) {
  const em = new EventEmitter()
  em.setMaxListeners(200)
  const ins = db.prepare(
    'INSERT INTO events (ts, type, provider, account, session_id, data) VALUES (?, ?, ?, ?, ?, ?)'
  )
  let live = true
  return {
    setLive(v) {
      live = v
    },
    emit(type, payload = {}) {
      const ts = Date.now()
      const evt = {
        ts,
        type,
        provider: payload.provider ?? null,
        account: payload.account ?? null,
        sessionId: payload.sessionId ?? null,
        data: payload.data ?? {},
      }
      const { lastInsertRowid } = ins.run(
        ts, type, evt.provider, evt.account, evt.sessionId, JSON.stringify(evt.data)
      )
      evt.id = Number(lastInsertRowid)
      if (live) em.emit('event', evt)
      return evt
    },
    on(fn) {
      em.on('event', fn)
      return () => em.off('event', fn)
    },
  }
}
