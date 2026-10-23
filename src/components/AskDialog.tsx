import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PendingAsk } from "@/lib/types";

interface Props {
  request: { scheduleId: string; name: string; ask: PendingAsk } | null;
  busy: boolean;
  onAnswer: (behavior: "allow" | "deny") => void;
  onDismiss: () => void;
}

function detailText(ask: PendingAsk): string | null {
  const input = ask.input;
  if (!input) return null;
  for (const key of ["command", "path", "file_path", "query", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(input.choices) && input.choices.length) {
    return `Choices: ${input.choices.join(", ")}`;
  }
  try {
    return JSON.stringify(input, null, 2).slice(0, 1200);
  } catch {
    return null;
  }
}

export function AskDialog({ request, busy, onAnswer, onDismiss }: Props) {
  const ask = request?.ask;
  const detail = ask ? detailText(ask) : null;

  return (
    <Dialog open={!!request} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent className="max-w-[520px] gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="gap-1 border-b border-ink-700 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-[15px] text-white">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-amber-400/15 text-amber-300">
              <AlertTriangle size={13} />
            </span>
            Approval needed
          </DialogTitle>
          <DialogDescription className="text-[11px] text-mist-400">
            A running job is paused until you decide. Approve lets it continue;
            deny stops this step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="brand" className="text-[9px] uppercase tracking-wider">
              {request?.name ?? "Job"}
            </Badge>
            {ask?.kind && (
              <Badge
                variant="outline"
                className="text-[9px] uppercase tracking-wider text-mist-300"
              >
                {ask.kind}
              </Badge>
            )}
            {ask?.tool && (
              <span className="font-mono text-[10px] text-mist-400">
                {ask.tool}
              </span>
            )}
          </div>

          <p className="text-[12px] leading-relaxed text-mist-200">
            {ask?.summary || "The agent wants permission to continue."}
          </p>

          {detail && (
            <pre className="scrollbar-thin max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-850 p-3 font-mono text-[10.5px] leading-relaxed text-mist-300">
              {detail}
            </pre>
          )}

          {ask?.plan && (
            <div className="rounded-lg border border-brand/20 bg-brand/[0.05] p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                <ShieldCheck size={11} />
                Plan
              </div>
              {ask.plan.name && (
                <div className="mt-1 text-[12px] font-semibold text-white">
                  {ask.plan.name}
                </div>
              )}
              {ask.plan.summary && (
                <p className="mt-0.5 text-[11px] leading-relaxed text-mist-300">
                  {ask.plan.summary}
                </p>
              )}
              {ask.plan.metric && (
                <div className="mt-1.5 text-[10px] text-mist-400">
                  Metric: {ask.plan.metric}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-ink-700 px-5 py-3.5">
          <Button
            variant="outline"
            onClick={() => onAnswer("deny")}
            disabled={busy}
            className="border-ink-700"
          >
            Deny
          </Button>
          <Button
            onClick={() => onAnswer("allow")}
            disabled={busy}
            className="gap-1.5"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
