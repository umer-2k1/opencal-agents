import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Flag, GripVertical } from "lucide-react";
import type { Provider, Schedule, Segment } from "../lib/types";
import { agentById } from "../lib/types";
import {
  DAY_MINUTES,
  HOUR_HEIGHT,
  clamp,
  cn,
  dayNumber,
  fmtTime,
  isToday,
  minutesOfDay,
  monthShort,
  weekdayShort,
  weekDays,
} from "../lib/time";

interface Props {
  weekStart: Date;
  segments: Segment[];
  schedules: Schedule[];
  enabled: Set<Provider>;
  selectedId: string | null;
  onSelectSegment: (s: Segment) => void;
  onSelectSchedule: (s: Schedule) => void;
  onCreateRange: (day: Date, startMin: number, endMin: number) => void;
  onMoveJob: (schedule: Schedule, startsAt: number) => void;
  onSessionDrag: (segment: Segment, day: Date, startMin: number) => void;
  onDropNew: (agent: Provider, day: Date, startMin: number) => void;
  templateDay: number | null;
}

type Block = {
  key: string;
  kind: "session" | "job";
  start: number;
  end: number;
  provider: Provider;
  title: string;
  subtitle: string;
  segment?: Segment;
  schedule?: Schedule;
};

type CreateDrag = {
  kind: "create";
  dayIndex: number;
  anchor: number;
  cursor: number;
  moved: boolean;
};

type MoveDrag = {
  kind: "move";
  id: string;
  schedule: Schedule;
  duration: number;
  grabOffset: number;
  dayIndex: number;
  start: number;
  end: number;
  moved: boolean;
};

type SessionDrag = {
  kind: "session";
  id: string;
  segment: Segment;
  duration: number;
  grabOffset: number;
  dayIndex: number;
  start: number;
  end: number;
  moved: boolean;
};

type DragState = CreateDrag | MoveDrag | SessionDrag;

function assignColumns(blocks: Block[]) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = new Map<string, { col: number; cols: number }>();
  let group: Block[] = [];
  let groupEnd = -1;

  const flush = () => {
    if (!group.length) return;
    const cols: Block[][] = [];
    for (const b of group) {
      let placed = false;
      for (const c of cols) {
        if (c[c.length - 1].end <= b.start) {
          c.push(b);
          placed = true;
          break;
        }
      }
      if (!placed) cols.push([b]);
    }
    cols.forEach((c, ci) =>
      c.forEach((b) => out.set(b.key, { col: ci, cols: cols.length })),
    );
    group = [];
    groupEnd = -1;
  };

  for (const b of sorted) {
    if (group.length && b.start >= groupEnd) flush();
    group.push(b);
    groupEnd = Math.max(groupEnd, b.end);
  }
  flush();
  return out;
}

function dayStartMs(day: Date) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const snap15 = (v: number) => Math.round(v / 15) * 15;

export function WeekCalendar({
  weekStart,
  segments,
  schedules,
  enabled,
  selectedId,
  onSelectSegment,
  onSelectSchedule,
  onCreateRange,
  onMoveJob,
  onSessionDrag,
  onDropNew,
  templateDay,
}: Props) {
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  function setDragState(next: DragState | null) {
    dragRef.current = next;
    setDrag(next);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, 7.5 * HOUR_HEIGHT - 12);
  }, [weekStart]);

  const dayData = useMemo(() => {
    return days.map((day) => {
      const startMs = dayStartMs(day);
      const endMs = startMs + 86_400_000;
      const blocks: Block[] = [];

      for (const s of segments) {
        if (!enabled.has(s.provider)) continue;
        if (s.ended_at <= startMs || s.started_at >= endMs) continue;
        const start = Math.max(0, (s.started_at - startMs) / 60_000);
        const end = Math.min(DAY_MINUTES, (s.ended_at - startMs) / 60_000);
        if (end - start < 2) continue;
        blocks.push({
          key: `seg-${s.id}`,
          kind: "session",
          start,
          end,
          provider: s.provider,
          title: s.title || s.project || "Agent session",
          subtitle: [s.project, s.model].filter(Boolean).join(" · "),
          segment: s,
        });
      }

      for (const j of schedules) {
        if (!j.fire_at || !["pending", "proposed", "running"].includes(j.status)) continue;
        if (j.fire_at < startMs || j.fire_at >= endMs) continue;
        const start = (j.fire_at - startMs) / 60_000;
        blocks.push({
          key: `job-${j.id}`,
          kind: "job",
          start,
          end: Math.min(DAY_MINUTES, start + 30),
          provider: "claude",
          title: j.name || "Queued job",
          subtitle:
            j.status === "running"
              ? "running now"
              : j.when_type === "next_reset"
                ? "at next reset"
                : `queued · ${j.when_type === "daily" ? j.when_value : fmtTime(j.fire_at)}`,
          schedule: j,
        });
      }

      return { blocks, layout: assignColumns(blocks) };
    });
  }, [days, segments, schedules, enabled]);

  // Window-level listeners: pointer capture is unreliable inside some
  // webviews, and a drop outside the source block used to leave the drag
  // stuck. This guarantees exactly one move/up per drag, wherever it ends.
  const dragActive = !!drag;
  useEffect(() => {
    if (!dragActive) return;

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "create") {
        const minute = minuteAtY(e.clientY, d.dayIndex);
        if (Math.abs(minute - d.anchor) > 3) {
          setDragState({ ...d, cursor: minute, moved: true });
        }
      } else {
        const idx = dayIndexAtX(e.clientX);
        if (idx < 0) return;
        const pointer = minuteAtY(e.clientY, idx);
        const start = clamp(
          snap15(pointer - d.grabOffset),
          0,
          DAY_MINUTES - d.duration,
        );
        if (idx !== d.dayIndex || Math.abs(start - d.start) > 0.5) {
          setDragState({
            ...d,
            dayIndex: idx,
            start,
            end: start + d.duration,
            moved: true,
          });
        }
      }
      maybeAutoScroll(e.clientY);
    }

    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "create") {
        const minute = minuteAtY(e.clientY, d.dayIndex);
        const moved = d.moved || Math.abs(minute - d.anchor) > 8;
        setDragState(null);
        if (moved) {
          const from = snap15(Math.min(d.anchor, minute));
          const to = Math.max(from + 15, snap15(Math.max(d.anchor, minute)));
          onCreateRange(days[d.dayIndex], from, Math.min(DAY_MINUTES, to));
        }
        return;
      }
      if (d.moved) {
        if (d.kind === "move") {
          onMoveJob(d.schedule, dayStartMs(days[d.dayIndex]) + d.start * 60_000);
        } else {
          onSessionDrag(d.segment, days[d.dayIndex], d.start);
        }
        suppressClick.current = true;
      }
      setDragState(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragActive, days, onCreateRange, onMoveJob, onSessionDrag]);

  const now = Date.now();
  const nowMinutes = minutesOfDay(now);

  function dayIndexAtX(clientX: number): number {
    for (let i = 0; i < 7; i++) {
      const el = colRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) return i;
    }
    return -1;
  }

  function minuteAtY(clientY: number, dayIndex: number): number {
    const el = colRefs.current[dayIndex];
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clamp(((clientY - r.top) / HOUR_HEIGHT) * 60, 0, DAY_MINUTES);
  }

  function maybeAutoScroll(clientY: number) {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (clientY < r.top + 60) el.scrollTop = Math.max(0, el.scrollTop - 18);
    else if (clientY > r.bottom - 60) el.scrollTop += 18;
  }

  // ---- drag on empty grid = create --------------------------------------
  function handleColumnPointerDown(
    e: ReactPointerEvent<HTMLDivElement>,
    dayIndex: number,
  ) {
    if (e.button !== 0 || dragRef.current) return;
    const minute = minuteAtY(e.clientY, dayIndex);
    setDragState({
      kind: "create",
      dayIndex,
      anchor: minute,
      cursor: minute,
      moved: false,
    });
  }

  function handleBlockPointerDown(
    e: ReactPointerEvent<HTMLButtonElement>,
    b: Block,
  ) {
    // Never let a block press start an empty-grid create drag.
    e.stopPropagation();
    const idx = dayIndexAtX(e.clientX);
    if (idx < 0) return;
    const pointer = minuteAtY(e.clientY, idx);
    const duration = b.end - b.start;

    if (b.schedule) {
      setDragState({
        kind: "move",
        id: b.schedule.id,
        schedule: b.schedule,
        duration,
        grabOffset: pointer - b.start,
        dayIndex: idx,
        start: b.start,
        end: b.end,
        moved: false,
      });
    } else if (b.segment) {
      setDragState({
        kind: "session",
        id: String(b.segment.id),
        segment: b.segment,
        duration,
        grabOffset: pointer - b.start,
        dayIndex: idx,
        start: b.start,
        end: b.end,
        moved: false,
      });
    }
  }

  // ---- HTML5 drop fallback (also works in a normal browser) -------------
  function handleDragOver(e: ReactDragEvent<HTMLDivElement>, dayIndex: number) {
    if (!e.dataTransfer.types.includes("application/x-opencal-agent")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropTarget(dayIndex);
  }

  function handleDrop(e: ReactDragEvent<HTMLDivElement>, dayIndex: number) {
    e.preventDefault();
    const agent = e.dataTransfer.getData("application/x-opencal-agent") as Provider;
    setDropTarget(null);
    if (!agent) return;
    const minute = snap15(minuteAtY(e.clientY, dayIndex));
    onDropNew(agent, days[dayIndex], minute);
  }

  return (
    <div
      ref={scrollRef}
      className="scrollbar-thin relative flex-1 overflow-auto bg-ink-950"
    >
      <div className="min-w-[860px] select-none">
        {/* header */}
        <div
          className="sticky top-0 z-30 grid border-b border-ink-700/80 bg-ink-900/95 backdrop-blur"
          style={{ gridTemplateColumns: "62px repeat(7, minmax(0, 1fr))" }}
        >
          <div className="border-r border-ink-800 px-2 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-mist-400/70">
            GMT
          </div>
          {days.map((day) => {
            const today = isToday(day);
            return (
              <div
                key={day.toISOString()}
                className={cn(
                  "border-r border-ink-800 px-2.5 py-2 last:border-r-0",
                  today && "bg-brand/[0.04]",
                )}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist-400">
                    {weekdayShort(day)}
                  </span>
                  <span className="text-[10px] text-mist-400/60">
                    {monthShort(day)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className={cn(
                      "text-[18px] font-semibold leading-none tracking-tight",
                      today ? "text-brand" : "text-mist-200",
                    )}
                  >
                    {dayNumber(day)}
                  </span>
                  {today && (
                    <span className="rounded-full bg-brand px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-950">
                      Today
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* body */}
        <div
          className="grid"
          style={{ gridTemplateColumns: "62px repeat(7, minmax(0, 1fr))" }}
        >
          {/* time gutter */}
          <div
            className="relative border-r border-ink-800 bg-ink-900/40"
            style={{ height: 24 * HOUR_HEIGHT }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-mist-400/60"
                style={{ top: h * HOUR_HEIGHT }}
              >
                {h === 0
                  ? "12 AM"
                  : h < 12
                    ? `${h} AM`
                    : h === 12
                      ? "12 PM"
                      : `${h - 12} PM`}
              </div>
            ))}
          </div>

          {days.map((day, dayIndex) => {
            const today = isToday(day);
            const { layout, blocks } = dayData[dayIndex];

            const createGhost =
              drag?.kind === "create" && drag.dayIndex === dayIndex
                ? {
                    from: Math.min(drag.anchor, drag.cursor),
                    to: Math.max(drag.anchor, drag.cursor),
                  }
                : null;

            const moveGhost =
              drag?.kind === "move" && drag.dayIndex === dayIndex
                ? { from: drag.start, to: drag.end, title: drag.schedule.name }
                : null;

            const sessionGhost =
              drag?.kind === "session" && drag.dayIndex === dayIndex
                ? {
                    from: drag.start,
                    to: drag.end,
                    title: drag.segment.title || drag.segment.project || "session",
                    color: agentById(drag.segment.provider).color,
                  }
                : null;

            return (
              <div
                key={day.toISOString()}
                data-day-index={dayIndex}
                ref={(el) => {
                  colRefs.current[dayIndex] = el;
                }}
                className={cn(
                  "relative border-r border-ink-800 last:border-r-0",
                  today && "bg-brand/[0.02]",
                  (dropTarget === dayIndex || templateDay === dayIndex) &&
                    "bg-brand/[0.06] ring-1 ring-inset ring-brand/40",
                )}
                style={{ height: 24 * HOUR_HEIGHT }}
                onPointerDown={(e) => handleColumnPointerDown(e, dayIndex)}
                onDragOver={(e) => handleDragOver(e, dayIndex)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(e, dayIndex)}
              >
                {/* hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="pointer-events-none absolute inset-x-0 border-t border-ink-800/70"
                    style={{ top: h * HOUR_HEIGHT }}
                  />
                ))}
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={`half-${h}`}
                    className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-800/30"
                    style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
                  />
                ))}

                {/* now line */}
                {today && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-20"
                    style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  >
                    <div className="relative h-px bg-brand/80">
                      <span className="absolute -left-[3px] -top-[3px] h-[7px] w-[7px] rounded-full bg-brand shadow-[0_0_8px_rgba(184,242,74,0.7)]" />
                    </div>
                  </div>
                )}

                {/* blocks */}
                {blocks.map((b) => {
                  const pos = layout.get(b.key) ?? { col: 0, cols: 1 };
                  const meta = agentById(b.provider);
                  const isJob = b.kind === "job";
                  const dragging =
                    (drag?.kind === "move" && drag.id === b.schedule?.id) ||
                    (drag?.kind === "session" &&
                      drag.id === String(b.segment?.id));
                  const height = Math.max(
                    isJob ? 24 : 22,
                    ((b.end - b.start) / 60) * HOUR_HEIGHT - 2,
                  );
                  const selected =
                    (b.segment && String(b.segment.id) === selectedId) ||
                    (b.schedule && b.schedule.id === selectedId);
                  const widthPct = 100 / pos.cols;
                  return (
                    <button
                      key={b.key}
                      onPointerDown={(e) => handleBlockPointerDown(e, b)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        if (b.segment) onSelectSegment(b.segment);
                        else if (b.schedule) onSelectSchedule(b.schedule);
                      }}
                      className={cn(
                        "group absolute z-10 cursor-grab overflow-hidden rounded-[5px] px-1.5 py-1 text-left transition-shadow active:cursor-grabbing",
                        "hover:z-20 hover:shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
                        isJob && "border border-dashed",
                        selected && "ring-1 ring-white/60",
                        dragging && "opacity-40",
                      )}
                      style={{
                        top: (b.start / 60) * HOUR_HEIGHT + 1,
                        height,
                        left: `calc(${pos.col * widthPct}% + 1px)`,
                        width: `calc(${widthPct}% - 2px)`,
                        background: isJob ? "rgba(184,242,74,0.07)" : meta.soft,
                        borderLeft: isJob
                          ? "2px dashed rgba(184,242,74,0.65)"
                          : `2px solid ${meta.color}`,
                        borderColor: isJob ? "rgba(184,242,74,0.35)" : undefined,
                      }}
                      title={
                        isJob
                          ? `${b.title} — drag to reschedule`
                          : `${b.title} — drag to re-run as a job`
                      }
                    >
                      <GripVertical
                        size={10}
                        className="pointer-events-none absolute right-0.5 top-0.5 text-white/25 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                      <div className="flex items-start gap-1">
                        {isJob && (
                          <Flag
                            size={9}
                            className="mt-[3px] shrink-0 text-brand"
                            strokeWidth={2.6}
                          />
                        )}
                        <div className="min-w-0 flex-1 pr-2">
                          <div
                            className={cn(
                              "truncate text-[10.5px] font-semibold leading-[1.25]",
                              isJob ? "text-brand" : "text-white/90",
                            )}
                          >
                            {b.title}
                          </div>
                          {height > 34 && (
                            <div className="mt-0.5 truncate text-[9.5px] leading-tight text-white/50">
                              {fmtTime(dayStartMs(day) + b.start * 60_000)} ·{" "}
                              {b.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* create ghost */}
                {createGhost && createGhost.to - createGhost.from > 2 && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] z-30 rounded-[4px] border border-brand/70 bg-brand/15"
                    style={{
                      top: (createGhost.from / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        18,
                        ((createGhost.to - createGhost.from) / 60) * HOUR_HEIGHT,
                      ),
                    }}
                  >
                    <div className="px-1.5 pt-1 text-[9px] font-semibold text-brand">
                      {fmtTime(dayStartMs(day) + createGhost.from * 60_000)}
                    </div>
                  </div>
                )}

                {/* move ghost */}
                {moveGhost && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] z-30 rounded-[4px] border border-brand bg-brand/20 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                    style={{
                      top: (moveGhost.from / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        22,
                        ((moveGhost.to - moveGhost.from) / 60) * HOUR_HEIGHT,
                      ),
                    }}
                  >
                    <div className="truncate px-1.5 pt-1 text-[9.5px] font-semibold text-brand">
                      {fmtTime(dayStartMs(day) + moveGhost.from * 60_000)} ·{" "}
                      {moveGhost.title}
                    </div>
                  </div>
                )}

                {/* session re-run ghost */}
                {sessionGhost && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] z-30 rounded-[4px] border bg-ink-900/90 shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                    style={{
                      top: (sessionGhost.from / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        22,
                        ((sessionGhost.to - sessionGhost.from) / 60) *
                          HOUR_HEIGHT,
                      ),
                      borderColor: sessionGhost.color,
                    }}
                  >
                    <div
                      className="truncate px-1.5 pt-1 text-[9.5px] font-semibold"
                      style={{ color: sessionGhost.color }}
                    >
                      Re-run {fmtTime(dayStartMs(day) + sessionGhost.from * 60_000)}{" "}
                      · {sessionGhost.title}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
