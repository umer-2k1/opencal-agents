import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Flag } from "lucide-react";
import type { Provider, Schedule, Segment } from "../lib/types";
import { agentById } from "../lib/types";
import {
  DAY_MINUTES,
  HOUR_HEIGHT,
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

export function WeekCalendar({
  weekStart,
  segments,
  schedules,
  enabled,
  selectedId,
  onSelectSegment,
  onSelectSchedule,
  onCreateRange,
}: Props) {
  const days = useMemo(() => weekDays(weekStart), [weekStart]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    day: number;
    anchor: number;
    cursor: number;
    moved: boolean;
  } | null>(null);

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

  const now = Date.now();
  const nowMinutes = minutesOfDay(now);

  function minuteFromEvent(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
    return Math.min(DAY_MINUTES, Math.max(0, raw));
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>, dayIndex: number) {
    if (e.button !== 0) return;
    const minute = minuteFromEvent(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ day: dayIndex, anchor: minute, cursor: minute, moved: false });
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>, dayIndex: number) {
    if (!drag || drag.day !== dayIndex) return;
    const minute = minuteFromEvent(e);
    if (Math.abs(minute - drag.anchor) > 3) {
      setDrag({ ...drag, cursor: minute, moved: true });
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>, dayIndex: number) {
    if (!drag || drag.day !== dayIndex) return;
    const minute = minuteFromEvent(e);
    const moved = drag.moved || Math.abs(minute - drag.anchor) > 8;
    const from = Math.min(drag.anchor, minute);
    const to = Math.max(drag.anchor, minute);
    setDrag(null);
    if (!moved) return;
    const snappedFrom = Math.floor(from / 15) * 15;
    const snappedTo = Math.max(snappedFrom + 15, Math.ceil(to / 15) * 15);
    onCreateRange(days[dayIndex], snappedFrom, Math.min(DAY_MINUTES, snappedTo));
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
                {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
              </div>
            ))}
          </div>

          {days.map((day, dayIndex) => {
            const isDragDay = drag?.day === dayIndex;
            const ghostFrom = isDragDay
              ? Math.min(drag!.anchor, drag!.cursor)
              : 0;
            const ghostTo = isDragDay
              ? Math.max(drag!.anchor, drag!.cursor)
              : 0;
            const today = isToday(day);
            const { layout, blocks } = dayData[dayIndex];

            return (
              <div
                key={day.toISOString()}
                className={cn(
                  "relative border-r border-ink-800 last:border-r-0",
                  today && "bg-brand/[0.02]",
                )}
                style={{ height: 24 * HOUR_HEIGHT }}
                onPointerDown={(e) => handlePointerDown(e, dayIndex)}
                onPointerMove={(e) => handlePointerMove(e, dayIndex)}
                onPointerUp={(e) => handlePointerUp(e, dayIndex)}
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
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (b.segment) onSelectSegment(b.segment);
                        else if (b.schedule) onSelectSchedule(b.schedule);
                      }}
                      className={cn(
                        "group absolute z-10 overflow-hidden rounded-[5px] px-1.5 py-1 text-left transition-shadow",
                        "hover:z-20 hover:shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
                        isJob && "border border-dashed",
                        selected && "ring-1 ring-white/60",
                      )}
                      style={{
                        top: (b.start / 60) * HOUR_HEIGHT + 1,
                        height,
                        left: `calc(${pos.col * widthPct}% + 1px)`,
                        width: `calc(${widthPct}% - 2px)`,
                        background: isJob
                          ? "rgba(184,242,74,0.07)"
                          : meta.soft,
                        borderLeft: isJob
                          ? "2px dashed rgba(184,242,74,0.65)"
                          : `2px solid ${meta.color}`,
                        borderColor: isJob ? "rgba(184,242,74,0.35)" : undefined,
                      }}
                      title={`${b.title} — ${b.subtitle}`}
                    >
                      <div className="flex items-start gap-1">
                        {isJob && (
                          <Flag
                            size={9}
                            className="mt-[3px] shrink-0 text-brand"
                            strokeWidth={2.6}
                          />
                        )}
                        <div className="min-w-0 flex-1">
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
                              {fmtTime(
                                dayStartMs(day) + b.start * 60_000,
                              )}{" "}
                              · {b.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {/* drag ghost */}
                {isDragDay && ghostTo - ghostFrom > 2 && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] z-30 rounded-[4px] border border-brand/70 bg-brand/15"
                    style={{
                      top: (ghostFrom / 60) * HOUR_HEIGHT,
                      height: Math.max(
                        18,
                        ((ghostTo - ghostFrom) / 60) * HOUR_HEIGHT,
                      ),
                    }}
                  >
                    <div className="px-1.5 pt-1 text-[9px] font-semibold text-brand">
                      {fmtTime(dayStartMs(day) + ghostFrom * 60_000)}
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
