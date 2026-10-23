export type Provider = "claude" | "codex" | "opencode" | "openclaw" | "hermes";

export interface Segment {
  id: number | string;
  session_id: string;
  provider: Provider;
  account: string;
  started_at: number;
  ended_at: number;
  project?: string | null;
  title?: string | null;
  model?: string | null;
  state?: string | null;
  cwd?: string | null;
  session_key?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export type ScheduleStatus =
  | "proposed"
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "expired";

export interface Schedule {
  id: string;
  name: string | null;
  when_type: "at" | "next_reset" | "daily" | "cron";
  when_value: string | null;
  action_type: "command" | "webhook" | "claude";
  action_value: string;
  status: ScheduleStatus;
  fire_at: number | null;
  created_at: number;
  fired_at: number | null;
  result: string | null;
  role_id?: string | null;
  mission_id?: string | null;
}

export interface EngineStatus {
  name: string;
  version: string;
  now: number;
  sources: { provider: Provider; account: string; root: string }[];
  sessions: { total: number; active: number };
  instances?: {
    self?: { pid: number; version: string };
    peers?: unknown[];
    conflict?: boolean;
  };
}

export interface WindowInfo {
  provider: Provider;
  account?: string;
  nextResetAt?: number | null;
  usedPercent?: number | null;
  weekly?: { usedPercent?: number | null; resetsAt?: number | null } | null;
  source?: "vendor" | "inferred";
}

export interface AgentMeta {
  id: Provider;
  name: string;
  short: string;
  color: string;
  soft: string;
}

export const AGENTS: AgentMeta[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "Claude",
    color: "#e08a63",
    soft: "rgba(224,138,99,0.16)",
  },
  {
    id: "codex",
    name: "Codex",
    short: "Codex",
    color: "#4ade9b",
    soft: "rgba(74,222,155,0.14)",
  },
  {
    id: "opencode",
    name: "OpenCode",
    short: "OpenCode",
    color: "#8b9dff",
    soft: "rgba(139,157,255,0.15)",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    short: "OpenClaw",
    color: "#f2bd4c",
    soft: "rgba(242,189,76,0.14)",
  },
  {
    id: "hermes",
    name: "Hermes",
    short: "Hermes",
    color: "#c98cf5",
    soft: "rgba(201,140,245,0.15)",
  },
];

export const agentById = (id: Provider | string): AgentMeta =>
  AGENTS.find((a) => a.id === id) ?? AGENTS[0];
