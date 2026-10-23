import {
  CalendarDays,
  Inbox,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { AGENTS, type Provider } from "../lib/types";
import { cn } from "../lib/time";

export type NavKey = "calendar" | "missions" | "roles" | "inbox" | "settings";

const NAV: { key: NavKey; label: string; icon: typeof CalendarDays; badge?: string }[] = [
  { key: "calendar", label: "Calendar", icon: CalendarDays },
  { key: "missions", label: "Missions", icon: Sparkles, badge: "v2" },
  { key: "roles", label: "Roles", icon: Users, badge: "v2" },
  { key: "inbox", label: "Inbox", icon: Inbox, badge: "v2" },
  { key: "settings", label: "Settings", icon: Settings, badge: "v2" },
];

interface Props {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  enabled: Set<Provider>;
  onToggleAgent: (id: Provider) => void;
  counts: Record<string, number>;
  mode: "connecting" | "live" | "demo";
  version?: string;
}

export function Sidebar({
  active,
  onNavigate,
  enabled,
  onToggleAgent,
  counts,
  mode,
  version,
}: Props) {
  return (
    <aside className="flex h-full w-[232px] shrink-0 flex-col border-r border-ink-700/70 bg-ink-900">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="relative grid h-9 w-9 place-items-center rounded-xl bg-accent text-ink-950 shadow-[0_0_24px_rgba(184,242,74,0.24)]">
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
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={cn(
                "group mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors",
                isActive
                  ? "bg-ink-700/80 text-white"
                  : "text-mist-400 hover:bg-ink-800 hover:text-mist-200",
              )}
            >
              <Icon
                size={15}
                className={isActive ? "text-accent" : "text-mist-400 group-hover:text-mist-300"}
              />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.badge && (
                <span className="rounded-md border border-ink-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-mist-400">
                  {item.badge}
                </span>
              )}
            </button>
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
              <button
                key={agent.id}
                onClick={() => onToggleAgent(agent.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-opacity",
                  on ? "opacity-100" : "opacity-40 hover:opacity-70",
                )}
              >
                <span
                  className="h-2 w-2 rounded-[3px]"
                  style={{ background: agent.color }}
                />
                <span className="flex-1 truncate text-[12px] text-mist-300">
                  {agent.name}
                </span>
                <span className="text-[11px] tabular-nums text-mist-400">
                  {counts[agent.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
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
          <span className="rounded border border-ink-600 px-1 py-0.5 font-medium">MIT</span>
        </div>
      </div>
    </aside>
  );
}
