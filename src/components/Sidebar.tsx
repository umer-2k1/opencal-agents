import {
  CalendarDays,
  GripVertical,
  Inbox,
  Plug,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AGENTS, type Provider } from "../lib/types";
import { cn } from "../lib/time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type NavKey =
  | "calendar"
  | "missions"
  | "roles"
  | "connections"
  | "inbox"
  | "settings";

const NAV: { key: NavKey; label: string; icon: typeof CalendarDays; badge?: string }[] = [
  { key: "calendar", label: "Calendar", icon: CalendarDays },
  { key: "missions", label: "Missions", icon: Sparkles },
  { key: "roles", label: "Roles", icon: Users },
  { key: "connections", label: "Connections", icon: Plug },
  { key: "inbox", label: "Inbox", icon: Inbox },
  { key: "settings", label: "Settings", icon: Settings },
];

interface Props {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  enabled: Set<Provider>;
  onToggleAgent: (id: Provider) => void;
  counts: Record<string, number>;
  mode: "connecting" | "live" | "demo";
  version?: string;
  onBeginTemplate?: (agent: Provider, e: ReactPointerEvent) => void;
}

export function Sidebar({
  active,
  onNavigate,
  enabled,
  onToggleAgent,
  counts,
  mode,
  version,
  onBeginTemplate,
}: Props) {
  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-ink-700/70 bg-ink-900">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-brand text-ink-950 shadow-[0_0_24px_rgba(184,242,74,0.24)]">
          <CalendarDays size={18} strokeWidth={2.4} />
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-ink-950" />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-white">
            OpenCal
          </div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-mist-400">
            Agents
          </div>
        </div>
      </div>

      <nav className="px-3">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <Button
              key={item.key}
              variant={isActive ? "secondary" : "ghost"}
              onClick={() => onNavigate(item.key)}
              className={cn(
                "mb-0.5 h-9 w-full justify-start gap-2.5 px-3 text-[13px]",
                isActive
                  ? "bg-ink-700/80 text-white hover:bg-ink-700"
                  : "text-mist-400 hover:text-mist-200",
              )}
            >
              <Icon
                size={15}
                className={isActive ? "text-brand" : "text-mist-400"}
              />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.badge && (
                <Badge
                  variant="outline"
                  className="h-4 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-mist-400"
                >
                  {item.badge}
                </Badge>
              )}
            </Button>
          );
        })}
      </nav>

      <div className="mt-6 px-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            Lanes
          </span>
          <span className="text-[10px] tabular-nums text-mist-400/70">
            {enabled.size}/5
          </span>
        </div>
        <div className="space-y-0.5">
          {AGENTS.map((agent) => {
            const on = enabled.has(agent.id);
            return (
              <Button
                key={agent.id}
                variant="ghost"
                size="sm"
                onClick={() => onToggleAgent(agent.id)}
                className={cn(
                  "h-7 w-full justify-start gap-2.5 px-2 text-[12px] font-normal",
                  on ? "opacity-100" : "opacity-40 hover:opacity-70",
                )}
              >
                <span
                  className="h-2 w-2 rounded-[3px]"
                  style={{ background: agent.color }}
                />
                <span className="flex-1 truncate text-left text-mist-300">
                  {agent.name}
                </span>
                <span className="text-[11px] tabular-nums text-mist-400">
                  {counts[agent.id] ?? 0}
                </span>
              </Button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 px-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            Quick schedule
          </span>
          <GripVertical size={11} className="text-mist-400/50" />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {AGENTS.map((agent) => (
            <div
              key={agent.id}
              draggable={false}
              onPointerDown={(e) => onBeginTemplate?.(agent.id, e)}
              title={`Drag ${agent.name} onto the calendar`}
              className="flex cursor-grab touch-none items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[10.5px] text-mist-300 transition-colors hover:border-ink-600 hover:text-white active:cursor-grabbing"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
                style={{ background: agent.color }}
              />
              <span className="truncate">{agent.short}</span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[9.5px] leading-snug text-mist-400/70">
          Drag a chip onto the grid, or drag a queued job to move it.
        </p>
      </div>

      <div className="mt-auto border-t border-ink-700/70 p-4">
        <div className="flex items-center gap-2 rounded-lg bg-ink-850 px-2.5 py-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              mode === "live" && "live-dot bg-emerald-400",
              mode === "demo" && "bg-amber-400",
              mode === "connecting" && "animate-pulse bg-mist-400",
            )}
          />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[11px] font-medium text-mist-200">
              {mode === "live"
                ? "Engine connected"
                : mode === "demo"
                  ? "Demo data"
                  : "Connecting…"}
            </div>
            <div className="truncate text-[10px] text-mist-400">
              {mode === "live"
                ? `localhost:4747${version ? ` · v${version}` : ""}`
                : "Start the app to read real sessions"}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between px-1 text-[10px] text-mist-400/70">
          <span>Local-first</span>
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] text-mist-400"
          >
            MIT
          </Badge>
        </div>
      </div>
    </aside>
  );
}
