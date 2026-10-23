import { invoke } from "@tauri-apps/api/core";
import type { EngineStatus, Schedule, Segment, WindowInfo } from "./types";

export const ENGINE_URL = "http://127.0.0.1:4747";

let cachedToken: string | null = null;

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getToken(force = false): Promise<string | null> {
  if (cachedToken && !force) return cachedToken;
  if (!inTauri()) return null;
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
    const res = await fetch(`${ENGINE_URL}${path}`, {
      signal: ctrl.signal,
      headers: token ? { "x-acal-token": token } : undefined,
    });
    if (res.status === 401) {
      const fresh = await getToken(true);
      if (fresh) {
        const retry = await fetch(`${ENGINE_URL}${path}`, {
          signal: ctrl.signal,
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
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

async function patch<T>(path: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "PATCH",
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

export async function rescheduleJob(
  id: string,
  startsAtMs: number,
): Promise<Schedule> {
  return patch<Schedule>(`/api/v1/schedules/${id}`, {
    when: { type: "at", value: new Date(startsAtMs).toISOString() },
  });
}

export async function engineStatus(): Promise<EngineStatus | null> {
  try {
    return await get<EngineStatus>("/api/v1/status", 1500);
  } catch {
    return null;
  }
}

export async function engineStarted(): Promise<boolean> {
  if (!inTauri()) return false;
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
  return post<Schedule>("/api/v1/schedules", {
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
