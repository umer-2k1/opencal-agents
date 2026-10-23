import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Copy,
  ExternalLink,
  Folder,
  Plug,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  detectAgents,
  engineStatus,
  fetchSegments,
  inTauri,
} from "@/lib/api";
import { agentById, type AgentProbe, type EngineStatus } from "@/lib/types";
import { cn } from "@/lib/time";

const INSTALL: Record<string, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
};

const DOCS: Record<string, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/overview",
  codex: "https://github.com/openai/codex",
  opencode: "https://opencode.ai",
  "cursor-agent": "https://cursor.com/cli",
};

const DEMO_PROBES: AgentProbe[] = [
  { id: "claude", name: "Claude Code", installed: true, path: "/usr/local/bin/claude", supported: true },
  { id: "codex", name: "Codex", installed: true, path: "~/.local/bin/codex", supported: true },
  { id: "opencode", name: "OpenCode", installed: true, path: "~/.opencode/bin/opencode", supported: true },
  { id: "openclaw", name: "OpenClaw", installed: false, path: null, supported: true },
  { id: "hermes", name: "Hermes", installed: true, path: "~/.local/bin/hermes", supported: true },
  { id: "cursor-agent", name: "Cursor Agent", installed: true, path: "~/.local/bin/cursor-agent", supported: false },
];

const DEMO_STATUS: EngineStatus = {
  name: "agentcal",
  version: "0.21.0",
  now: Date.now(),
  sources: [
    { provider: "claude", account: "you@example.com", root: "~/.claude" },
    { provider: "codex", account: "you@example.com", root: "~/.codex" },
    { provider: "opencode", account: "default", root: "~/.local/share/opencode" },
  ],
  sessions: { total: 135, active: 1 },
};

export function ConnectionsPage() {
  const [probes, setProbes] = useState<AgentProbe[]>([]);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    if (!inTauri()) {
      setProbes(DEMO_PROBES);
      setStatus(DEMO_STATUS);
      setCounts({ claude: 26, codex: 3, opencode: 4, hermes: 2 });
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const now = Date.now();
    const [p, s, segs] = await Promise.all([
      detectAgents(),
      engineStatus(),
      fetchSegments(now - 7 * 86_400_000, now).catch(() => []),
    ]);
    setProbes(p);
    setStatus(s);
    const c: Record<string, number> = {};
    for (const seg of segs) c[seg.provider] = (c[seg.provider] ?? 0) + 1;
    setCounts(c);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function open(url: string) {
    if (inTauri()) void openUrl(url).catch(() => {});
    else window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copy(agentId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(agentId);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  const sources = status?.sources ?? [];
  const supported = probes.filter((p) => p.supported);
  const installedSupported = supported.filter((p) => p.installed).length;

  return (
    <PageShell
      title="Connections"
      subtitle="Agents found on this machine. OpenCal reads their local logs — it never asks for credentials."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          className="gap-1.5 border-ink-700"
        >
          <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
          Rescan
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand/10 text-brand">
          <Plug size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white">
            {installedSupported} of {supported.length} supported agents installed
          </div>
          <div className="text-[10.5px] text-mist-400">
            Accounts are read from each CLI's own auth files. No API keys are
            stored by OpenCal.
          </div>
        </div>
        {status && (
          <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-mist-400">
            engine v{status.version}
          </Badge>
        )}
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-mist-400">
          <RefreshCw size={16} className="animate-spin" />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {probes.map((probe) => {
            const meta = agentById(probe.id);
            const color = probe.id === "cursor-agent" ? "#cbd5e1" : meta.color;
            const accounts = sources.filter((s) => s.provider === probe.id);
            const connected = accounts.length > 0;
            const sessions = counts[probe.id] ?? 0;
            const statusBadge = !probe.supported
              ? { label: "Adapter planned", variant: "outline" as const }
              : connected
                ? { label: "Connected", variant: "success" as const }
                : probe.installed
                  ? { label: "Installed · no sessions", variant: "brand" as const }
                  : { label: "Not installed", variant: "outline" as const };

            return (
              <Card
                key={probe.id}
                className="gap-3 border-ink-700 bg-ink-900 p-4"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-bold"
                    style={{ background: `${color}1f`, color }}
                  >
                    {probe.name.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[13px] font-semibold text-white">
                        {probe.name}
                      </h2>
                      <Badge
                        variant={statusBadge.variant}
                        className="h-4 px-1.5 text-[9px] uppercase tracking-wider"
                      >
                        {statusBadge.label}
                      </Badge>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-mist-400">
                      {probe.path ?? "not found on PATH"}
                    </div>
                  </div>
                  {DOCS[probe.id] && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => open(DOCS[probe.id])}
                      className="size-7 shrink-0 text-mist-400"
                      title="Open docs"
                    >
                      <ExternalLink size={12} />
                    </Button>
                  )}
                </div>

                <Separator />

                <div className="space-y-1.5">
                  {accounts.length > 0 ? (
                    accounts.map((s) => (
                      <div
                        key={`${s.provider}-${s.root}`}
                        className="flex items-center gap-2 text-[10.5px]"
                      >
                        <Check size={10} className="shrink-0 text-emerald-400" />
                        <span className="truncate text-mist-200">
                          {s.account}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-mist-400/70">
                          {s.root.replace(/^\/Users\/[^/]+/, "~")}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="flex items-center gap-2 text-[10.5px] text-mist-400">
                      <Folder size={10} />
                      {!probe.supported
                        ? "Detected on this machine. The adapter is planned; use a command job for now."
                        : sessions > 0
                          ? "Session logs found, but the CLI account was not identified."
                          : probe.installed
                            ? "CLI found, but no session logs yet — run it once."
                            : "Install the CLI and sign in as usual."}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-[9.5px] text-mist-400/70">
                  <span>
                    {sessions > 0
                      ? `${sessions} session${sessions === 1 ? "" : "s"} this week`
                      : "no sessions this week"}
                  </span>
                  {!probe.installed && INSTALL[probe.id] && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copy(probe.id, INSTALL[probe.id])}
                      className="h-6 gap-1 border-ink-700 px-2 text-[9px]"
                    >
                      {copied === probe.id ? <Check size={10} /> : <Copy size={10} />}
                      {copied === probe.id ? "Copied" : "Copy install"}
                    </Button>
                  )}
                  {probe.id === "cursor-agent" && (
                    <span className="flex items-center gap-1">
                      <Terminal size={10} />
                      use a command job today
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
