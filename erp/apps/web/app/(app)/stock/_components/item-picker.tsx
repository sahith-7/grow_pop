'use client';

import { useRef, useState } from 'react';
import { attrLabel } from '../../../../lib/format';
import { api, type Balance, type Picked } from '../../../../lib/stock-api';
import { Suggestions, useSuggest } from '../../../../lib/suggest';

/**
 * Scan or search box that adds an item to a form. A scanner types the code and presses Enter: an exact barcode or SKU
 * is added straight away (and again on every scan). Anything else shows matching items to pick from.
 */
export function ItemPicker({ onPick, placeholder = 'Scan a barcode or search name / SKU', autoFocus }: {
  onPick: (item: Picked) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Balance[] | null>(null);
  const [state, setState] = useState<'' | 'ok' | 'error'>('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Matches while typing (a scanner is faster than the delay and ends with Enter, which still adds the exact code).
  const sg = useSuggest<Balance>({ q, delay: 250, load: (t) => api<{ items: Balance[] }>(`/stock/balances?limit=8&q=${encodeURIComponent(t)}`).then((r) => r.data.items) });

  const done = (item: Picked) => { sg.quiet(''); sg.close(); onPick(item); setQ(''); setMatches(null); setState('ok'); setMessage(`Added ${item.sku}`); input.current?.focus(); };

  const submit = async () => {
    const term = q.trim();
    if (!term) return;
    setMessage('');
    if (/^\S+$/.test(term)) {
      try {
        const { data } = await api<{ productName: string; variant: { id: string; sku: string; barcode: string | null; attributes: Record<string, string>; cost?: string | null } }>(`/lookup?code=${encodeURIComponent(term)}`);
        return done({ variantId: data.variant.id, sku: data.variant.sku, name: data.productName, attributes: data.variant.attributes, barcode: data.variant.barcode, cost: data.variant.cost });
      } catch { /* not an exact code: search by name */ }
    }
    try {
      const { data } = await api<{ items: Balance[] }>(`/stock/balances?limit=10&q=${encodeURIComponent(term)}`);
      if (data.items.length === 1) return done(data.items[0]);
      setMatches(data.items);
      setState(data.items.length ? '' : 'error');
      if (!data.items.length) setMessage(`Nothing matches “${term}”`);
    } catch { setState('error'); setMessage('Search failed. Check your connection.'); }
  };

  return (
    <div style={{ position: 'relative' }}>
      {/* Not a <form>: the picker sits inside the page's own form, and Enter here must never submit that. */}
      <div role="search">
        <div className="gp-suggest">
          <label className="ui-scan" data-state={state || undefined}>
            <span className="ui-scan-dot" aria-hidden />
            <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setState(''); setMatches(null); }} placeholder={placeholder} aria-label="Scan or search item" autoFocus={autoFocus}
              enterKeyHint="search" {...sg.inputProps}
              onKeyDown={(e) => { if (sg.onKeyDown(e, done)) return; if (e.key === 'Enter') { e.preventDefault(); sg.close(); submit(); } }} />
          </label>
          <Suggestions s={sg} onPick={done} label="Matching items" render={(m) => (<>
            <span className="gp-suggest-title">{m.name}{Object.keys(m.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(m.attributes)}</span>}</span>
            <span className="gp-suggest-end">{m.onHand} on hand</span>
            <span className="gp-suggest-sub ui-code">{m.sku}</span>
          </>)} />
        </div>
      </div>
      <div className="ui-help" aria-live="polite" style={{ minHeight: 18, color: state === 'error' ? 'var(--danger)' : undefined }}>{message}</div>
      {matches && matches.length > 0 && (
        <div className="ui-menu" role="listbox" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, maxHeight: 280, overflow: 'auto' }}>
          {matches.map((m) => (
            <button key={m.variantId} type="button" className="ui-list-row" role="option" aria-selected={false} style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
              onClick={() => done(m)}>
              <span style={{ flex: 1 }}>{m.name}{Object.keys(m.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(m.attributes)}</span>}</span>
              <span className="ui-code">{m.sku}</span>
              <span className="ui-muted ui-num">{m.onHand} on hand</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Product name, variant attributes and SKU for a table cell. */
export function ItemCell({ item }: { item: { name: string; sku: string; attributes: Record<string, string> } }) {
  return (
    <div>
      <div className="ui-cell-title">{item.name}{Object.keys(item.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(item.attributes)}</span>}</div>
      <div className="ui-cell-sub ui-code">{item.sku}</div>
    </div>
  );
}
