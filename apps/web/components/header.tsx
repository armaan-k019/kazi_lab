export function Header({ compact = false }: { compact?: boolean }) {
  // Compact mode: the Discovery shell budgets vertical space for the portal,
  // so the header shrinks to a single line there.
  if (compact) {
    return (
      <header className="flex items-baseline gap-2.5 pb-3 pt-5">
        <h1 className="text-lg font-semibold tracking-tight text-text-primary">kazi lab</h1>
        <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" aria-hidden="true" />
        <p className="text-[13px] text-text-secondary">applied CS for spatial reasoning</p>
      </header>
    );
  }
  return (
    <header className="pt-14 pb-8">
      <div className="flex items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-text-primary">
          kazi lab
        </h1>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
      </div>
      <p className="mt-1.5 text-sm text-text-secondary">
        applied CS for spatial reasoning
      </p>
    </header>
  );
}
