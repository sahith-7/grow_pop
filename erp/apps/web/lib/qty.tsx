'use client';

// A quantity box with − and + beside it (v2 Phase 1). The box still takes typing (2.5 kg); the buttons move by one
// whole unit and never go below `min` or above `max`.

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function QtyStepper({ value, onChange, label, min = 0, max, step = 1, width = 64, invalid, disabled, decimals = true, placeholder }: {
  value: string; onChange: (v: string) => void; label: string;
  min?: number; max?: number; step?: number; width?: number; invalid?: boolean; disabled?: boolean; decimals?: boolean; placeholder?: string;
}) {
  const typed = value.trim() !== '' && Number.isFinite(Number(value));
  const n = typed ? Number(value) : 0;
  const canLess = !disabled && typed && round3(n - step) >= min;
  const canMore = !disabled && (max === undefined || round3(n + step) <= max);
  const bump = (d: number) => {
    const next = round3((typed ? n : 0) + d);
    if (next < min || (max !== undefined && next > max)) return;
    onChange(String(next));
  };
  return (
    <span className="gp-qty" role="group" aria-label={label}>
      <button type="button" className="gp-qty-btn" aria-label={`One less: ${label}`} tabIndex={-1} disabled={!canLess} onClick={() => bump(-step)}>−</button>
      <input className="ui-input ui-input--num gp-qty-input" style={{ width }} inputMode={decimals ? 'decimal' : 'numeric'} value={value} placeholder={placeholder}
        aria-label={label} aria-invalid={invalid || undefined} disabled={disabled}
        onChange={(e) => onChange(e.target.value.trim())}
        onKeyDown={(e) => {   // ↑ / ↓ in the box also step, like a number field
          if (e.key === 'ArrowUp') { e.preventDefault(); bump(step); } else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-step); }
        }} />
      <button type="button" className="gp-qty-btn" aria-label={`One more: ${label}`} tabIndex={-1} disabled={!canMore} onClick={() => bump(step)}>+</button>
    </span>
  );
}
