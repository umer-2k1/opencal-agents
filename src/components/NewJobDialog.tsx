import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import type { NewJobInput } from "../lib/api";
import { AGENTS, type Provider } from "../lib/types";
import { cn, toLocalIso } from "../lib/time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  initialStart: Date | null;
  initialAgent?: Provider;
  initialPrompt?: string;
  initialCwd?: string;
  initialName?: string;
  onClose: () => void;
  onSubmit: (input: NewJobInput) => Promise<void>;
}

const TEMPLATES = [
  {
    label: "Morning sweep",
    prompt:
      "Review overnight runs and failures. Summarize what changed, what broke, and what needs my decision. File a short report.",
  },
  {
    label: "Review a diff",
    prompt:
      "Review the current working tree. Look for correctness bugs, missing tests, and risky changes. Report findings only — do not edit.",
  },
  {
    label: "Weekly retro",
    prompt:
      "Review this week's shipped work and open threads. Write a concise retro: wins, misses, and the top three priorities for next week.",
  },
];

export function NewJobDialog({
  open,
  initialStart,
  initialAgent = "claude",
  initialPrompt = "",
  initialCwd = "~",
  initialName = "",
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<Provider>(initialAgent);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("~");
  const [whenType, setWhenType] = useState<"next_reset" | "at">("next_reset");
  const [whenValue, setWhenValue] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setAgent(initialAgent);
    setPrompt(initialPrompt);
    setCwd(initialCwd || "~");
    setModel("");
    setError(null);
    setBusy(false);
    if (initialStart) {
      setWhenType("at");
      setWhenValue(toLocalIso(initialStart));
    } else {
      setWhenType("next_reset");
      setWhenValue(initialAgent);
    }
  }, [
    open,
    initialStart,
    initialAgent,
    initialPrompt,
    initialCwd,
    initialName,
  ]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) {
      setError("A prompt is required — tell the agent what to do.");
      return;
    }
    if (!cwd.trim()) {
      setError("A working directory is required.");
      return;
    }
    if (whenType === "at" && !whenValue) {
      setError("Pick a date and time, or switch to ‘next reset’.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim() || "Untitled job",
        agent,
        prompt: prompt.trim(),
        cwd: cwd.trim(),
        whenType,
        whenValue: whenType === "next_reset" ? agent : whenValue,
        model: model.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule the job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[540px] gap-0 overflow-hidden p-0 sm:max-w-[540px]">
        <DialogHeader className="gap-1 border-b border-ink-700 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-[15px] text-white">
            <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-ink-950">
              <Plus size={14} strokeWidth={3} />
            </span>
            New job
          </DialogTitle>
          <DialogDescription className="text-[11px] text-mist-400">
            Queued locally. Fires on the engine at the time you choose.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="scrollbar-thin max-h-[68vh] space-y-4 overflow-auto px-5 py-4">
            <div className="space-y-1.5">
              <Label
                htmlFor="job-name"
                className="text-[10px] font-semibold uppercase tracking-wider text-mist-400"
              >
                Job name
              </Label>
              <Input
                id="job-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Publish weekly changelog"
                className="border-ink-700 bg-ink-850 text-[12.5px]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                Agent
              </Label>
              <div className="grid grid-cols-5 gap-1.5">
                {AGENTS.map((a) => (
                  <Button
                    key={a.id}
                    type="button"
                    variant={agent === a.id ? "secondary" : "outline"}
                    onClick={() => {
                      setAgent(a.id);
                      if (whenType === "next_reset") setWhenValue(a.id);
                    }}
                    className={cn(
                      "h-auto flex-col gap-1 border-ink-700 bg-ink-850 px-1 py-2 text-[10px] font-medium",
                      agent === a.id && "border-white/25 text-white",
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-[3px]"
                      style={{ background: a.color }}
                    />
                    {a.short}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="job-prompt"
                  className="text-[10px] font-semibold uppercase tracking-wider text-mist-400"
                >
                  Prompt
                </Label>
                <div className="flex gap-1">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setPrompt(t.prompt)}
                      className="rounded border border-ink-700 px-1.5 py-0.5 text-[9.5px] text-mist-400 transition-colors hover:border-ink-500 hover:text-mist-200"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <Textarea
                id="job-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="What should the agent do? Be specific — this prompt runs unattended."
                className="min-h-[96px] resize-none border-ink-700 bg-ink-850 text-[12px] leading-relaxed"
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="job-cwd"
                className="text-[10px] font-semibold uppercase tracking-wider text-mist-400"
              >
                Working directory
              </Label>
              <Input
                id="job-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~/Documents/Github/my-project"
                className="border-ink-700 bg-ink-850 font-mono text-[11.5px]"
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="job-model"
                className="text-[10px] font-semibold uppercase tracking-wider text-mist-400"
              >
                Model <span className="normal-case opacity-60">(optional)</span>
              </Label>
              <Input
                id="job-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="agent default"
                className="border-ink-700 bg-ink-850 font-mono text-[11.5px]"
              />
              {agent === "opencode" && (
                <p className="text-[9.5px] leading-snug text-mist-400/70">
                  OpenCode needs an explicit model, e.g.{" "}
                  <span className="font-mono">opencode/mimo-v2.6-flash-free</span>.
                  The default free model can be unavailable.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                When
              </Label>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant={whenType === "next_reset" ? "secondary" : "outline"}
                  onClick={() => setWhenType("next_reset")}
                  className={cn(
                    "h-auto flex-1 flex-col items-start gap-0.5 border-ink-700 bg-ink-850 px-3 py-2 text-[11px]",
                    whenType === "next_reset" &&
                      "border-brand/50 bg-brand/[0.06] text-white",
                  )}
                >
                  <span className="font-medium">At next reset</span>
                  <span className="text-[9.5px] font-normal opacity-70">
                    capacity returns
                  </span>
                </Button>
                <Button
                  type="button"
                  variant={whenType === "at" ? "secondary" : "outline"}
                  onClick={() => {
                    setWhenType("at");
                    if (!whenValue || !whenValue.includes("T")) {
                      setWhenValue(toLocalIso(new Date(Date.now() + 3600_000)));
                    }
                  }}
                  className={cn(
                    "h-auto flex-1 flex-col items-start gap-0.5 border-ink-700 bg-ink-850 px-3 py-2 text-[11px]",
                    whenType === "at" &&
                      "border-brand/50 bg-brand/[0.06] text-white",
                  )}
                >
                  <span className="font-medium">Specific time</span>
                  <span className="text-[9.5px] font-normal opacity-70">
                    pick a moment
                  </span>
                </Button>
              </div>
              {whenType === "at" && (
                <Input
                  type="datetime-local"
                  value={whenValue}
                  onChange={(e) => setWhenValue(e.target.value)}
                  className="border-ink-700 bg-ink-850 text-[12px] [color-scheme:dark]"
                />
              )}
            </div>

            {error && (
              <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
                {error}
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-ink-700 px-5 py-3.5">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className="gap-1.5 font-semibold">
              {busy && <Loader2 size={13} className="animate-spin" />}
              {busy ? "Scheduling…" : "Schedule job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
