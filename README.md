# OpenCal Agents

**A local-first calendar for your AI coding agents.** See every Claude Code,
Codex, OpenCode, OpenClaw and Hermes session on one timeline — then drag a job
onto the grid and let the scheduler fire it when capacity returns.

OpenCal Agents is an independent, MIT-licensed desktop app built on top of the
open-source [`agentcalendar`](https://www.npmjs.com/package/agentcalendar)
engine (MIT). It is not affiliated with, endorsed by, or a copy of AgentCal HQ.

![status](https://img.shields.io/badge/status-v0.1%20preview-b8f24a)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## What works in v0.1

- **Week calendar** with a 24-hour grid, live "now" line, and overlap layout
  (double-booked agents render side by side).
- **Five lanes** — Claude Code, Codex, OpenCode, OpenClaw, Hermes — each with a
  colour and a filter.
- **Live engine mode**: reads real sessions from the local engine at
  `http://127.0.0.1:4747`.
- **Demo mode**: if the engine isn't running, the app fills the week with
  realistic sample data so the UI is still explorable.
- **Click any block** for a detail drawer: project, model, tokens, duration,
  working directory, session id.
- **Drag on the grid** to open a pre-filled job dialog.
- **Schedule a job**: name, agent, prompt, working directory, and either
  "at next reset" or a specific time.
- **Queued jobs** render as dashed blocks on the calendar.
- **Auto-refresh** every 12 seconds and on window focus.

## Roadmap

| Version | Scope |
| --- | --- |
| **v0.1** | Week calendar, lanes, receipts drawer, drag-to-schedule ✅ |
| **v0.2** | Missions, roles/playbooks, inbox + approvals |
| **v0.3** | Webhooks UI, iCal feed, Tailscale pairing |
| **v0.4** | Self-hosted run target (Docker) + browser terminal |
| **v0.5** | Windows/Linux packaging, auto-update |

## Stack

- **Tauri 2** (Rust shell, macOS/Windows/Linux)
- **React 19 + TypeScript + Vite**
- **Tailwind CSS v4**
- **`agentcalendar` engine** (MIT, vendored under `engine/`)

## Run it

Requirements: Node ≥ 22.13, pnpm, Rust 1.80+, Xcode Command Line Tools.

```bash
pnpm install
pnpm tauri dev
```

The Tauri shell starts the engine automatically (`engine/bin/agentcal.js`) and
the UI talks to it at `http://127.0.0.1:4747`.

### Browser-only development

```bash
pnpm dev
```

Without the Tauri shell the app runs in **Demo** mode. To point it at an
engine you already started (`npx agentcalendar`), the engine requires its auth
token for browser origins; run inside Tauri or use the engine's own UI.

### Environment overrides

- `OPENCAL_ENGINE` — absolute path to `agentcal.js` if you don't use the
  vendored copy.

## Data & privacy

- Everything is local. The engine reads the JSONL transcripts your agent CLIs
  already write (`~/.claude/projects/**`, `~/.codex/sessions/**`, …).
- Store: `~/.agentcal/agentcal.db` (SQLite).
- No account, no cloud, no telemetry from this app.

## Project layout

```
opencal-agents/
├── engine/               # vendored MIT engine (collectors, scheduler, API)
├── src/                  # React UI
│   ├── components/       # Sidebar, Header, WeekCalendar, JobDrawer, NewJobDialog
│   └── lib/              # engine client, demo data, types, time helpers
├── src-tauri/            # Rust shell + commands (engine token / start)
└── NOTICE                # upstream attribution
```

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the upstream
`agentcalendar` attribution.
