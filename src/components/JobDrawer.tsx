import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  CalendarClock,
  Check,
  Copy,
  Folder,
  Hash,
  X,
  Zap,
} from "lucide-react";
import type { Schedule, Segment } from "../lib/types";
import { agentById } from "../lib/types";
import { durationLabel, fmtClock, fmtRange } from "../lib/time";

interface Props {
  segment?: Segment | null;
  schedule?: Schedule | null;
  onClose: () => void;
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Folder;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-ink-800 py-2.5 last:border-0">
      <Icon size={13} className="mt-0.5 shrink-0 text-mist-400" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-mist-400">
          {label}
        </div>
        <div className="mt-0.5 break-words text-[12px] text-mist-200">{value}</div>
      </div>
    </div>
  );
}

function parseAction(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function JobDrawer({ segment, schedule, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!segment && !schedule) return null;

  const isJob = !!schedule;
  const agent = agentById(isJob ? "claude" : segment!.provider);
  const title = isJob
    ? schedule!.name || "Queued job"
    : segment!.title || segment!.project || "Agent session";

  const action = schedule ? parseAction(schedule.action_value) : null;
  const totalTokens = segment
    ? (segment.input_tokens ?? 0) + (segment.output_tokens ?? 0)
    : 0;

  async function copy() {
    const text = JSON.stringify(
      isJob ? { schedule, action } : segment,
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="rise relative flex h-full w-full max-w-[390px] flex-col border-l border-ink-700 bg-ink-900 shadow-2xl">
        <div
          className="h-1 w-full"
          style={{ background: isJob ? "#b8f24a" : agent.color }}
        />
        <div className="flex items-start justify-between gap-3 px-5 pb-4 pt-4">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider"
                style={{
                  background: isJob ? "rgba(184,242,74,0.12)" : agent.soft,
                  color: isJob ? "#b8f24a" : agent.color,
                }}
              >
                {isJob ? "Scheduled job" : agent.name}
              </span>
              {segment?.state && (
                <span className="flex items-center gap-1 text-[10px] text-mist-400">
                  <span
                    className={
                      segment.state === "active"
                        ? "live-dot h-1.5 w-1.5 rounded-full bg-emerald-400"
                        : "h-1.5 w-1.5 rounded-full bg-mist-500"
                    }
                  />
                  {segment.state}
                </span>
              )}
              {schedule && (
                <span className="rounded-md border border-ink-600 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-mist-300">
                  {schedule.status}
                </span>
              )}
            </div>
            <h2 className="text-[15px] font-semibold leading-snug text-white">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mist-400 transition-colors hover:bg-ink-700 hover:text-white"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 pb-5">
          {segment && (
            <>
              <div className="mb-4 rounded-xl border border-ink-700 bg-ink-850 p-3">
                <div className="flex items-center justify-between text-[11px] text-mist-400">
                  <span>{fmtClock(segment.started_at)}</span>
                  <span className="tabular-nums text-mist-200">
                    {durationLabel(segment.started_at, segment.ended_at)}
                  </span>
                  <span>{fmtClock(segment.ended_at)}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: "100%",
                      background: `linear-gradient(90deg, ${agent.color}, ${agent.color}66)`,
                    }}
                  />
                </div>
                <div className="mt-2 text-center text-[10px] text-mist-400">
                  {fmtRange(segment.started_at, segment.ended_at)}
                </div>
              </div>
              <Row icon={Folder} label="Project" value={segment.project || "—"} />
              <Row icon={Hash} label="Model" value={segment.model || "—"} />
              <Row
                icon={Zap}
                label="Tokens"
                value={
                  totalTokens
                    ? `${totalTokens.toLocaleString()} (${(segment.input_tokens ?? 0).toLocaleString()} in / ${(segment.output_tokens ?? 0).toLocaleString()} out)`
                    : "—"
                }
              />
              <Row
                icon={Folder}
                label="Working directory"
                value={
                  <span className="font-mono text-[11px] text-mist-300">
                    {segment.cwd || "—"}
                  </span>
                }
              />
              <Row icon={Check} label="Session" value={segment.session_id} />
              {segment.account && (
                <Row icon={Hash} label="Account" value={segment.account} />
              )}
            </>
          )}

          {schedule && action && (
            <>
              <div className="mb-4 rounded-xl border border-accent/20 bg-accent/[0.05] p-3">
                <div className="flex items-center gap-2 text-[11px] font-medium text-accent">
                  <CalendarClock size={13} />
                  {schedule.when_type === "next_reset"
                    ? "Fires at the next reset"
                    : schedule.when_type === "daily"
                      ? `Every day at ${schedule.when_value}`
                      : schedule.fire_at
                        ? fmtClock(schedule.fire_at)
                        : "Not scheduled"}
                </div>
                {schedule.fire_at && (
                  <div className="mt-1 text-[10px] text-mist-400">
                    Next fire: {new Date(schedule.fire_at).toLocaleString()}
                  </div>
                )}
              </div>
              <Row icon={Zap} label="Agent" value={String(action.agent ?? "claude")} />
              {typeof action.model === "string" && (
                <Row icon={Hash} label="Model" value={action.model} />
              )}
              <Row
                icon={Folder}
                label="Working directory"
                value={
                  <span className="font-mono text-[11px] text-mist-300">
                    {String(action.cwd ?? "—")}
                  </span>
                }
              />
              <div className="pt-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-mist-400">
                  Prompt
                </div>
                <div className="whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850 p-3 font-mono text-[11px] leading-relaxed text-mist-300">
                  {String(action.prompt ?? "—")}
                </div>
              </div>
              {schedule.result && (
                <div className="pt-3">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-mist-400">
                    Receipt
                  </div>
                  <pre className="overflow-auto rounded-lg border border-ink-700 bg-ink-850 p-3 text-[10px] text-mist-400">
                    {schedule.result}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-ink-700 p-4">
          <button
            onClick={copy}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-600 text-[12px] font-medium text-mist-300 transition-colors hover:border-ink-500 hover:text-white"
          >
            <Copy size={13} />
            Copy details
          </button>
          <button
            onClick={onClose}
            className="h-8 flex-1 rounded-lg bg-ink-700 text-[12px] font-medium text-mist-200 transition-colors hover:bg-ink-600"
          >
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}
