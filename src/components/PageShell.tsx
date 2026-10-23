import type { ReactNode } from "react";

export function PageShell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700/70 px-6 py-4">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight text-white">
            {title}
          </h1>
          <p className="mt-0.5 text-[11px] text-mist-400">{subtitle}</p>
        </div>
        {action}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-6">
        {children}
      </div>
    </div>
  );
}
