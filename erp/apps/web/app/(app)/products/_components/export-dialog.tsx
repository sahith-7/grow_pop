'use client';

import { useState } from 'react';
import { useCan } from '../../../../lib/me';

// The product export asks first (v2, D100): which products, which columns. "Everything" is the import-ready file.

const GROUPS: { label: string; keys: { key: string; label: string; cost?: boolean }[] }[] = [
  { label: 'Prices', keys: [{ key: 'price', label: 'Selling price' }, { key: 'mrp', label: 'MRP' }, { key: 'cost', label: 'Cost price', cost: true }] },
  { label: 'Codes and grouping', keys: [{ key: 'barcode', label: 'Barcode' }, { key: 'category', label: 'Category' }, { key: 'brand', label: 'Brand' }, { key: 'unit', label: 'Unit' }] },
  { label: 'Tax', keys: [{ key: 'hsn_code', label: 'HSN code' }, { key: 'gst_rate', label: 'GST rate' }] },
  { label: 'Variants', keys: [{ key: 'size', label: 'Size' }, { key: 'colour', label: 'Colour' }, { key: 'model', label: 'Model' }, { key: 'material', label: 'Material' }] },
  { label: 'Stock and more', keys: [{ key: 'stock_on_hand', label: 'Stock on hand (all locations)' }, { key: 'reorder_level', label: 'Min qty' }, { key: 'net_weight', label: 'Net weight' },
    { key: 'weight_g', label: 'Shipping weight (g)' }, { key: 'status', label: 'Status' }, { key: 'description', label: 'Description' }] },
];

export interface ExportScope { filter: Record<string, string>; filterLabel: string | null; selected: string[] }

export function ExportDialog({ scope, onClose }: { scope: ExportScope; onClose: () => void }) {
  const showCost = useCan('cost.view');
  const [which, setWhich] = useState<'all' | 'filter' | 'selected'>(scope.selected.length ? 'selected' : scope.filterLabel ? 'filter' : 'all');
  const [mode, setMode] = useState<'everything' | 'choose'>('everything');
  const [cols, setCols] = useState<Set<string>>(new Set(['price', 'mrp', 'barcode', 'category', 'stock_on_hand']));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (k: string) => setCols((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const download = async () => {
    setBusy(true); setError('');
    const qs = new URLSearchParams();
    if (which === 'filter') for (const [k, v] of Object.entries(scope.filter)) qs.set(k, v);
    if (which === 'selected') qs.set('productIds', scope.selected.join(','));
    if (mode === 'choose') qs.set('columns', [...cols].join(','));
    try {
      const res = await fetch(`/api/v1/exports/products.csv${qs.size ? `?${qs}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(res.status === 429 ? 'Too many exports in the last hour. Try again later.' : j?.message ?? 'The export failed');
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'products.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onClose();
    } catch (e) { setError((e as Error).message || 'Something went wrong. Check your connection and try again.'); } finally { setBusy(false); }
  };

  const radio = (name: string, value: string, checked: boolean, onChange: () => void, label: React.ReactNode) => (
    <label className="ui-check"><input type="radio" name={name} value={value} checked={checked} onChange={onChange} /> {label}</label>
  );

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="export-title" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="export-title">Export products</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }}>
            <legend className="ui-label" style={{ marginBottom: 'var(--space-2)' }}>Which products</legend>
            {radio('which', 'all', which === 'all', () => setWhich('all'), 'All products (not archived)')}
            {scope.filterLabel && radio('which', 'filter', which === 'filter', () => setWhich('filter'), <>Only those shown now: {scope.filterLabel}</>)}
            {scope.selected.length > 0 && radio('which', 'selected', which === 'selected', () => setWhich('selected'), `The ${scope.selected.length} I selected`)}
          </fieldset>
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }}>
            <legend className="ui-label" style={{ marginBottom: 'var(--space-2)' }}>Which columns</legend>
            {radio('mode', 'everything', mode === 'everything', () => setMode('everything'), 'Everything, ready to import back')}
            {radio('mode', 'choose', mode === 'choose', () => setMode('choose'), 'Let me choose')}
            {mode === 'choose' && (
              <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-2)', paddingLeft: 'var(--space-5)' }}>
                <span className="ui-help">Product name and SKU are always included.</span>
                {GROUPS.map((g) => (
                  <div key={g.label}>
                    <div className="ui-caption" style={{ fontWeight: 600 }}>{g.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--space-4)' }}>
                      {g.keys.filter((k) => !k.cost || showCost).map((k) => (
                        <label key={k.key} className="ui-check"><input type="checkbox" checked={cols.has(k.key)} onChange={() => toggle(k.key)} /> {k.label}</label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>
          <p className="ui-help" style={{ margin: 0 }}>A CSV file. Excel and Google Sheets open it. Exports are recorded in Logs.</p>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy || (mode === 'choose' && cols.size === 0)} aria-busy={busy} onClick={download}>Download CSV</button>
        </div>
      </div>
    </div>
  );
}
