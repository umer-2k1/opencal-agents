# ▦ AgentCalendar

**A calendar for your AI coding agents.** See when Claude Code, Codex, OpenCode, OpenClaw and Hermes actually ran, where they overlapped, when your rate-limit windows reset — and queue jobs that fire the moment a window opens.

Local-first: reads the session logs your agent CLIs already write to disk. No accounts, no cloud, nothing leaves your machine.

```
npx agentcalendar      # engine + API on http://localhost:4747
```

This package is the **engine**: collectors, scheduler, event bus, and the localhost API. The calendar UI is the [AgentCal HQ app](https://agentcalendar.dev), which runs on top of it (and bundles it, so most people never need npm at all — install this directly for headless boxes, BYO runners, and API access).

Requires Node ≥ 22.13 (current LTS works). Zero dependencies.

## What you get

- **Week calendar** of every agent session — five lanes, each in its own colour — with overlaps laid out side-by-side like double-booked meetings, live-updating as agents run.
- **Rate-limit windows**, vendor-confirmed where the CLI exposes them (Claude's usage endpoint, Codex's own snapshots) and inferred from your activity otherwise. Which is which is labelled: ✓ vendor, ~ estimated.
- **Jobs you drag onto the calendar.** Drop one on the reset line and it fires the moment capacity returns. Runs here, on your own box (`agentcalendar runner`), or on a managed VM.
- **Receipts, not green ticks.** Every run records its session id, cost, diff and outcome — a job that ran clean but changed nothing says so, and one that got blocked on a permission says that too.
- **An event bus with an API**, so you can build anything on top: your own dashboards, Slack alerts, sleep trackers, "start the big job at reset" automations.

Accounts are auto-identified from local auth files (the email logged into each CLI) — never fetched from any server. Multiple Claude Code accounts? Add each config dir as a root; each shows up separately.

## API (localhost + your tailnet)

Start at `GET /api/v1` — it lists every route and event type, so integrations can self-discover.

| Endpoint | What |
|---|---|
| `GET /api/v1/status` | detected providers/accounts, active session count |
| `GET /api/v1/segments?from&to` | calendar blocks (epoch-ms range) |
| `GET /api/v1/sessions?from&to` | sessions with project, title, model, tokens |
| `GET /api/v1/windows` | per provider/account: current window, `nextResetAt` (estimated) |
| `GET /api/v1/events?since&type` | event history |
| `GET /api/v1/stream` | **SSE** live event stream |
| `POST /api/v1/webhooks` | `{url, events: ["window.reset", "session.*", "*"], secret?}` — HMAC-signed deliveries, retries |
| `POST /api/v1/webhooks/{id}/test` | fire a sample event at your endpoint right now |
| `POST /api/v1/schedules` | see below |
| `GET /calendar.ics` | subscribe from Google/Apple Calendar: sessions + upcoming resets on your real calendar |

### Events

`session.started` · `session.active` · `session.idle` · `segment.started` · `window.opened` · `window.reset.upcoming` (15 min warning) · `window.reset` · `schedule.started` · `schedule.fired` · `job.started` / `job.done` / `job.failed` (live job lifecycle with model, cost, tokens)

Webhook deliveries carry `X-AgentCal-Event` and `X-AgentCal-Signature: sha256=<hmac>` when a secret is set.

### Schedules — fire things at the reset

```bash
# run a command the moment your Claude window resets
curl -X POST localhost:4747/api/v1/schedules -d '{
  "name": "big refactor",
  "when": { "type": "next_reset", "value": "claude" },
  "action": { "type": "command", "value": "cd ~/proj && claude -p \"run the full migration\" &" }
}'
```

`when.type`: `at` (ISO datetime) or `next_reset` (`"claude"` / `"claude:work"`). If no window is active, capacity is already fresh and it fires immediately.
`action.type`: `command` (runs in your shell) or `webhook` (POSTs to a URL).

## Remote access over Tailscale

```bash
agentcalendar pair        # prints a QR code
agentcalendar pair --off  # turn it back off
```

If this machine runs [Tailscale](https://tailscale.com), `pair` publishes the engine to your tailnet as `https://<machine>.<tailnet>.ts.net` — the full API (and the coming AgentCal mobile app) reachable from any device signed into your Tailscale account, end-to-end encrypted over WireGuard. The QR carries the URL plus this machine's auth token in one scan. Nothing is exposed to the public internet.

## Cloud runs (Pro)

```bash
agentcalendar login ACAL-...   # license key from agentcalendar.dev/pricing
```

Unlocks **☁ AgentCal Cloud** in the create-job dialog: at fire time your dedicated VM wakes with the prompt staged on it, and the calendar block gets a **Join** button — a real terminal in your browser (works from your phone). On your first run you authenticate the agent CLI inside the session yourself (`/login`, once); the VM's disk persists between runs, so it stays signed in — your credentials never pass through our servers. **Stop** the block when done — flat $50/mo, 100 hours included, no overage.

## Config

`~/.agentcal/config.json` — everything optional:

```json
{
  "port": 4747,
  "gapMinutes": 10,
  "windowHours": 5,
  "providers": {
    "claude": { "roots": ["~/.claude", { "path": "~/.claude-work", "label": "work" }] },
    "codex":  { "roots": ["~/.codex"] }
  }
}
```

Multiple roots per provider = multiple accounts, shown separately everywhere.

## Vendor-confirmed limits (not just estimates)

Where possible AgentCal shows **vendor truth**, marked ✓ in the UI and `"source": "vendor"` in the API:

- **Codex**: the CLI persists `rate_limits` snapshots (5h + weekly windows, `used_percent`, absolute `resets_at`) into its own session files — read locally, zero network.
- **Claude**: polled gently (≤4×/hour, honoring `Retry-After`) from the same OAuth usage endpoint Claude Code's `/usage` screen uses, with the CLI's own token read **read-only** from `~/.claude/.credentials.json` or the macOS Keychain. AgentCal never refreshes or writes tokens — the CLI owns its login. Disable with `"claudeUsagePoll": false`.

This adds the **weekly caps** and **per-model weekly limits** (e.g. "Fable week 79%") that can't be inferred from transcripts. When no fresh vendor data exists, transcript inference takes over, marked `~`.

## How it works

Collectors tail the JSONL transcripts your CLIs already write (`~/.claude/projects/**`, `~/.codex/sessions/**`) into a local SQLite event store (`~/.agentcal/agentcal.db`). Sessions are split into calendar blocks at gaps > `gapMinutes`. Window resets are inferred: a window opens at your first message and lasts `windowHours`; continuous activity across a reset opens the next one immediately. Vendors don't expose reset times programmatically, so everything window-related is an estimate — treat it as a planning aid, not a billing record.

MIT
