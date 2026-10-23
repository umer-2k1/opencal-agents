import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { NewJobInput } from "../lib/api";
import { AGENTS, type Provider } from "../lib/types";
import { cn, toLocalIso } from "../lib/time";

interface Props {
  open: boolean;
  initialStart: Date | null;
  initialAgent?: Provider;
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
  onClose,
  onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<Provider>(initialAgent);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("~");
  const [whenType, setWhenType] = useState<"next_reset" | "at">("next_reset");
  const [whenValue, setWhenValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setAgent(initialAgent);
    setPrompt("");
    setCwd("~");
    setError(null);
    setBusy(false);
    if (initialStart) {
      setWhenType("at");
      setWhenValue(toLocalIso(initialStart));
    } else {
      setWhenType("next_reset");
      setWhenValue(initialAgent);
    }
  }, [open, initialStart, initialAgent]);

  if (!open) return null;

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
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule the job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
        onClick={onClose}
      />
      <form
        onSubmit={submit}
        className="rise relative flex max-h-[92vh] w-full max-w-[540px] flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-white">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-ink-950">
                <Plus size={14} strokeWidth={3} />
              </span>
              New job
            </h2>
            <p className="mt-1 text-[11px] text-mist-400">
              Queued locally. Fires on the engine at the time you choose.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-mist-400 hover:bg-ink-700 hover:text-white"
          >
            <X size={15} />
          </button>
        </div>

        <div className="scrollbar-thin flex-1 space-y-4 overflow-auto px-5 py-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
              Job name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Publish weekly changelog"
              className="h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-3 text-[12.5px] text-white outline-none placeholder:text-mist-400/50 focus:border-accent/60"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
              Agent
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {AGENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setAgent(a.id);
                    if (whenType === "next_reset") setWhenValue(a.id);
                  }}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-colors",
                    agent === a.id
                      ? "border-white/25 bg-ink-700 text-white"
                      : "border-ink-700 bg-ink-850 text-mist-400 hover:border-ink-600",
                  )}
                >
                  <span
                    className="h-2 w-2 rounded-[3px]"
                    style={{ background: a.color }}
                  />
                  {a.short}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                Prompt
              </label>
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
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="What should the agent do? Be specific — this prompt runs unattended."
              className="w-full resize-none rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] leading-relaxed text-white outline-none placeholder:text-mist-400/50 focus:border-accent/60"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
              Working directory
            </label>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~/Documents/Github/my-project"
              className="h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-3 font-mono text-[11.5px] text-white outline-none placeholder:text-mist-400/50 focus:border-accent/60"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
              When
            </label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setWhenType("next_reset")}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-left text-[11px] transition-colors",
                  whenType === "next_reset"
                    ? "border-accent/50 bg-accent/[0.06] text-white"
                    : "border-ink-700 bg-ink-850 text-mist-400 hover:border-ink-600",
                )}
              >
                <div className="font-medium">At next reset</div>
                <div className="mt-0.5 text-[9.5px] opacity-70">
                  capacity returns
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setWhenType("at");
                  if (!whenValue || !whenValue.includes("T")) {
                    setWhenValue(toLocalIso(new Date(Date.now() + 3600_000)));
                  }
                }}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-left text-[11px] transition-colors",
                  whenType === "at"
                    ? "border-accent/50 bg-accent/[0.06] text-white"
                    : "border-ink-700 bg-ink-850 text-mist-400 hover:border-ink-600",
                )}
              >
                <div className="font-medium">Specific time</div>
                <div className="mt-0.5 text-[9.5px] opacity-70">pick a moment</div>
              </button>
            </div>
            {whenType === "at" && (
              <input
                type="datetime-local"
                value={whenValue}
                onChange={(e) => setWhenValue(e.target.value)}
                className="mt-2 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-3 text-[12px] text-white outline-none focus:border-accent/60 [color-scheme:dark]"
              />
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-700 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg px-3 text-[12px] font-medium text-mist-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-semibold text-ink-950 transition-transform hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? "Scheduling…" : "Schedule job"}
          </button>
        </div>
      </form>
    </div>
  );
}
