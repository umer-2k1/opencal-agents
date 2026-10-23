import { addDays } from "date-fns";
import type {
  InboxMessage,
  Mission,
  MissionPlan,
  Provider,
  Role,
  Schedule,
  Segment,
} from "./types";

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

export function demoSchedules(weekStart: Date): Schedule[] {  const now = Date.now();
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

export function demoMissions(): Mission[] {
  const now = Date.now();
  return [
    {
      id: "demo-mission-1",
      name: "Inbound engine",
      goal: "Qualify and reply to every inbound lead within an hour.",
      summary:
        "A two-person squad keeps the inbox moving: a scout enriches and scores new leads, a reviewer checks each draft before anything sends.",
      metric:
        "Reply rate above 90%, and zero unanswered leads older than 60 minutes.",
      status: "active",
      created_at: now - 6 * 86_400_000,
      roles: 2,
      shifts: 4,
      oneOff: 1,
    },
    {
      id: "demo-mission-2",
      name: "BuildArc weekly",
      goal: "Ship one short vertical video every week without a production scramble.",
      summary:
        "A producer plans the cut, an editor renders the vertical export, and a reviewer checks captions and timing before publishing.",
      metric: "One published 9:16 video per week, under 24h from raw footage.",
      status: "active",
      created_at: now - 13 * 86_400_000,
      roles: 3,
      shifts: 5,
      oneOff: 0,
    },
    {
      id: "demo-mission-3",
      name: "Ops hygiene",
      goal: "Keep the machine and repos tidy while I sleep.",
      summary:
        "A quiet custodian rotates backups, prunes downloads, and files a one-paragraph report every morning.",
      metric: "Zero manual cleanup sessions; disk headroom above 120 GB.",
      status: "paused",
      created_at: now - 21 * 86_400_000,
      roles: 1,
      shifts: 2,
      oneOff: 0,
    },
  ];
}

export function demoMissionPlan(goal: string): MissionPlan {
  return {
    goal,
    name: "Inbound engine",
    summary:
      "A small squad that watches the inbox, enriches every new lead, and drafts a reply for review. Cheap models handle the hourly sweep; the reviewer uses a stronger model for the final check.",
    metric:
      "Reply rate above 90%, measured from the inbox report filed each morning.",
    roles: [
      {
        name: "Lead Scout",
        agent: "claude",
        cwd: "~/Documents/Github/outreach",
        playbook:
          "Identity: the first responder for inbound leads. Duties: enrich each new lead, score fit, and draft a short reply. Success: every lead has a score and a draft within the hour. Report: counts, scores, and anything that needs a human.",
        shifts: [
          {
            name: "Hourly inbox sweep",
            when: { type: "daily", value: "09:00" },
            model: "haiku-4",
            effort: "low",
            prompt:
              "Sweep the inbox for new leads. For each one, enrich the company, score fit against our ICP, and draft a reply. Leave risky or ambiguous leads for review.",
          },
        ],
      },
      {
        name: "Reply Reviewer",
        agent: "codex",
        cwd: "~/Documents/Github/outreach",
        playbook:
          "Identity: second pair of eyes on outbound. Duties: check drafts for accuracy, tone, and commitments we cannot keep. Success: no draft ships with a factual or policy error. Report: approved, edited, or blocked with a reason.",
        shifts: [
          {
            name: "End-of-day review",
            when: { type: "cron", value: "0 17 * * 1-5" },
            model: "gpt-5-codex",
            prompt:
              "Review every drafted reply from today. Approve the safe ones, edit the borderline ones, and block anything that makes a commitment we cannot keep. File a short report.",
          },
        ],
      },
    ],
    oneOff: [
      {
        name: "Kickoff audit",
        role: "Lead Scout",
        inMinutes: 10,
        model: "sonnet-4.5",
        prompt:
          "Audit the current inbox and score every open lead. Produce a baseline report so we can measure the squad.",
      },
    ],
  };
}

export function demoRoles(): Role[] {
  const now = Date.now();
  return [
    {
      id: "demo-role-1",
      name: "Lead Scout",
      agent: "claude",
      cwd: "~/Documents/Github/outreach",
      model: "haiku-4",
      full_auto: 0,
      playbook:
        "Identity: first responder for inbound leads. Enrich each lead, score fit against the ICP, and draft a short reply. Escalate pricing and legal questions.",
      notes: "",
      budget_week_usd: 12,
      auto_approve: 0,
      env_max_per_week: 5,
      env_horizon_days: 14,
      status: "active",
      created_at: now - 6 * 86_400_000,
      updated_at: now - 86_400_000,
      mission_id: "demo-mission-1",
      weekSpend: 4.18,
    },
    {
      id: "demo-role-2",
      name: "Reply Reviewer",
      agent: "codex",
      cwd: "~/Documents/Github/outreach",
      model: "gpt-5-codex",
      full_auto: 0,
      playbook:
        "Identity: second pair of eyes on outbound. Check drafts for accuracy, tone, and commitments. Approve, edit, or block with a reason.",
      notes: "Prefers shorter replies. Blocks any discount language.",
      budget_week_usd: 20,
      auto_approve: 1,
      env_max_per_week: 8,
      env_horizon_days: 14,
      status: "active",
      created_at: now - 6 * 86_400_000,
      updated_at: now - 2 * 86_400_000,
      mission_id: "demo-mission-1",
      weekSpend: 7.82,
    },
    {
      id: "demo-role-3",
      name: "Release Notes",
      agent: "opencode",
      cwd: "~/Documents/Github/opencal-agents",
      model: "deepseek-v4",
      full_auto: 0,
      playbook:
        "Identity: changelog writer. Read merged commits, group them by user impact, and write a short publishable note.",
      notes: "",
      budget_week_usd: 8,
      auto_approve: 0,
      env_max_per_week: 3,
      env_horizon_days: 7,
      status: "paused",
      created_at: now - 20 * 86_400_000,
      updated_at: now - 4 * 86_400_000,
      mission_id: null,
      weekSpend: 0,
    },
    {
      id: "demo-role-4",
      name: "Ops Custodian",
      agent: "openclaw",
      cwd: "~/Documents/Github/ops",
      model: "claw-2",
      full_auto: 0,
      playbook:
        "Identity: quiet custodian. Rotate local backups, prune downloads, verify disk headroom, and file one paragraph each morning.",
      notes: "",
      budget_week_usd: 5,
      auto_approve: 1,
      env_max_per_week: 7,
      env_horizon_days: 14,
      status: "active",
      created_at: now - 21 * 86_400_000,
      updated_at: now - 3 * 86_400_000,
      mission_id: "demo-mission-3",
      weekSpend: 1.43,
    },
  ];
}

export function demoInbox(): { messages: InboxMessage[]; unread: number } {
  const now = Date.now();
  const messages: InboxMessage[] = [
    {
      id: "demo-msg-1",
      role_id: "demo-role-1",
      schedule_id: "demo-sched-1",
      kind: "attention",
      subject: "Approve: publish the weekly changelog",
      body: "The draft is ready and the diff is clean. It includes one breaking change — say the word and I will publish.",
      created_at: now - 12 * 60_000,
      read_at: null,
      archived_at: null,
      role_name: "Release Notes",
    },
    {
      id: "demo-msg-2",
      role_id: "demo-role-1",
      schedule_id: null,
      kind: "report",
      subject: "Lead Scout — Monday report",
      body: "14 new leads, 11 scored above threshold, 9 drafts ready. Two pricing questions held for you. Reply rate for the day: 93%.",
      created_at: now - 2 * 3600_000,
      read_at: null,
      archived_at: null,
      role_name: "Lead Scout",
    },
    {
      id: "demo-msg-3",
      role_id: "demo-role-2",
      schedule_id: null,
      kind: "info",
      subject: "Reviewer blocked one draft",
      body: "Blocked a reply that promised a 20% discount. Left the reasoning on the block so you can overrule it.",
      created_at: now - 5 * 3600_000,
      read_at: now - 4 * 3600_000,
      archived_at: null,
      role_name: "Reply Reviewer",
    },
    {
      id: "demo-msg-4",
      role_id: "demo-role-4",
      schedule_id: null,
      kind: "report",
      subject: "Ops Custodian — nightly sweep",
      body: "Backups rotated, 3.2 GB freed from Downloads, disk headroom 145 GB. Nothing needs you.",
      created_at: now - 9 * 3600_000,
      read_at: now - 8 * 3600_000,
      archived_at: null,
      role_name: "Ops Custodian",
    },
  ];
  return { messages, unread: messages.filter((m) => !m.read_at).length };
}

export function demoProposals(): Schedule[] {
  const now = Date.now();
  return [
    {
      id: "demo-prop-1",
      name: "Publish weekly changelog",
      when_type: "at",
      when_value: new Date(now + 2 * 3600_000).toISOString(),
      action_type: "claude",
      action_value: JSON.stringify({
        agent: "claude",
        prompt:
          "Publish the prepared changelog entry, then post the link in the team channel. Ask before announcing anything breaking.",
        cwd: "~/Documents/Github/opencal-agents",
      }),
      status: "proposed",
      fire_at: now + 2 * 3600_000,
      created_at: now - 30 * 60_000,
      fired_at: null,
      result: null,
      role_id: "demo-role-3",
      mission_id: null,
    },
    {
      id: "demo-prop-2",
      name: "Refresh pricing page copy",
      when_type: "at",
      when_value: new Date(now + 26 * 3600_000).toISOString(),
      action_type: "claude",
      action_value: JSON.stringify({
        agent: "codex",
        prompt:
          "Rewrite the pricing page copy to match the current plans. Keep the structure, tighten the sentences, and flag any claim you cannot verify.",
        cwd: "~/Documents/Github/opencal-agents",
      }),
      status: "proposed",
      fire_at: now + 26 * 3600_000,
      created_at: now - 3 * 3600_000,
      fired_at: null,
      result: null,
      role_id: "demo-role-2",
      mission_id: null,
    },
  ];
}
