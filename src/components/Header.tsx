import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { fmtWeekRange, cn } from "../lib/time";

interface Props {
  weekStart: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onNewJob: () => void;
  onRefresh: () => void;
  syncing: boolean;
  mode: "connecting" | "live" | "demo";
  activeCount: number;
}

export function Header({
  weekStart,
  onPrev,
  onNext,
  onToday,
  onNewJob,
  onRefresh,
  syncing,
  mode,
  activeCount,
}: Props) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ink-700/70 bg-ink-900/60 px-6 py-3.5 backdrop-blur">
      <div className="min-w-[210px]">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-semibold tracking-tight text-white">
            Calendar
          </h1>
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {activeCount} running
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-mist-400">
          {fmtWeekRange(weekStart)} · all agents, one timeline
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onRefresh}
          className="grid h-8 w-8 place-items-center rounded-lg border border-ink-700 text-mist-400 transition-colors hover:border-ink-600 hover:text-white"
          title="Refresh"
        >
          <RefreshCw size={14} className={cn(syncing && "animate-spin")} />
        </button>
        <button
          onClick={onToday}
          className="h-8 rounded-lg border border-ink-700 px-3 text-[12px] font-medium text-mist-300 transition-colors hover:border-ink-600 hover:text-white"
        >
          Today
        </button>
        <div className="flex items-center overflow-hidden rounded-lg border border-ink-700">
          <button
            onClick={onPrev}
            className="grid h-8 w-8 place-items-center text-mist-400 transition-colors hover:bg-ink-800 hover:text-white"
            title="Previous week"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="h-4 w-px bg-ink-700" />
          <button
            onClick={onNext}
            className="grid h-8 w-8 place-items-center text-mist-400 transition-colors hover:bg-ink-800 hover:text-white"
            title="Next week"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <span
          className={cn(
            "ml-1 hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium sm:flex",
            mode === "live"
              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
              : mode === "demo"
                ? "border-amber-400/25 bg-amber-400/10 text-amber-300"
                : "border-ink-700 text-mist-400",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              mode === "live"
                ? "bg-emerald-400"
                : mode === "demo"
                  ? "bg-amber-400"
                  : "bg-mist-400",
            )}
          />
          {mode === "live" ? "Live" : mode === "demo" ? "Demo" : "Connecting"}
        </span>
        <button
          onClick={onNewJob}
          className="ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-semibold text-ink-950 transition-transform hover:brightness-105 active:scale-[0.98]"
        >
          <Plus size={14} strokeWidth={2.6} />
          New job
        </button>
      </div>
    </header>
  );
}
