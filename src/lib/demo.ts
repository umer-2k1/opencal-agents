import { addDays } from "date-fns";
import type { Provider, Schedule, Segment } from "./types";

/**
 * Demo data so the calendar is useful before the local engine is connected.
 * Everything is relative to the visible week, so it always looks current.
 */

interface Seed {
  day: number;
  start: string;
  end: string;
  provider: Provider;
  account: string;
  project: string;
  title: string;
  model: string;
  tokens: [number, number];
}

const SEEDS: Seed[] = [
  { day: 0, start: "09:10", end: "10:05", provider: "claude", account: "personal", project: "outreach", title: "score inbound leads", model: "sonnet-4.5", tokens: [18400, 6200] },
  { day: 0, start: "09:40", end: "10:25", provider: "codex", account: "personal", project: "outreach", title: "review lead scoring diff", model: "gpt-5-codex", tokens: [9200, 2100] },
  { day: 0, start: "14:00", end: "15:10", provider: "opencode", account: "personal", project: "opencal-agents", title: "wire calendar data layer", model: "deepseek-v4", tokens: [24100, 8800] },
  { day: 1, start: "08:30", end: "09:05", provider: "claude", account: "personal", project: "buildarc", title: "morning release sweep", model: "haiku-4", tokens: [6100, 1500] },
  { day: 1, start: "10:15", end: "11:30", provider: "claude", account: "work", project: "buildarc", title: "render voker reel v2", model: "sonnet-4.5", tokens: [31200, 9400] },
  { day: 1, start: "10:45", end: "11:15", provider: "hermes", account: "personal", project: "research", title: "scan competitor pricing", model: "hermes-3", tokens: [4300, 900] },
  { day: 1, start: "16:20", end: "17:05", provider: "openclaw", account: "personal", project: "ops", title: "tidy downloads folder", model: "claw-2", tokens: [2200, 700] },
  { day: 2, start: "09:00", end: "09:45", provider: "codex", account: "personal", project: "outreach", title: "second-opinion on migrations", model: "gpt-5-codex", tokens: [12100, 3300] },
  { day: 2, start: "11:00", end: "12:20", provider: "claude", account: "personal", project: "opencal-agents", title: "build week calendar grid", model: "sonnet-4.5", tokens: [28500, 11200] },
  { day: 2, start: "13:30", end: "14:00", provider: "opencode", account: "personal", project: "opencal-agents", title: "type the engine API", model: "deepseek-v4", tokens: [7800, 2100] },
  { day: 3, start: "08:45", end: "09:30", provider: "claude", account: "personal", project: "ops", title: "weekly inbox triage", model: "haiku-4", tokens: [5200, 1300] },
  { day: 3, start: "10:00", end: "11:45", provider: "claude", account: "work", project: "buildarc", title: "cut 9:16 vertical export", model: "sonnet-4.5", tokens: [34100, 12800] },
  { day: 3, start: "11:20", end: "12:00", provider: "codex", account: "work", project: "buildarc", title: "verify caption timing", model: "gpt-5-codex", tokens: [15600, 3800] },
  { day: 3, start: "15:00", end: "16:10", provider: "hermes", account: "personal", project: "research", title: "summarize agent calendar market", model: "hermes-3", tokens: [9900, 2600] },
  { day: 4, start: "09:30", end: "10:15", provider: "claude", account: "personal", project: "opencal-agents", title: "refine drag-to-schedule", model: "sonnet-4.5", tokens: [21400, 7600] },
  { day: 4, start: "13:00", end: "14:30", provider: "claude", account: "work", project: "memora-ai", title: "weekly strategy retro", model: "opus-4.6", tokens: [48200, 16400] },
  { day: 4, start: "14:10", end: "14:50", provider: "openclaw", account: "personal", project: "ops", title: "rotate local backups", model: "claw-2", tokens: [2600, 800] },
  { day: 5, start: "10:00", end: "11:00", provider: "codex", account: "personal", project: "outreach", title: "cold-email copy pass", model: "gpt-5-codex", tokens: [13200, 4100] },
  { day: 5, start: "12:30", end: "13:15", provider: "opencode", account: "personal", project: "opencal-agents", title: "add schedule drawer", model: "deepseek-v4", tokens: [16800, 5400] },
  { day: 6, start: "11:00", end: "11:40", provider: "claude", account: "personal", project: "ops", title: "sunday reset checklist", model: "haiku-4", tokens: [4100, 900] },
];

function atMinutes(day: Date, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function demoWeek(weekStart: Date): Segment[] {
  return SEEDS.map((s, i) => {
    const day = addDays(weekStart, s.day);
    const started = atMinutes(day, s.start);
    const ended = atMinutes(day, s.end);
    return {
      id: `demo-${i}`,
      session_id: `demo-session-${i}`,
      provider: s.provider,
      account: s.account,
      started_at: started,
      ended_at: ended,
      project: s.project,
      title: s.title,
      model: s.model,
      state: ended < Date.now() ? "idle" : "active",
      cwd: `~/Documents/Github/${s.project}`,
      session_key: `demo-${i}`,
      input_tokens: s.tokens[0],
      output_tokens: s.tokens[1],
    };
  });
}

export function demoSchedules(weekStart: Date): Schedule[] {
  const now = Date.now();
  const t1 = atMinutes(addDays(weekStart, 2), "18:00");
  const t2 = atMinutes(addDays(weekStart, 4), "09:00");
  const t3 = atMinutes(addDays(weekStart, 5), "08:00");
  return [
    {
      id: "demo-sched-1",
      name: "⚡ Publish weekly changelog",
      when_type: "next_reset",
      when_value: "claude",
      action_type: "claude",
      action_value: JSON.stringify({
        agent: "claude",
        prompt: "Draft and publish the weekly changelog. Ask before pushing.",
        cwd: "~/Documents/Github/opencal-agents",
      }),
      status: "pending",
      fire_at: t1,
      created_at: now - 3600_000,
      fired_at: null,
      result: null,
    },
    {
      id: "demo-sched-2",
      name: "Refresh lead scoring model",
      when_type: "at",
      when_value: new Date(t2).toISOString(),
      action_type: "claude",
      action_value: JSON.stringify({
        agent: "codex",
        prompt: "Re-run the lead scoring evaluation and file a report.",
        cwd: "~/Documents/Github/outreach",
      }),
      status: "pending",
      fire_at: t2,
      created_at: now - 7200_000,
      fired_at: null,
      result: null,
    },
    {
      id: "demo-sched-3",
      name: "Morning ops sweep",
      when_type: "daily",
      when_value: "08:00",
      action_type: "claude",
      action_value: JSON.stringify({
        agent: "claude",
        prompt: "Check overnight runs, summarize failures, and report.",
        cwd: "~/Documents/Github/opencal-agents",
      }),
      status: "pending",
      fire_at: t3,
      created_at: now - 86400_000,
      fired_at: null,
      result: null,
    },
  ];
}
