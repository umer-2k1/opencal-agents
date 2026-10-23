import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type {
  AgentProbe,
  EngineEvent,
  EngineStatus,
  InboxMessage,
  Mission,
  MissionPlan,
  Role,
  Schedule,
  Segment,
  WindowInfo,
} from "./types";

export const ENGINE_URL = "http://127.0.0.1:4747";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The engine only grants CORS to same-origin callers, so inside the desktop
// shell we go through Tauri's native HTTP client instead of the webview.
const request = (IS_TAURI ? tauriFetch : fetch) as typeof fetch;

let cachedToken: string | null = null;

export function inTauri(): boolean {
  return IS_TAURI;
}

async function getToken(force = false): Promise<string | null> {
  if (cachedToken && !force) return cachedToken;
  if (!IS_TAURI) return null;
  try {
    cachedToken = await invoke<string>("engine_token");
    return cachedToken;
  } catch {
    cachedToken = null;
    return null;
  }
}

async function get<T>(path: string, timeoutMs = 2500): Promise<T> {
  const token = await getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      headers: token ? { "x-acal-token": token } : undefined,
    };
    if (!IS_TAURI) init.signal = ctrl.signal;
    const res = await request(`${ENGINE_URL}${path}`, init);
    if (res.status === 401) {
      const fresh = await getToken(true);
      if (fresh) {
        const retry = await request(`${ENGINE_URL}${path}`, {
          headers: { "x-acal-token": fresh },
        });
        if (retry.ok) return (await retry.json()) as T;
      }
      throw new Error("engine needs a token (run inside the desktop app)");
    }
    if (!res.ok) throw new Error(`engine ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function send<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const token = await getToken();
  const res = await request(`${ENGINE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-acal-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `engine ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function engineStatus(): Promise<EngineStatus | null> {
  // Browser-only dev runs on demo data; desktop uses the live engine.
  if (!IS_TAURI) return null;
  try {
    return await get<EngineStatus>("/api/v1/status", 1500);
  } catch {
    return null;
  }
}

export async function engineStarted(): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    return await invoke<boolean>("start_engine");
  } catch {
    return false;
  }
}

export async function fetchSegments(from: number, to: number): Promise<Segment[]> {
  const data = await get<{ segments: Segment[] }>(
    `/api/v1/segments?from=${from}&to=${to}`,
    4000,
  );
  return data.segments ?? [];
}

export async function fetchSchedules(): Promise<Schedule[]> {
  const data = await get<{ schedules: Schedule[] }>("/api/v1/schedules", 3000);
  return data.schedules ?? [];
}

export async function fetchWindows(): Promise<WindowInfo[]> {
  const data = await get<{ windows: WindowInfo[] }>("/api/v1/windows", 3000);
  return data.windows ?? [];
}

export interface NewJobInput {
  name: string;
  agent: "claude" | "codex" | "opencode" | "openclaw" | "hermes";
  prompt: string;
  cwd: string;
  whenType: "next_reset" | "at";
  whenValue: string;
  model?: string;
}

export async function createJob(input: NewJobInput): Promise<Schedule> {
  return send<Schedule>("POST", "/api/v1/schedules", {
    name: input.name,
    when: { type: input.whenType, value: input.whenValue },
    action: {
      type: "claude",
      value: {
        agent: input.agent,
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
      },
    },
  });
}

export async function rescheduleJob(
  id: string,
  startsAtMs: number,
): Promise<Schedule> {
  return send<Schedule>("PATCH", `/api/v1/schedules/${id}`, {
    when: { type: "at", value: new Date(startsAtMs).toISOString() },
  });
}

// ---- missions -------------------------------------------------------------

export async function fetchMissions(): Promise<Mission[]> {
  const data = await get<{ missions: Mission[] }>("/api/v1/missions", 4000);
  return data.missions ?? [];
}

export async function planMission(
  goal: string,
  context = "",
): Promise<MissionPlan> {
  const data = await send<{ plan: MissionPlan }>(
    "POST",
    "/api/v1/missions/plan",
    { goal, context },
  );
  return data.plan;
}

export async function cancelMissionPlan(): Promise<void> {
  await send("POST", "/api/v1/missions/plan/cancel", {});
}

export async function applyMission(plan: MissionPlan): Promise<Mission> {
  return send<Mission>("POST", "/api/v1/missions", { plan });
}

// ---- roles ----------------------------------------------------------------

export async function fetchRoles(): Promise<Role[]> {
  const data = await get<{ roles: Role[] }>("/api/v1/roles", 4000);
  return data.roles ?? [];
}

export async function updateRole(
  id: string,
  patch: Partial<Pick<Role, "name" | "status" | "model" | "cwd" | "playbook" | "budget_week_usd">>,
): Promise<Role> {
  return send<Role>("PATCH", `/api/v1/roles/${id}`, patch);
}

export interface NewRoleInput {
  name: string;
  agent: Role["agent"];
  model?: string;
  cwd?: string;
  playbook: string;
  budgetWeekUsd?: number | null;
}

export async function createRole(input: NewRoleInput): Promise<Role> {
  return send<Role>("POST", "/api/v1/roles", input);
}

// ---- inbox & proposals ----------------------------------------------------

export async function fetchInbox(): Promise<{
  messages: InboxMessage[];
  unread: number;
}> {
  return get<{ messages: InboxMessage[]; unread: number }>(
    "/api/v1/inbox",
    4000,
  );
}

export async function markRead(ids?: string[]): Promise<{ marked: number }> {
  return send<{ marked: number }>(
    "POST",
    "/api/v1/inbox/read",
    ids && ids.length ? { ids } : {},
  );
}

export async function fetchProposals(): Promise<Schedule[]> {
  const data = await get<{ proposals: Schedule[] }>(
    "/api/v1/proposals",
    4000,
  );
  return data.proposals ?? [];
}

export async function approveProposal(id: string): Promise<Schedule> {
  return send<Schedule>("POST", `/api/v1/proposals/${id}/approve`, {});
}

export async function denyProposal(id: string, reason = ""): Promise<void> {
  await send("POST", `/api/v1/proposals/${id}/deny`, { reason });
}

// ---- connections & live asks ---------------------------------------------

export async function detectAgents(): Promise<AgentProbe[]> {
  if (!IS_TAURI) return [];
  try {
    return await invoke<AgentProbe[]>("detect_agents");
  } catch {
    return [];
  }
}

export async function fetchEvents(
  since: number,
  type?: string,
): Promise<EngineEvent[]> {
  const params = new URLSearchParams({ since: String(since), limit: "200" });
  if (type) params.set("type", type);
  const data = await get<{ events: EngineEvent[] }>(
    `/api/v1/events?${params.toString()}`,
    3000,
  );
  return data.events ?? [];
}

export async function answerAsk(
  scheduleId: string,
  askId: string,
  behavior: "allow" | "deny",
): Promise<void> {
  await send("POST", `/api/v1/schedules/${scheduleId}/answer`, {
    askId,
    behavior,
  });
}
