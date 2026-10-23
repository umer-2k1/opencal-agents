import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { addDays, addWeeks } from "date-fns";
import { CheckCircle2, GripVertical } from "lucide-react";
import { Header } from "./components/Header";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { WeekCalendar } from "./components/WeekCalendar";
import { JobDrawer } from "./components/JobDrawer";
import { NewJobDialog } from "./components/NewJobDialog";
import { MissionsPage } from "./pages/Missions";
import { RolesPage } from "./pages/Roles";
import { InboxPage } from "./pages/Inbox";
import { SettingsPage } from "./pages/Settings";
import {
  createJob,
  engineStarted,
  engineStatus,
  fetchSchedules,
  fetchSegments,
  rescheduleJob,
  type NewJobInput,
} from "./lib/api";
import { demoSchedules, demoWeek } from "./lib/demo";
import { AGENTS, agentById, type Provider, type Schedule, type Segment } from "./lib/types";
import { HOUR_HEIGHT, startOfWeekMonday } from "./lib/time";

type Mode = "connecting" | "live" | "demo";

function initialNav(): NavKey {
  const page = new URLSearchParams(window.location.search).get("page");
  return page === "missions" ||
    page === "roles" ||
    page === "inbox" ||
    page === "settings"
    ? page
    : "calendar";
}

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "warn";
}

export default function App() {
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));
  const [nav, setNav] = useState<NavKey>(initialNav);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [mode, setMode] = useState<Mode>("connecting");
  const [version, setVersion] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [enabled, setEnabled] = useState<Set<Provider>>(
    () => new Set(AGENTS.map((a) => a.id)),
  );
  const [selectedSegment, setSelectedSegment] = useState<Segment | null>(null);
  const [selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogStart, setDialogStart] = useState<Date | null>(null);
  const [dialogAgent, setDialogAgent] = useState<Provider>("claude");
  const [dialogPrompt, setDialogPrompt] = useState("");
  const [dialogCwd, setDialogCwd] = useState("~");
  const [dialogName, setDialogName] = useState("");
  const [templateDrag, setTemplateDrag] = useState<{
    agent: Provider;
    x: number;
    y: number;
    dayIndex: number | null;
  } | null>(null);
  const templateRef = useRef<{ agent: Provider; x: number; y: number } | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);

  function notify(message: string, tone: "ok" | "warn" = "ok") {
    setToast({ id: Date.now(), message, tone });
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(id);
  }, [toast]);

  // Pointer-based drag from the quick-schedule chips. This works inside the
  // Tauri webview, where native drag interception can swallow HTML5 DnD.
  const templateActive = !!templateDrag;
  useEffect(() => {
    if (!templateActive) return;

    function dayAt(x: number, y: number): number | null {
      const el = document
        .elementFromPoint(x, y)
        ?.closest("[data-day-index]") as HTMLElement | null;
      if (!el) return null;
      const n = Number(el.dataset.dayIndex);
      return Number.isFinite(n) ? n : null;
    }

    function onMove(e: PointerEvent) {
      const t = templateRef.current;
      if (!t) return;
      templateRef.current = { ...t, x: e.clientX, y: e.clientY };
      setTemplateDrag({
        agent: t.agent,
        x: e.clientX,
        y: e.clientY,
        dayIndex: dayAt(e.clientX, e.clientY),
      });
    }

    function onUp(e: PointerEvent) {
      const t = templateRef.current;
      const dayIndex = dayAt(e.clientX, e.clientY);
      templateRef.current = null;
      setTemplateDrag(null);
      if (!t || dayIndex == null) return;
      const col = document.querySelector(
        `[data-day-index="${dayIndex}"]`,
      ) as HTMLElement | null;
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const minute = Math.max(
        0,
        Math.min(1440, ((e.clientY - rect.top) / HOUR_HEIGHT) * 60),
      );
      const snapped = Math.round(minute / 15) * 15;
      const day = addDays(weekStart, dayIndex);
      const start = new Date(day);
      start.setHours(0, snapped, 0, 0);
      openNewJob(start, t.agent);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [templateActive, weekStart]);

  // Reproducible states for docs screenshots (`?shot=dialog` / `?shot=detail`).
  const shotHandled = useRef(false);
  useEffect(() => {
    const shot = new URLSearchParams(window.location.search).get("shot");
    if (shot === "dialog") {
      setDialogStart(new Date());
      setDialogOpen(true);
    }
  }, []);

  useEffect(() => {
    if (shotHandled.current) return;
    const shot = new URLSearchParams(window.location.search).get("shot");
    if (shot !== "detail" || segments.length === 0) return;
    shotHandled.current = true;
    const target =
      segments.find((s) => s.title?.toLowerCase().includes("build week")) ??
      segments[0];
    setSelectedSegment(target);
  }, [segments]);

  const load = useCallback(async () => {
    setSyncing(true);
    const from = addDays(weekStart, -1).getTime();
    const to = addDays(weekStart, 8).getTime();
    const status = await engineStatus();
    if (status) {
      try {
        const [segs, scheds] = await Promise.all([
          fetchSegments(from, to),
          fetchSchedules(),
        ]);
        setSegments(segs);
        setSchedules(scheds);
        setMode("live");
        setVersion(status.version);
      } catch {
        setSegments(demoWeek(weekStart));
        setSchedules(demoSchedules(weekStart));
        setMode("demo");
        setVersion(undefined);
      }
    } else {
      setSegments(demoWeek(weekStart));
      setSchedules(demoSchedules(weekStart));
      setMode("demo");
      setVersion(undefined);
    }
    setSyncing(false);
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await engineStarted();
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(), 12_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    function onFocus() {
      void load();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of segments) c[s.provider] = (c[s.provider] ?? 0) + 1;
    return c;
  }, [segments]);

  const activeCount = useMemo(() => {
    const now = Date.now();
    return segments.filter(
      (s) => s.started_at <= now && s.ended_at >= now,
    ).length;
  }, [segments]);

  function toggleAgent(id: Provider) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openNewJob(
    start: Date | null,
    agent: Provider = "claude",
    opts?: { prompt?: string; cwd?: string; name?: string },
  ) {
    setDialogAgent(agent);
    setDialogStart(start);
    setDialogPrompt(opts?.prompt ?? "");
    setDialogCwd(opts?.cwd ?? "~");
    setDialogName(opts?.name ?? "");
    setDialogOpen(true);
  }

  function createRange(day: Date, startMin: number, _endMin: number) {
    const start = new Date(day);
    start.setHours(0, startMin, 0, 0);
    openNewJob(start, "claude");
  }

  async function moveJob(schedule: Schedule, startsAt: number) {
    const label = new Date(startsAt).toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (mode === "live") {
      try {
        const updated = await rescheduleJob(schedule.id, startsAt);
        setSchedules((prev) =>
          prev.map((s) => (s.id === schedule.id ? { ...s, ...updated } : s)),
        );
        setSelectedSchedule((cur) =>
          cur && cur.id === schedule.id ? { ...cur, ...updated } : cur,
        );
        notify(`Moved to ${label}`);
      } catch {
        notify("Could not move that job — the engine rejected it", "warn");
      }
      return;
    }
    setSchedules((prev) =>
      prev.map((s) =>
        s.id === schedule.id
          ? {
              ...s,
              when_type: "at",
              when_value: new Date(startsAt).toISOString(),
              fire_at: startsAt,
            }
          : s,
      ),
    );
    notify(`Moved to ${label} (demo)`);
  }

  function dropNew(agent: Provider, day: Date, startMin: number) {
    const start = new Date(day);
    start.setHours(0, startMin, 0, 0);
    openNewJob(start, agent);
  }

  function beginTemplate(agent: Provider, e: ReactPointerEvent) {
    e.preventDefault();
    templateRef.current = { agent, x: e.clientX, y: e.clientY };
    setTemplateDrag({ agent, x: e.clientX, y: e.clientY, dayIndex: null });
  }

  function continuationPrompt(segment: Segment) {
    const title = segment.title || segment.project || "previous session";
    return `Continue the work from the "${title}" session${
      segment.project ? ` in ${segment.project}` : ""
    }. Review what was done, then continue from where it left off. Ask before making risky changes.`;
  }

  function rerunSession(segment: Segment, day: Date, startMin: number) {
    const start = new Date(day);
    start.setHours(0, startMin, 0, 0);
    openNewJob(start, segment.provider, {
      name: `Continue: ${segment.title || segment.project || "session"}`.slice(0, 60),
      prompt: continuationPrompt(segment),
      cwd: segment.cwd || "~",
    });
  }

  function rerunNow(segment: Segment) {
    const start = new Date(Date.now() + 60 * 60_000);
    openNewJob(start, segment.provider, {
      name: `Continue: ${segment.title || segment.project || "session"}`.slice(0, 60),
      prompt: continuationPrompt(segment),
      cwd: segment.cwd || "~",
    });
  }

  async function submitJob(input: NewJobInput) {
    if (mode === "live") {
      const created = await createJob(input);
      setSchedules((prev) => [created, ...prev]);
      notify("Job scheduled on the local engine");
      return;
    }
    const fireAt =
      input.whenType === "next_reset"
        ? Date.now() + 3_600_000
        : new Date(input.whenValue).getTime();
    const local: Schedule = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `local-${Date.now()}`,
      name: input.name,
      when_type: input.whenType,
      when_value: input.whenValue,
      action_type: "claude",
      action_value: JSON.stringify({
        agent: input.agent,
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
      }),
      status: "pending",
      fire_at: Number.isFinite(fireAt) ? fireAt : Date.now() + 3_600_000,
      created_at: Date.now(),
      fired_at: null,
      result: null,
    };
    setSchedules((prev) => [local, ...prev]);
    notify("Added to the demo calendar — connect the engine to run it", "warn");
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-950">
      <Sidebar
        active={nav}
        onNavigate={setNav}
        enabled={enabled}
        onToggleAgent={toggleAgent}
        counts={counts}
        mode={mode}
        version={version}
        onBeginTemplate={beginTemplate}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {nav === "calendar" ? (
          <>
            <Header
              weekStart={weekStart}
              onPrev={() => setWeekStart((w) => addWeeks(w, -1))}
              onNext={() => setWeekStart((w) => addWeeks(w, 1))}
              onToday={() => setWeekStart(startOfWeekMonday(new Date()))}
              onNewJob={() => openNewJob(null)}
              onRefresh={() => void load()}
              syncing={syncing}
              mode={mode}
              activeCount={activeCount}
            />
            <div className="flex shrink-0 items-center gap-2 border-b border-ink-800 bg-brand/[0.03] px-6 py-1.5 text-[10px] text-mist-400">
              <GripVertical size={11} className="text-brand" />
              Drag any block — jobs move, sessions re-run — or drag a lane chip
              onto the grid. Drag empty space to create.
            </div>
            <WeekCalendar
              weekStart={weekStart}
              segments={segments}
              schedules={schedules}
              enabled={enabled}
              selectedId={
                selectedSegment
                  ? String(selectedSegment.id)
                  : selectedSchedule?.id ?? null
              }
              onSelectSegment={(s) => {
                setSelectedSchedule(null);
                setSelectedSegment(s);
              }}
              onSelectSchedule={(s) => {
                setSelectedSegment(null);
                setSelectedSchedule(s);
              }}
              onCreateRange={createRange}
              onMoveJob={moveJob}
              onSessionDrag={rerunSession}
              onDropNew={dropNew}
              templateDay={templateDrag?.dayIndex ?? null}
            />
            <footer className="flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-ink-700/70 bg-ink-900/60 px-4 py-2 text-[10.5px] text-mist-400">
              <span className="flex shrink-0 items-center gap-1.5">
                <span
                  className={
                    mode === "live"
                      ? "h-1.5 w-1.5 rounded-full bg-emerald-400"
                      : "h-1.5 w-1.5 rounded-full bg-amber-400"
                  }
                />
                {mode === "live" ? "Engine live" : "Demo data"}
              </span>
              <span className="shrink-0 text-mist-400/50">·</span>
              <span className="shrink-0">{segments.length} blocks this week</span>
              <span className="shrink-0 text-mist-400/50">·</span>
              <span className="shrink-0">
                {schedules.filter((s) => s.status === "pending").length} queued jobs
              </span>
              <span className="ml-auto hidden shrink-0 md:inline">
                Drag on the grid to schedule · drag a job to move it
              </span>
            </footer>
          </>
        ) : nav === "missions" ? (
          <MissionsPage />
        ) : nav === "roles" ? (
          <RolesPage />
        ) : nav === "inbox" ? (
          <InboxPage />
        ) : (
          <SettingsPage />
        )}
      </main>

      <JobDrawer
        segment={selectedSegment}
        schedule={selectedSchedule}
        onRerun={rerunNow}
        onClose={() => {
          setSelectedSegment(null);
          setSelectedSchedule(null);
        }}
      />

      <NewJobDialog
        open={dialogOpen}
        initialStart={dialogStart}
        initialAgent={dialogAgent}
        initialPrompt={dialogPrompt}
        initialCwd={dialogCwd}
        initialName={dialogName}
        onClose={() => setDialogOpen(false)}
        onSubmit={submitJob}
      />

      {templateDrag && (
        <div
          className="pointer-events-none fixed z-[70]"
          style={{ left: templateDrag.x + 12, top: templateDrag.y + 12 }}
        >
          <div className="flex items-center gap-1.5 rounded-md border border-brand/50 bg-ink-900 px-2 py-1 text-[10px] font-medium text-brand shadow-xl">
            <span
              className="h-1.5 w-1.5 rounded-[2px]"
              style={{ background: agentById(templateDrag.agent).color }}
            />
            {agentById(templateDrag.agent).short} job
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] -translate-x-1/2">
          <div
            className={
              toast.tone === "ok"
                ? "rise flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-ink-800 px-3.5 py-2.5 text-[11.5px] text-emerald-200 shadow-xl"
                : "rise flex items-center gap-2 rounded-xl border border-amber-400/25 bg-ink-800 px-3.5 py-2.5 text-[11.5px] text-amber-200 shadow-xl"
            }
          >
            <CheckCircle2 size={14} />
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
}

