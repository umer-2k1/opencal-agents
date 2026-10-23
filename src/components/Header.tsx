import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { fmtWeekRange, cn } from "../lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ink-700/70 bg-ink-900/60 px-6 py-3 backdrop-blur">
      <div className="min-w-[210px]">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-semibold tracking-tight text-white">
            Calendar
          </h1>
          {activeCount > 0 && (
            <Badge variant="success" className="gap-1.5 font-medium">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {activeCount} running
            </Badge>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-mist-400">
          {fmtWeekRange(weekStart)} · all agents, one timeline
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={onRefresh}
              className="size-8 border-ink-700 text-mist-400 hover:text-white"
            >
              <RefreshCw size={14} className={cn(syncing && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>

        <Button
          variant="outline"
          size="sm"
          onClick={onToday}
          className="border-ink-700 text-[12px] font-medium text-mist-300 hover:text-white"
        >
          Today
        </Button>

        <div className="flex items-center overflow-hidden rounded-md border border-ink-700">
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrev}
            className="size-8 rounded-none text-mist-400 hover:text-white"
          >
            <ChevronLeft size={15} />
          </Button>
          <span className="h-4 w-px bg-ink-700" />
          <Button
            variant="ghost"
            size="icon"
            onClick={onNext}
            className="size-8 rounded-none text-mist-400 hover:text-white"
          >
            <ChevronRight size={15} />
          </Button>
        </div>

        <Badge
          variant="outline"
          className={cn(
            "ml-1 hidden gap-1.5 px-2.5 py-1.5 text-[11px] font-medium sm:flex",
            mode === "live" &&
              "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
            mode === "demo" &&
              "border-amber-400/25 bg-amber-400/10 text-amber-300",
            mode === "connecting" && "border-ink-700 text-mist-400",
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
        </Badge>

        <Button
          size="sm"
          onClick={onNewJob}
          className="ml-1 gap-1.5 text-[12px] font-semibold"
        >
          <Plus size={14} strokeWidth={2.6} />
          New job
        </Button>
      </div>
    </header>
  );
}
