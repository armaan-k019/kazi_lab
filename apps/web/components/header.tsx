export function Header({ compact = false }: { compact?: boolean }) {
  // The lab name is display type: large, confident, the page's one piece of
  // hero typography. Compact mode (the shells) keeps it to a single line.
  if (compact) {
    return (
      <header className="flex items-baseline gap-3 pb-3 pt-5">
        <h1 className="font-display text-headline leading-none text-ink">kazi lab</h1>
        <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-green" aria-hidden="true" />
        <p className="text-small text-ink-500">applied CS for spatial reasoning</p>
      </header>
    );
  }
  return (
    <header className="pt-14 pb-10">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-hero leading-none text-ink">kazi lab</h1>
        <span className="h-2 w-2 shrink-0 self-center rounded-full bg-green" aria-hidden="true" />
      </div>
      <p className="mt-3 text-mid text-ink-600">applied CS for spatial reasoning</p>
    </header>
  );
}
