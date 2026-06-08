export function Header() {
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
