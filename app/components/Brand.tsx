export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand" aria-label="Tabloom">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact && <span className="brand-name">tabloom</span>}
    </span>
  );
}
