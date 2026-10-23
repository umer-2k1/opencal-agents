import type { ReactNode } from "react";
import {
  CalendarClock,
  Check,
  Copy,
  Folder,
  Hash,
  Zap,
} from "lucide-react";
import type { Schedule, Segment } from "../lib/types";
import { agentById } from "../lib/types";
import { durationLabel, fmtClock, fmtRange } from "../lib/time";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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
  const open = !!segment || !!schedule;
  const isJob = !!schedule;
  const agent = agentById(isJob ? "claude" : segment?.provider ?? "claude");
  const title = isJob
    ? schedule?.name || "Queued job"
    : segment?.title || segment?.project || "Agent session";

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
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[390px]"
      >
        <div
          className="h-1 w-full shrink-0"
          style={{ background: isJob ? "#b8f24a" : agent.color }}
        />

        <SheetHeader className="gap-2 px-5 pb-4 pt-4 pr-12 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-transparent"
              style={{
                background: isJob ? "rgba(184,242,74,0.12)" : agent.soft,
                color: isJob ? "#b8f24a" : agent.color,
              }}
            >
              {isJob ? "Scheduled job" : agent.name}
            </Badge>
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
              <Badge
                variant="outline"
                className="border-ink-600 text-[9.5px] uppercase tracking-wider text-mist-300"
              >
                {schedule.status}
              </Badge>
            )}
          </div>
          <SheetTitle className="text-[15px] leading-snug text-white">
            {title}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Details for {title}
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <div className="scrollbar-thin flex-1 overflow-auto px-5 py-4">
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
              <div className="mb-4 rounded-xl border border-brand/20 bg-brand/[0.05] p-3">
                <div className="flex items-center gap-2 text-[11px] font-medium text-brand">
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

        <Separator />

        <div className="flex items-center gap-2 p-4">
          <Button variant="outline" onClick={copy} className="flex-1 gap-1.5">
            <Copy size={13} />
            Copy details
          </Button>
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
