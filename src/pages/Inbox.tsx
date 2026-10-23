import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  FileText,
  Inbox,
  Loader2,
  X,
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  approveProposal,
  denyProposal,
  fetchInbox,
  fetchProposals,
  inTauri,
  markRead,
} from "@/lib/api";
import { demoInbox, demoProposals } from "@/lib/demo";
import type { InboxMessage, Schedule } from "@/lib/types";
import { cn } from "@/lib/time";

type Tab = "messages" | "proposals";

function parseAction(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const KIND = {
  attention: {
    icon: AlertTriangle,
    label: "Needs you",
    className: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  },
  report: {
    icon: FileText,
    label: "Report",
    className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  },
  info: {
    icon: Inbox,
    label: "Info",
    className: "border-ink-600 text-mist-400",
  },
};

export function InboxPage() {
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get("tab") === "proposals"
      ? "proposals"
      : "messages",
  );
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [proposals, setProposals] = useState<Schedule[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!inTauri()) {
        const inbox = demoInbox();
        if (!cancelled) {
          setMessages(inbox.messages);
          setUnread(inbox.unread);
          setProposals(demoProposals());
          setLoading(false);
        }
        return;
      }
      try {
        const [inbox, props] = await Promise.all([
          fetchInbox(),
          fetchProposals(),
        ]);
        if (!cancelled) {
          setMessages(inbox.messages ?? []);
          setUnread(inbox.unread ?? 0);
          setProposals(props);
        }
      } catch {
        if (!cancelled) {
          const inbox = demoInbox();
          setMessages(inbox.messages);
          setUnread(inbox.unread);
          setProposals(demoProposals());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function readOne(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, read_at: m.read_at ?? Date.now() } : m)),
    );
    setUnread((n) => Math.max(0, n - 1));
    if (inTauri()) {
      try {
        await markRead([id]);
      } catch {
        /* leave optimistic state */
      }
    }
  }

  async function readAll() {
    setMessages((prev) =>
      prev.map((m) => ({ ...m, read_at: m.read_at ?? Date.now() })),
    );
    setUnread(0);
    if (inTauri()) {
      try {
        await markRead();
      } catch {
        /* leave optimistic state */
      }
    }
  }

  async function approve(id: string) {
    setBusyId(id);
    try {
      if (inTauri()) await approveProposal(id);
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  async function deny(id: string) {
    setBusyId(id);
    try {
      if (inTauri()) await denyProposal(id);
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageShell
      title="Inbox"
      subtitle="Only the things that genuinely need your call."
      action={
        unread > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={readAll}
            className="gap-1.5 border-ink-700 text-[11px]"
          >
            <CheckCheck size={13} />
            Mark all read
          </Button>
        ) : undefined
      }
    >
      <div className="mb-4 flex items-center gap-1 border-b border-ink-800">
        {(
          [
            ["messages", "Messages", messages.length, unread],
            ["proposals", "Proposals", proposals.length, proposals.length],
          ] as const
        ).map(([key, label, count, badge]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors",
              tab === key
                ? "border-brand text-white"
                : "border-transparent text-mist-400 hover:text-mist-200",
            )}
          >
            {label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[9px] tabular-nums",
                badge > 0
                  ? "bg-brand/15 text-brand"
                  : "bg-ink-700 text-mist-400",
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-mist-400">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : tab === "messages" ? (
        messages.length === 0 ? (
          <Empty
            title="Nothing needs you"
            body="Approvals, reports and failed runs land here. A quiet inbox is a good inbox."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-ink-700">
            {messages.map((m) => {
              const kind = KIND[m.kind] ?? KIND.info;
              const Icon = kind.icon;
              const unreadRow = !m.read_at;
              return (
                <button
                  key={m.id}
                  onClick={() => readOne(m.id)}
                  className={cn(
                    "flex w-full items-start gap-3 border-b border-ink-800 px-4 py-3 text-left transition-colors last:border-0 hover:bg-ink-850",
                    unreadRow && "bg-ink-900",
                  )}
                >
                  <div
                    className={cn(
                      "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border",
                      kind.className,
                    )}
                  >
                    <Icon size={12} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-[12px]",
                          unreadRow
                            ? "font-semibold text-white"
                            : "font-medium text-mist-200",
                        )}
                      >
                        {m.subject || "(no subject)"}
                      </span>
                      {unreadRow && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      )}
                      <span className="ml-auto shrink-0 text-[9.5px] text-mist-400/70">
                        {formatDistanceToNow(new Date(m.created_at), {
                          addSuffix: true,
                        })}
                      </span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-mist-400">
                      {m.body}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[9.5px] text-mist-400/70">
                      {m.role_name && <span>{m.role_name}</span>}
                      <span className="text-mist-400/40">·</span>
                      <span className="uppercase tracking-wider">{kind.label}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )
      ) : proposals.length === 0 ? (
        <Empty
          title="No proposals"
          body="When an agent wants to schedule work outside its envelope, it asks here first."
        />
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => {
            const action = parseAction(p.action_value);
            return (
              <Card
                key={p.id}
                className="gap-3 border-ink-700 bg-ink-900 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-[13px] font-semibold text-white">
                        {p.name || "Proposed job"}
                      </h2>
                      <Badge
                        variant="brand"
                        className="h-4 px-1.5 text-[9px] uppercase tracking-wider"
                      >
                        proposed
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-mist-400">
                      {p.fire_at
                        ? new Date(p.fire_at).toLocaleString()
                        : p.when_type === "next_reset"
                          ? "at next reset"
                          : p.when_value}
                      {" · "}
                      {String(action.agent ?? "claude")}
                    </div>
                  </div>
                </div>
                <p className="line-clamp-3 rounded-lg border border-ink-800 bg-ink-850 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-mist-300">
                  {String(action.prompt ?? "—")}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => approve(p.id)}
                    disabled={busyId === p.id}
                    className="gap-1.5"
                  >
                    {busyId === p.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Check size={12} />
                    )}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deny(p.id)}
                    disabled={busyId === p.id}
                    className="gap-1.5 border-ink-700"
                  >
                    <X size={12} />
                    Deny
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-[50vh] items-center justify-center">
      <div className="max-w-[340px] text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-ink-800 text-mist-400">
          <Inbox size={17} />
        </div>
        <h2 className="text-[13px] font-semibold text-white">{title}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-mist-400">{body}</p>
      </div>
    </div>
  );
}
