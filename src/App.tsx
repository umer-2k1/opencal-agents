import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, addWeeks } from "date-fns";
import {
  CheckCircle2,
  Inbox,
  Loader2,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { Header } from "./components/Header";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { WeekCalendar } from "./components/WeekCalendar";
import { JobDrawer } from "./components/JobDrawer";
import { NewJobDialog } from "./components/NewJobDialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { AGENTS, type Provider, type Schedule, type Segment } from "./lib/types";
import { startOfWeekMonday } from "./lib/time";

type Mode = "connecting" | "live" | "demo";

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "warn";
}

export default function App() {
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday(new Date()));
  const [nav, setNav] = useState<NavKey>("calendar");
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
  const [toast, setToast] = useState<Toast | null>(null);

  function notify(message: string, tone: "ok" | "warn" = "ok") {
    setToast({ id: Date.now(), message, tone });
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(id);
  }, [toast]);

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

  function openNewJob(start: Date | null, agent: Provider = "claude") {
    setDialogAgent(agent);
    setDialogStart(start);
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
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {nav === "calendar" ? (
          <>
            <Header
              weekStart={weekStart}
              onPrev={() => setWeekStart((w) => addWeeks(w, -1))}
              onNext={() => setWeekStart((w) => addWeeks(w, 1))}
              onToday={() => setWeekStart(startOfWeekMonday(new Date()))}
              onNewJob={() => openNewJob(null)}              onRefresh={() => void load()}
              syncing={syncing}
              mode={mode}
              activeCount={activeCount}
            />
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
              onDropNew={dropNew}
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
        ) : (
          <PlaceholderView nav={nav} />
        )}
      </main>

      <JobDrawer
        segment={selectedSegment}
        schedule={selectedSchedule}
        onClose={() => {
          setSelectedSegment(null);
          setSelectedSchedule(null);
        }}
      />

      <NewJobDialog
        open={dialogOpen}
        initialStart={dialogStart}
        initialAgent={dialogAgent}
        onClose={() => setDialogOpen(false)}
        onSubmit={submitJob}
      />

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

function PlaceholderView({ nav }: { nav: Exclude<NavKey, "calendar"> }) {
  const meta = {
    missions: {
      icon: Sparkles,
      title: "Missions",
      subtitle: "One goal in. A staffed team and a weekly schedule out.",
      points: [
        "Describe a goal and let the planner draft roles, playbooks, and shifts",
        "Approve the brief once — the schedule fills itself",
        "Per-mission view groups every block and receipt",
      ],
    },
    roles: {
      icon: Users,
      title: "Roles",
      subtitle: "Standing agent employees with playbooks and budgets.",
      points: [
        "Each role has a playbook, model, and weekly budget",
        "Pause a role to act as a kill-switch",
        "Auto-approve envelopes bound what agents may schedule alone",
      ],
    },
    inbox: {
      icon: Inbox,
      title: "Inbox",
      subtitle: "Only the things that genuinely need your call.",
      points: [
        "Risky actions arrive as approval cards",
        "Reports and failed runs land here with receipts",
        "Approve or deny without finding the terminal",
      ],
    },
    settings: {
      icon: Settings,
      title: "Settings",
      subtitle: "Engine, accounts, and integrations.",
      points: [
        "Engine runs at http://127.0.0.1:4747",
        "Data lives in ~/.agentcal/agentcal.db",
        "Webhooks, iCal, and Tailscale pairing arrive in v0.3",
      ],
    },
  }[nav];

  const Icon = meta.icon;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-700/70 px-6 py-4">
        <h1 className="text-[17px] font-semibold text-white">{meta.title}</h1>
        <p className="mt-0.5 text-[11px] text-mist-400">{meta.subtitle}</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="max-w-[420px] gap-4 border-ink-700 bg-ink-900 py-6">
          <CardHeader className="gap-1.5">
            <div className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-ink-800 text-brand">
              <Icon size={18} />
            </div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-[14px] text-white">
                Coming in v0.2
              </CardTitle>
              <Badge variant="outline" className="gap-1 text-[9px] uppercase tracking-wider text-mist-400">
                <Loader2 size={9} className="animate-spin" />
                in progress
              </Badge>
            </div>
            <CardDescription className="text-[11.5px] leading-relaxed text-mist-400">
              The engine already supports this. The desktop surface is next on
              the roadmap.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {meta.points.map((p) => (
                <li key={p} className="flex gap-2 text-[11.5px] text-mist-300">
                  <CheckCircle2
                    size={13}
                    className="mt-0.5 shrink-0 text-brand/70"
                  />
                  {p}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
