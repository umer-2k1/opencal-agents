import { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  ArrowRight,
  CalendarClock,
  Loader2,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  applyMission,
  cancelMissionPlan,
  fetchMissions,
  inTauri,
  planMission,
} from "@/lib/api";
import { demoMissionPlan, demoMissions } from "@/lib/demo";
import type { Mission, MissionPlan } from "@/lib/types";
import { agentById } from "@/lib/types";

type Step = "compose" | "planning" | "review";

export function MissionsPage() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("compose");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [plan, setPlan] = useState<MissionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!inTauri()) {
        if (!cancelled) {
          setMissions(demoMissions());
          setLoading(false);
        }
        return;
      }
      try {
        const rows = await fetchMissions();
        if (!cancelled) setMissions(rows);
      } catch {
        if (!cancelled) setMissions(demoMissions());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function reset() {
    setStep("compose");
    setGoal("");
    setContext("");
    setPlan(null);
    setError(null);
    setBusy(false);
  }

  async function makePlan() {
    if (!goal.trim()) {
      setError("Describe the outcome you want the squad to own.");
      return;
    }
    setStep("planning");
    setError(null);
    if (!inTauri()) {
      setPlan(demoMissionPlan(goal.trim()));
      setStep("review");
      return;
    }
    try {
      const next = await planMission(goal.trim(), context.trim());
      setPlan(next);
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The planner failed.");
      setStep("compose");
    }
  }

  async function approve() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    if (!inTauri()) {
      setMissions((prev) => [
        {
          id: `local-${Date.now()}`,
          name: plan.name,
          goal: plan.goal,
          summary: plan.summary,
          metric: plan.metric,
          status: "active",
          created_at: Date.now(),
          roles: plan.roles.length,
          shifts: plan.roles.reduce((n, r) => n + r.shifts.length, 0),
          oneOff: plan.oneOff?.length ?? 0,
        },
        ...prev,
      ]);
      setBusy(false);
      setOpen(false);
      reset();
      return;
    }
    try {
      const created = await applyMission(plan);
      setMissions((prev) => [created, ...prev]);
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the mission.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (step === "planning" && inTauri()) void cancelMissionPlan().catch(() => {});
    setOpen(false);
    reset();
  }

  return (
    <PageShell
      title="Missions"
      subtitle="One goal in. A staffed team and a weekly schedule out."
      action={
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus size={14} strokeWidth={2.6} />
          New mission
        </Button>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center text-mist-400">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : missions.length === 0 ? (
        <EmptyMission onCreate={() => setOpen(true)} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {missions.map((m) => (
            <Card
              key={m.id}
              className="gap-3 border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-600"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[13.5px] font-semibold text-white">
                      {m.name}
                    </h2>
                    <Badge
                      variant={m.status === "active" ? "success" : "outline"}
                      className="h-4 px-1.5 text-[9px] uppercase tracking-wider"
                    >
                      {m.status}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-mist-400">
                    {m.summary || m.goal}
                  </p>
                </div>
                <Sparkles size={15} className="mt-0.5 shrink-0 text-brand/70" />
              </div>

              <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-mist-400">
                  Goal
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11.5px] text-mist-300">
                  {m.goal}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[10px] text-mist-400">
                <Users size={11} />
                {m.roles ?? "—"} roles
                <span className="text-mist-400/50">·</span>
                {m.shifts ?? "—"} shifts
                <span className="text-mist-400/50">·</span>
                {format(new Date(m.created_at), "d MMM")}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-w-[640px] gap-0 overflow-hidden p-0 sm:max-w-[640px]">
          <DialogHeader className="gap-1 border-b border-ink-700 px-5 py-4 pr-12 text-left">
            <DialogTitle className="flex items-center gap-2 text-[15px] text-white">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-ink-950">
                <Sparkles size={13} />
              </span>
              {step === "review" ? "Review the team" : "New mission"}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-mist-400">
              {step === "review"
                ? "Approve the brief once — roles and shifts land on the calendar."
                : "Describe the outcome. The planner drafts roles, playbooks and shifts."}
            </DialogDescription>
          </DialogHeader>

          <div className="scrollbar-thin max-h-[64vh] space-y-4 overflow-auto px-5 py-4">
            {step === "compose" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                    Goal
                  </Label>
                  <Textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    rows={3}
                    placeholder="e.g. Qualify and reply to every inbound lead within an hour."
                    className="min-h-[84px] resize-none border-ink-700 bg-ink-850 text-[12.5px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                    Context <span className="normal-case opacity-60">(optional)</span>
                  </Label>
                  <Textarea
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    rows={2}
                    placeholder="Repo paths, constraints, what good looks like…"
                    className="min-h-[60px] resize-none border-ink-700 bg-ink-850 text-[12px]"
                  />
                </div>
                {error && (
                  <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
                    {error}
                  </div>
                )}
              </>
            )}

            {step === "planning" && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <Loader2 size={22} className="animate-spin text-brand" />
                <div className="text-[12px] font-medium text-mist-200">
                  Drafting roles, playbooks and shifts…
                </div>
                <p className="max-w-[320px] text-[11px] leading-relaxed text-mist-400">
                  The planner reads recent activity and quota, picks cheap models
                  for frequent shifts, and writes a self-contained prompt for each.
                </p>
              </div>
            )}

            {step === "review" && plan && (
              <>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-mist-400">
                    Mission
                  </div>
                  <h3 className="mt-0.5 text-[15px] font-semibold text-white">
                    {plan.name}
                  </h3>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-mist-300">
                    {plan.summary}
                  </p>
                </div>
                <div className="rounded-lg border border-brand/20 bg-brand/[0.05] px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-brand">
                    Success metric
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-mist-200">
                    {plan.metric}
                  </div>
                </div>

                <div className="space-y-2">
                  {plan.roles.map((role) => {
                    const meta = agentById(role.agent);
                    return (
                      <div
                        key={role.name}
                        className="rounded-xl border border-ink-700 bg-ink-850 p-3"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-[3px]"
                            style={{ background: meta.color }}
                          />
                          <span className="text-[12px] font-semibold text-white">
                            {role.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="h-4 px-1.5 text-[9px] uppercase tracking-wider text-mist-400"
                          >
                            {meta.short}
                          </Badge>
                        </div>
                        <p className="mt-1.5 line-clamp-3 text-[10.5px] leading-relaxed text-mist-400">
                          {role.playbook}
                        </p>
                        <div className="mt-2 space-y-1">
                          {role.shifts.map((shift) => (
                            <div
                              key={shift.name}
                              className="flex items-center gap-1.5 text-[10px] text-mist-300"
                            >
                              <CalendarClock size={10} className="text-brand/70" />
                              <span className="font-medium">{shift.name}</span>
                              <span className="text-mist-400/60">
                                {shift.when.type === "daily"
                                  ? `daily ${shift.when.value}`
                                  : shift.when.value}
                              </span>
                              {shift.model && (
                                <span className="ml-auto rounded border border-ink-600 px-1 text-[9px] text-mist-400">
                                  {shift.model}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(plan.oneOff ?? []).length > 0 && (
                  <div className="text-[10.5px] text-mist-400">
                    Plus {(plan.oneOff ?? []).length} kickoff job
                    {(plan.oneOff ?? []).length > 1 ? "s" : ""}.
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="border-t border-ink-700 px-5 py-3.5">
            {step === "compose" && (
              <>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={makePlan} className="gap-1.5">
                  Plan team
                  <ArrowRight size={13} />
                </Button>
              </>
            )}
            {step === "planning" && (
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            )}
            {step === "review" && (
              <>
                <Button variant="ghost" onClick={() => setStep("compose")}>
                  Back
                </Button>
                <Button onClick={approve} disabled={busy} className="gap-1.5">
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  Approve & schedule
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function EmptyMission({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <div className="max-w-[360px] text-center">
        <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-xl bg-ink-800 text-brand">
          <Sparkles size={19} />
        </div>
        <h2 className="text-[14px] font-semibold text-white">Staff a mission</h2>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-mist-400">
          Give the squad one goal. It drafts the roles, their playbooks and a
          weekly shift plan, then waits for your approval.
        </p>
        <Button onClick={onCreate} className="mt-4 gap-1.5">
          <Plus size={14} />
          New mission
        </Button>
      </div>
    </div>
  );
}
