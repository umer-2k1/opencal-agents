import { openUrl } from "@tauri-apps/plugin-opener";
import { Database, ExternalLink, HardDrive, Radio, Shield } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { inTauri } from "@/lib/api";

const REPO = "https://github.com/umer-2k1/opencal-agents";
const UPSTREAM = "https://www.npmjs.com/package/agentcalendar";

function Row({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Radio;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <Icon size={13} className="mt-0.5 shrink-0 text-mist-400" />
      <div className="min-w-0 flex-1">
        <div className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-400">
          {label}
        </div>
        <div
          className={
            mono
              ? "mt-0.5 break-all font-mono text-[11px] text-mist-200"
              : "mt-0.5 text-[11.5px] text-mist-200"
          }
        >
          {value}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const native = inTauri();

  function open(url: string) {
    if (native) {
      void openUrl(url).catch(() => {});
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <PageShell
      title="Settings"
      subtitle="Engine, data and integrations. Everything stays on this machine."
    >
      <div className="max-w-[720px] space-y-3">
        <Card className="gap-0 border-ink-700 bg-ink-900 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" />
              <h2 className="text-[13px] font-semibold text-white">Engine</h2>
            </div>
            <Badge
              variant={native ? "success" : "outline"}
              className="text-[9px] uppercase tracking-wider"
            >
              {native ? "Desktop · native HTTP" : "Browser · demo data"}
            </Badge>
          </div>
          <Separator className="my-3" />
          <Row icon={Radio} label="Local API" value="http://127.0.0.1:4747" mono />
          <Row
            icon={HardDrive}
            label="Data directory"
            value="~/.agentcal"
            mono
          />
          <Row
            icon={Database}
            label="Event store"
            value="~/.agentcal/agentcal.db (SQLite, WAL)"
            mono
          />
          <Row
            icon={Shield}
            label="Auth"
            value="Per-install token read from ~/.agentcal/token; requests never leave localhost."
          />
        </Card>

        <Card className="gap-0 border-ink-700 bg-ink-900 p-4">
          <h2 className="text-[13px] font-semibold text-white">
            Data & privacy
          </h2>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-mist-400">
            OpenCal reads the JSONL transcripts your agent CLIs already write to
            disk. It does not upload prompts, code, credentials or analytics.
            There is no account and no cloud — the only network calls are to the
            local engine on port 4747.
          </p>
        </Card>

        <Card className="gap-0 border-ink-700 bg-ink-900 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[13px] font-semibold text-white">
                About OpenCal Agents
              </h2>
              <p className="mt-0.5 text-[11px] text-mist-400">
                v0.1.0 · MIT · built on agentcalendar 0.21.0 (MIT)
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => open(REPO)}
              className="gap-1.5 border-ink-700"
            >
              GitHub
              <ExternalLink size={12} />
            </Button>
          </div>
          <Separator className="my-3" />
          <p className="text-[10.5px] leading-relaxed text-mist-400">
            An independent, community-built desktop calendar. Not affiliated with,
            endorsed by, or a copy of AgentCal HQ. The upstream engine is used
            under its MIT license — see the NOTICE file in the repository.
          </p>
          <button
            onClick={() => open(UPSTREAM)}
            className="mt-2 text-[10.5px] text-brand/80 underline-offset-2 hover:underline"
          >
            agentcalendar on npm
          </button>
        </Card>
      </div>
    </PageShell>
  );
}
