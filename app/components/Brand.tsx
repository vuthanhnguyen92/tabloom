import { TabloomMark } from "../../shared/TabloomMark";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand" aria-label="Tabloom">
      <TabloomMark className="brand-mark" />
      {!compact && <span className="brand-name">tabloom</span>}
    </span>
  );
}
