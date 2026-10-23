import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Loader2,
  Pause,
  Play,
  Plus,
  UserRound,
  Wallet,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createRole, fetchRoles, inTauri, updateRole } from "@/lib/api";
import { demoRoles } from "@/lib/demo";
import { AGENTS, agentById, type Provider, type Role } from "@/lib/types";
import { cn } from "@/lib/time";

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    agent: "claude" as Provider,
    model: "",
    cwd: "",
    playbook: "",
    budget: "",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!inTauri()) {
        if (!cancelled) {
          setRoles(demoRoles());
          setLoading(false);
        }
        return;
      }
      try {
        const rows = await fetchRoles();
        if (!cancelled) setRoles(rows);
      } catch {
        if (!cancelled) setRoles(demoRoles());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(role: Role) {
    const next = role.status === "active" ? "paused" : "active";
    if (!inTauri()) {
      setRoles((prev) =>
        prev.map((r) => (r.id === role.id ? { ...r, status: next } : r)),
      );
      return;
    }
    setBusyId(role.id);
    try {
      const updated = await updateRole(role.id, { status: next });
      setRoles((prev) =>
        prev.map((r) => (r.id === role.id ? { ...r, ...updated } : r)),
      );
    } catch {
      setError("Could not update that role.");
    } finally {
      setBusyId(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.playbook.trim()) {
      setError("A name and a playbook are required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      if (!inTauri()) {
        setRoles((prev) => [
          {
            id: `local-${Date.now()}`,
            name: form.name.trim(),
            agent: form.agent,
            cwd: form.cwd || null,
            model: form.model || null,
            full_auto: 0,
            playbook: form.playbook.trim(),
            notes: "",
            budget_week_usd: form.budget ? Number(form.budget) : null,
            auto_approve: 0,
            env_max_per_week: 5,
            env_horizon_days: 14,
            status: "active",
            created_at: Date.now(),
            updated_at: Date.now(),
            mission_id: null,
            weekSpend: 0,
          },
          ...prev,
        ]);
      } else {
        const created = await createRole({
          name: form.name.trim(),
          agent: form.agent,
          model: form.model || undefined,
          cwd: form.cwd || undefined,
          playbook: form.playbook.trim(),
          budgetWeekUsd: form.budget ? Number(form.budget) : null,
        });
        setRoles((prev) => [created, ...prev]);
      }
      setOpen(false);
      setForm({
        name: "",
        agent: "claude",
        model: "",
        cwd: "",
        playbook: "",
        budget: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the role.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageShell
      title="Roles"
      subtitle="Standing agent employees with playbooks, budgets and a kill-switch."
      action={
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Plus size={14} strokeWidth={2.6} />
          New role
        </Button>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center text-mist-400">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {roles.map((role) => {
            const meta = agentById(role.agent);
            const budget = role.budget_week_usd;
            const spend = role.weekSpend ?? 0;
            const pct = budget ? Math.min(100, (spend / budget) * 100) : 0;
            const paused = role.status === "paused";
            return (
              <Card
                key={role.id}
                className={cn(
                  "gap-3 border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-600",
                  paused && "opacity-70",
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-bold"
                    style={{ background: meta.soft, color: meta.color }}
                  >
                    {role.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-[13px] font-semibold text-white">
                        {role.name}
                      </h2>
                      <Badge
                        variant={paused ? "outline" : "success"}
                        className="h-4 px-1.5 text-[9px] uppercase tracking-wider"
                      >
                        {role.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-mist-400">
                      <span style={{ color: meta.color }}>{meta.name}</span>
                      {role.model && (
                        <>
                          <span className="text-mist-400/40">·</span>
                          <span className="font-mono">{role.model}</span>
                        </>
                      )}
                      {role.cwd && (
                        <>
                          <span className="text-mist-400/40">·</span>
                          <span className="truncate font-mono">{role.cwd}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggle(role)}
                    disabled={busyId === role.id}
                    className="h-7 gap-1 border-ink-700 px-2 text-[10px] text-mist-300"
                  >
                    {busyId === role.id ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : paused ? (
                      <Play size={11} />
                    ) : (
                      <Pause size={11} />
                    )}
                    {paused ? "Resume" : "Pause"}
                  </Button>
                </div>

                <p className="line-clamp-3 text-[10.5px] leading-relaxed text-mist-400">
                  {role.playbook}
                </p>

                <div className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
                  <Wallet size={12} className="shrink-0 text-mist-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between text-[9.5px] text-mist-400">
                      <span>Week spend</span>
                      <span className="tabular-nums">
                        ${spend.toFixed(2)}
                        {budget != null ? ` / $${budget.toFixed(0)}` : " · no cap"}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          pct > 85 ? "bg-rose-400" : "bg-brand",
                        )}
                        style={{ width: `${budget ? pct : 4}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[9.5px] text-mist-400/70">
                  <span className="flex items-center gap-1">
                    <UserRound size={10} />
                    {role.auto_approve ? "Auto-approve inside envelope" : "Asks first"}
                  </span>
                  <span>
                    Updated{" "}
                    {formatDistanceToNow(new Date(role.updated_at), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="gap-1 border-b border-ink-700 px-5 py-4 pr-12 text-left">
            <DialogTitle className="text-[15px] text-white">New role</DialogTitle>
            <DialogDescription className="text-[11px] text-mist-400">
              A standing employee. Shifts are scheduled separately.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <div className="scrollbar-thin max-h-[62vh] space-y-4 overflow-auto px-5 py-4">
              <div className="space-y-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                  Name
                </Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Release Notes"
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
                      variant={form.agent === a.id ? "secondary" : "outline"}
                      onClick={() => setForm({ ...form, agent: a.id })}
                      className={cn(
                        "h-auto flex-col gap-1 border-ink-700 bg-ink-850 px-1 py-2 text-[10px]",
                        form.agent === a.id && "border-white/25 text-white",
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                    Model
                  </Label>
                  <Input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="default"
                    className="border-ink-700 bg-ink-850 font-mono text-[11.5px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                    Weekly budget (USD)
                  </Label>
                  <Input
                    value={form.budget}
                    onChange={(e) => setForm({ ...form, budget: e.target.value })}
                    placeholder="no cap"
                    inputMode="decimal"
                    className="border-ink-700 bg-ink-850 font-mono text-[11.5px]"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                  Working directory
                </Label>
                <Input
                  value={form.cwd}
                  onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                  placeholder="~/Documents/Github/my-project"
                  className="border-ink-700 bg-ink-850 font-mono text-[11.5px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                  Playbook
                </Label>
                <Textarea
                  value={form.playbook}
                  onChange={(e) =>
                    setForm({ ...form, playbook: e.target.value })
                  }
                  rows={4}
                  placeholder="Identity, duties, success criteria, and what to put in reports."
                  className="min-h-[96px] resize-none border-ink-700 bg-ink-850 text-[12px]"
                />
              </div>
              {error && (
                <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-300">
                  {error}
                </div>
              )}
            </div>
            <DialogFooter className="border-t border-ink-700 px-5 py-3.5">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating} className="gap-1.5">
                {creating && <Loader2 size={13} className="animate-spin" />}
                Create role
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
