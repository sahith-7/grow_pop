'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api';

// Search suggestions (v2 Phase 1, D102). Any search box can show matches under it while you type.
// ↓ / ↑ move through them, Enter opens the highlighted one, Esc closes the list. With nothing highlighted, Enter does
// what the box always did (search the list, or add a scanned code), so barcode scanners keep working.

export type SearchKind = 'product' | 'customer' | 'supplier' | 'invoice' | 'order' | 'return';
export interface SearchHit { kind: string; type: SearchKind; id: string; title: string; subtitle: string | null; href: string }

/** Records from the shared search, limited to some kinds. */
export const searchHits = (q: string, kinds: SearchKind[], limit = 6) =>
  api<{ items: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}&kinds=${kinds.join(',')}&limit=${limit}`).then((r) => r.items);

export interface Suggest<T> {
  items: T[]; open: boolean; active: number;
  setActive: (i: number) => void;
  close: () => void;
  /** Don't suggest for this exact value (call it before setting the box to what was picked). */
  quiet: (value: string) => void;
  /** Arrow keys, Enter and Esc. Returns true when it used the key, so the caller skips its own Enter. */
  onKeyDown: (e: React.KeyboardEvent, pick: (item: T) => void) => boolean;
  inputProps: {
    role: 'combobox'; 'aria-expanded': boolean; 'aria-controls': string; 'aria-autocomplete': 'list';
    'aria-activedescendant': string | undefined; autoComplete: 'off'; onBlur: () => void;
  };
  listId: string;
}

export function useSuggest<T>({ q, load, min = 2, delay = 200, enabled = true }: {
  q: string; load: (q: string) => Promise<T[]>; min?: number; delay?: number; enabled?: boolean;
}): Suggest<T> {
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const skip = useRef<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const listId = `sg${useId().replace(/:/g, '')}`;

  useEffect(() => {
    const term = q.trim();
    setActive(-1);
    const n = ++seq.current;
    if (skip.current !== null && skip.current === q) { skip.current = null; setOpen(false); return; }
    skip.current = null;
    if (!enabled || term.length < min) { setItems([]); setOpen(false); return; }
    const t = setTimeout(() => {
      loadRef.current(term)
        .then((r) => { if (n === seq.current) { setItems(r); setOpen(r.length > 0); } })
        .catch(() => { if (n === seq.current) { setItems([]); setOpen(false); } });
    }, delay);
    return () => clearTimeout(t);
  }, [q, min, delay, enabled]);

  const close = () => { seq.current++; setOpen(false); setActive(-1); };
  const onKeyDown = (e: React.KeyboardEvent, pick: (item: T) => void) => {
    if (!open) {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setOpen(true); setActive(0); return true; }
      return false;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? items.length - 1 : a - 1)); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return true; }
    if (e.key === 'Enter' && active >= 0 && items[active]) { e.preventDefault(); const it = items[active]; close(); pick(it); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') close();
    return false;
  };
  return {
    items, open, active, setActive, close, onKeyDown, listId,
    quiet: (value: string) => { skip.current = value; },
    inputProps: {
      role: 'combobox', 'aria-expanded': open, 'aria-controls': listId, 'aria-autocomplete': 'list',
      'aria-activedescendant': open && active >= 0 ? `${listId}-${active}` : undefined, autoComplete: 'off', onBlur: close,
    },
  };
}

/** The list under the box. Put it right after the input, inside an element with class gp-suggest. */
export function Suggestions<T>({ s, onPick, render, label = 'Suggestions' }: {
  s: Suggest<T>; onPick: (item: T) => void; render: (item: T) => React.ReactNode; label?: string;
}) {
  if (!s.open || !s.items.length) return null;
  return (
    <ul className="gp-suggest-list" role="listbox" id={s.listId} aria-label={label}>
      {s.items.map((it, i) => (
        <li key={i} id={`${s.listId}-${i}`} role="option" aria-selected={i === s.active}
          onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => s.setActive(i)} onClick={() => { s.close(); onPick(it); }}>
          {render(it)}
        </li>
      ))}
    </ul>
  );
}

/** How a shared-search hit looks in a list: what it is, its name, and a detail line. */
export function HitRow({ hit, showKind = false }: { hit: SearchHit; showKind?: boolean }) {
  return (
    <>
      {showKind && <span className="gp-suggest-kind">{hit.kind}</span>}
      <span className="gp-suggest-title">{hit.title}</span>
      {hit.subtitle && <span className="gp-suggest-sub">{hit.subtitle}</span>}
    </>
  );
}
