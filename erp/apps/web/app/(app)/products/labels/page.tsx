'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { code128Modules, ean13Modules, isEan13 } from '../../../../lib/barcode-svg';
import { api, ApiError, errorText } from '../../../../lib/catalog-api';
import { money } from '../../../../lib/format';
import { DEFAULTS, geometry, PAPER_LABEL, PRESETS, type Design, type LabelSettings, type Layout, type Paper, type Show } from '../../../../lib/labels';
import { useCan, useMe } from '../../../../lib/me';
import type { Picked } from '../../../../lib/stock-api';
import { ItemPicker } from '../../stock/_components/item-picker';
import { QtyStepper } from '../../../../lib/qty';

// Barcode labels (v2, D98): for one product, for products ticked on the Products list, or for a goods receipt.
// Any size: label-printer rolls (1, 2 or 3 across) and A4/A5 sheets, plus the store's own sizes. The chosen size,
// design and fields can be saved as the store's default.

interface Label {
  variantId: string; copies: number; code: string; codeSource: 'barcode' | 'sku'; sku: string; name: string; price: string; mrp: string | null;
  productName: string; variant: string | null; brand: string | null; netWeight: string | null;
}

function Bars({ code, text }: { code: string; text: boolean }) {
  const ean = isEan13(code);
  const modules = ean ? ean13Modules(code) : code128Modules(code);
  if (!modules) return <div style={{ fontSize: '6pt', color: '#b42318' }}>Cannot print “{code}” as a barcode</div>;
  const quiet = ean ? 9 : 10; // quiet zones in modules, needed for reliable scans
  const width = modules.length + quiet * 2;
  const rects: React.ReactNode[] = [];
  for (let i = 0; i < modules.length; ) {
    if (modules[i] !== '1') { i++; continue; }
    let j = i; while (modules[j] === '1') j++;
    const guard = ean && (i < 3 || (i >= 45 && i < 50) || i >= 92); // EAN guard bars run longer, as on packaging
    rects.push(<rect key={i} x={quiet + i} y={0} width={j - i} height={guard ? 46 : 40} />);
    i = j;
  }
  return (
    <svg viewBox={`0 0 ${width} ${text ? 52 : 46}`} preserveAspectRatio="none" style={{ width: '100%', flex: '1 1 auto', minHeight: 0, display: 'block' }}
      role="img" aria-label={`Barcode ${code}`} shapeRendering="crispEdges">
      <g fill="#000">{rects}</g>
      {text && <text x={width / 2} y={51.5} fontSize={7} textAnchor="middle" fontFamily="monospace">{code}</text>}
    </svg>
  );
}

// Text gets at most 60% of the label's height so the barcode always keeps room to scan. The font size is worked out
// from how many text lines the design shows, capped by the label's width. One size is used for the whole print
// run (the smallest any label needs), so a sheet doesn't mix big and small text.
const nameOf = (l: Label, show: Show) => `${l.productName}${show.variant && l.variant ? ` · ${l.variant}` : ''}`;
function fontFor(design: Design, show: Show, l: Label, w: number, h: number) {
  const mrpDiffers = !!l.mrp && Number(l.mrp) !== Number(l.price);
  const inner = h - 2 * Math.min(1.5, h * 0.05);
  const innerW = w - 2 * Math.min(2, w * 0.05);
  const size = (nameLines: number) => {
    const lines = design === 'compact' ? (show.price ? 1 : 0)
      : (show.store ? 0.85 : 0) + (show.name ? nameLines : 0) + (design === 'mrp'
        ? (show.mrp && l.mrp ? 1.2 : 0) + (show.price && (mrpDiffers || !l.mrp || !show.mrp) ? 0.85 : 0) + (show.sku || (show.netWeight && l.netWeight) ? 0.85 : 0)
        : 1);
    // One line is pt × 0.3528 mm × 1.15 line height, plus the 0.4 mm gap between rows.
    const byHeight = lines ? (inner * 0.6 - lines * 0.4) / (lines * 0.3528 * 1.15) : 12;
    return Math.max(5, Math.min(12, w * 0.18, byHeight));
  };
  const one = size(1);
  // Bold text averages about 0.58 em per character; a name wider than the label wraps to a second line (tall labels only).
  const wraps = show.name && h >= 30 && nameOf(l, show).length * one * 0.3528 * 0.58 > innerW;
  return wraps ? size(2) : one;
}

const oneLine = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 'none' } as const;

function LabelFace({ l, design, show, store, h, pt }: { l: Label; design: Design; show: Show; store: string; h: number; pt: number }) {
  const nameLines = h >= 30 ? 2 : 1;
  const sub = { fontSize: `${pt * 0.85}pt`, flex: 'none' } as const;
  const priceText = money(l.price);
  const mrpDiffers = l.mrp && Number(l.mrp) !== Number(l.price);
  const nameText = nameOf(l, show);
  const name = show.name && (nameLines === 1
    ? <div style={{ ...oneLine, fontWeight: 700 }}>{nameText}</div>
    : <div style={{ fontWeight: 700, lineHeight: 1.12, flex: 'none', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{nameText}</div>);
  const storeLine = show.store && <div style={{ ...sub, ...oneLine, fontWeight: 600, letterSpacing: '.02em', textTransform: 'uppercase' }}>{store}</div>;
  const weight = show.netWeight && l.netWeight && <span style={{ whiteSpace: 'nowrap' }}>Net {l.netWeight}</span>;

  if (design === 'compact') {
    return (
      <div className="label-face" style={{ fontSize: `${pt}pt` }}>
        <Bars code={l.code} text={show.codeText} />
        {show.price && <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1mm', fontWeight: 700, flex: 'none', whiteSpace: 'nowrap' }}>
          <span>{priceText}</span>{show.mrp && mrpDiffers && <span style={{ ...sub, fontWeight: 400 }}>MRP {money(l.mrp)}</span>}</div>}
      </div>
    );
  }
  if (design === 'mrp') {
    return (
      <div className="label-face" style={{ fontSize: `${pt}pt` }}>
        {storeLine}{name}
        {show.mrp && l.mrp && <div style={{ lineHeight: 1.1, flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}><span style={{ fontWeight: 800, fontSize: `${pt * 1.2}pt` }}>MRP {money(l.mrp)}</span> <span style={{ fontSize: `${pt * 0.7}pt` }}>(incl. of all taxes)</span></div>}
        {show.price && (mrpDiffers || !l.mrp || !show.mrp) && <div style={{ ...sub, whiteSpace: 'nowrap' }}>Our price <b>{priceText}</b></div>}
        <Bars code={l.code} text={show.codeText} />
        {(show.sku || weight) && <div style={{ ...sub, display: 'flex', justifyContent: 'space-between', gap: '1mm', whiteSpace: 'nowrap', overflow: 'hidden' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{show.sku ? l.sku : ''}</span>{weight}</div>}
      </div>
    );
  }
  return (
    <div className="label-face" style={{ fontSize: `${pt}pt` }}>
      {storeLine}{name}
      <Bars code={l.code} text={show.codeText} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1mm', ...sub, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{show.sku ? l.sku : ''}{show.sku && weight ? ' · ' : ''}{weight}</span>
        <span style={{ textAlign: 'right', flex: 'none' }}>
          {show.price && <b style={{ fontSize: `${pt}pt` }}>{priceText}</b>}
          {show.mrp && l.mrp && (mrpDiffers || !show.price) && <span> MRP {show.price ? <s>{money(l.mrp)}</s> : money(l.mrp)}</span>}
        </span>
      </div>
    </div>
  );
}

function LabelsPage() {
  const params = useSearchParams();
  const me = useMe();
  const canSave = useCan('product.write');
  const [labels, setLabels] = useState<Label[]>([]);
  const [settings, setSettings] = useState<LabelSettings>(DEFAULTS);
  const [saved, setSaved] = useState<string>('');
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Layout | null>(null);
  const [message, setMessage] = useState('');

  const source = useMemo(() => {
    const ids = (k: string) => (params.get(k) ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
    if (params.get('receipt')) return { receiptId: params.get('receipt')! };
    if (ids('products').length) return { productIds: ids('products') };
    if (ids('variants').length) return { items: ids('variants').map((variantId) => ({ variantId, copies: 1 })) };
    return null;
  }, [params]);

  useEffect(() => {
    setLoading(true); setError('');
    const req = source
      ? api<{ labels: Label[]; settings: LabelSettings }>('/labels', { method: 'POST', body: source }).then((r) => { setLabels(r.data.labels); return r.data.settings; })
      : api<LabelSettings>('/label-settings').then((r) => r.data);
    req.then((s) => { setSettings(s); setSaved(JSON.stringify(s)); }).catch((e) => setError(errorText(e))).finally(() => setLoading(false));
  }, [source]);

  const layouts = [...PRESETS, ...settings.custom];
  const layout = layouts.find((l) => l.id === settings.layout) ?? PRESETS[0];
  const g = geometry(layout);
  const sheet = layout.paper !== 'roll';
  const sequence: (Label | null)[] = [...Array(sheet ? Math.min(skip, g.perPage - 1) : 0).fill(null), ...labels.flatMap((l) => Array.from({ length: l.copies }, () => l))];
  const pages: (Label | null)[][] = [];
  for (let i = 0; i < sequence.length; i += g.perPage) pages.push(sequence.slice(i, i + g.perPage));
  const total = labels.reduce((n, l) => n + l.copies, 0);
  const pt = labels.reduce((m, l) => Math.min(m, fontFor(settings.design, settings.show, l, layout.widthMm, layout.heightMm)), 12);
  const dirty = JSON.stringify(settings) !== saved;

  const add = async (item: Picked) => {
    if (labels.some((l) => l.variantId === item.variantId)) { setLabels(labels.map((l) => (l.variantId === item.variantId ? { ...l, copies: Math.min(200, l.copies + 1) } : l))); return; }
    try {
      const { data } = await api<{ labels: Label[] }>('/labels', { method: 'POST', body: { items: [{ variantId: item.variantId, copies: 1 }] } });
      setLabels([...labels, ...data.labels]);
    } catch (e) { setError(errorText(e)); }
  };
  const save = async (next: LabelSettings = settings) => {
    setError(''); setMessage('');
    try { const { data } = await api<LabelSettings>('/label-settings', { method: 'PUT', body: next }); setSettings(data); setSaved(JSON.stringify(data)); setMessage('Saved as the store’s default.'); }
    catch (e) { setError(e instanceof ApiError && Object.keys(e.fieldErrors).length ? `${e.message}: ${Object.values(e.fieldErrors).flat().join('; ')}` : errorText(e)); }
  };
  const setShow = (k: keyof Show, v: boolean) => setSettings({ ...settings, show: { ...settings.show, [k]: v } });

  return (
    <div className="ui-content">
      <style>{`
        @media print {
          @page { size: ${g.pageW}mm ${g.pageH}mm; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body *:not(:has(#label-sheet)):not(#label-sheet):not(#label-sheet *) { display: none !important; }
          body *:has(#label-sheet) { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
            width: auto !important; min-width: 0 !important; max-width: none !important; height: auto !important; min-height: 0 !important; overflow: visible !important; box-shadow: none !important; }
          html, body { height: auto !important; min-height: 0 !important; }
          #label-sheet { display: block !important; gap: 0 !important; padding: 0 !important; overflow: visible !important; }
          #label-sheet .label-page { outline: 0 !important; box-shadow: none !important; margin: 0 !important; break-after: page; }
          #label-sheet .label-page:last-child { break-after: auto; }
          #label-sheet .label { outline: 0 !important; }
        }
        #label-sheet { display: flex; flex-direction: column; gap: 6mm; padding: 4mm 0; overflow-x: auto; }
        .label-page { box-sizing: border-box; width: ${g.pageW}mm; height: ${g.pageH - 0.3}mm; overflow: hidden; background: #fff;
          padding: ${layout.marginTopMm}mm ${layout.marginLeftMm}mm 0; display: grid;
          grid-template-columns: repeat(${layout.columns}, ${layout.widthMm}mm); grid-auto-rows: ${layout.heightMm}mm;
          column-gap: ${layout.gapXMm}mm; row-gap: ${layout.gapYMm}mm; align-content: start; flex: none; }
        @media screen { .label-page { box-shadow: 0 0 0 1px var(--border), 0 1px 3px rgba(0,0,0,.06); } .label { outline: 1px dashed #c3cad6; } }
        .label { box-sizing: border-box; overflow: hidden; padding: ${Math.min(1.5, layout.heightMm * 0.05)}mm ${Math.min(2, layout.widthMm * 0.05)}mm; color: #000; background: #fff; }
        .label-face { height: 100%; display: flex; flex-direction: column; gap: .4mm; font-family: var(--font-sans); line-height: 1.15; color: #000; }
      `}</style>
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">Print labels</h1>
          <div className="ui-caption">Set the printer’s paper to {g.pageW.toFixed(1).replace(/\.0$/, '')} × {g.pageH.toFixed(1).replace(/\.0$/, '')} mm, scale 100%, no margins.</div></div>
        <div className="ui-actions">
          <button className="ui-btn ui-btn--primary" type="button" disabled={!total || !g.fits} onClick={() => window.print()}>Print {total || ''} label{total === 1 ? '' : 's'}</button>
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {message && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">{message}</div></div>}

      <div className="ui-panel">
        <div className="ui-panel-head"><h2 className="ui-h3">Items</h2></div>
        <div className="ui-panel-body"><ItemPicker onPick={add} placeholder="Scan or search to add" /></div>
        {loading ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 80 }} /></div>
          : labels.length === 0 ? <div className="ui-empty"><p className="ui-muted">Add items above, tick products on the Products list, or open a goods receipt and choose Print labels.</p></div>
          : (
            <div className="ui-table-wrap"><table className="ui-table">
              <thead><tr><th scope="col">Item</th><th scope="col">Code</th><th scope="col" className="ui-money">Price</th><th scope="col" className="ui-qty">Copies</th><th scope="col"><span className="ui-sr-only">Remove</span></th></tr></thead>
              <tbody>{labels.map((l, i) => (
                <tr key={l.variantId}>
                  <td><span className="ui-cell-title">{l.productName}</span>{l.variant && <div className="ui-cell-sub">{l.variant}</div>}</td>
                  <td className="ui-code">{l.code}{l.codeSource === 'sku' && <span className="ui-badge ui-badge--warning" style={{ marginLeft: 8 }}>No barcode, using SKU</span>}</td>
                  <td className="ui-money">{money(l.price)}{l.mrp && <div className="ui-cell-sub">MRP {money(l.mrp)}</div>}</td>
                  <td className="ui-qty"><QtyStepper label={`Copies of ${l.name}`} min={0} max={200} decimals={false} width={52}
                    value={String(l.copies)} onChange={(v) => setLabels(labels.map((x, j) => (j === i ? { ...x, copies: Math.max(0, Math.min(200, Math.floor(Number(v)) || 0)) } : x)))} /></td>
                  <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" aria-label={`Remove ${l.name}`} onClick={() => setLabels(labels.filter((_, j) => j !== i))}>Remove</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
      </div>

      <div className="ui-panel">
        <div className="ui-panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <h2 className="ui-h3">Size and design</h2>
          {canSave && <button className="ui-btn ui-btn--sm" type="button" disabled={!dirty} onClick={() => save()}>{dirty ? 'Save as default' : 'Saved as default'}</button>}
        </div>
        <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <div className="ui-form-grid">
            <label className="ui-field"><span className="ui-label">Label size</span>
              <select className="ui-select" value={layout.id} onChange={(e) => { setSettings({ ...settings, layout: e.target.value }); setSkip(0); }}>
                {(['roll', 'a4', 'a5'] as Paper[]).map((p) => (
                  <optgroup key={p} label={PAPER_LABEL[p]}>{layouts.filter((l) => l.paper === p).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
                ))}
              </select>
              <span className="ui-help">{sheet ? `${g.perPage} labels per ${layout.paper.toUpperCase()} page` : `${layout.columns} label${layout.columns > 1 ? 's' : ''} across a ${g.pageW.toFixed(1).replace(/\.0$/, '')} mm roll`}
                {canSave && <> · <button className="gp-link-btn" type="button" onClick={() => setEditing({ ...layout, id: layout.id.startsWith('custom-') ? layout.id : `custom-${Date.now().toString(36)}`, name: layout.id.startsWith('custom-') ? layout.name : `My ${layout.name}`.slice(0, 40) })}>
                  {layout.id.startsWith('custom-') ? 'Edit this size' : 'Make my own size'}</button></>}</span>
            </label>
            <label className="ui-field"><span className="ui-label">Design</span>
              <select className="ui-select" value={settings.design} onChange={(e) => setSettings({ ...settings, design: e.target.value as Design })}>
                <option value="standard">Standard: name, barcode, price</option>
                <option value="mrp">MRP first: MRP (incl. of all taxes), our price</option>
                <option value="compact">Compact: barcode and price only</option>
              </select></label>
            {sheet && <label className="ui-field"><span className="ui-label">Skip used labels on the first sheet</span>
              <input className="ui-input ui-input--num" type="number" min={0} max={g.perPage - 1} value={skip} onChange={(e) => setSkip(Math.max(0, Math.min(g.perPage - 1, Math.floor(Number(e.target.value)) || 0)))} /></label>}
          </div>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="ui-label" style={{ marginBottom: 'var(--space-1)' }}>Show on the label</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--space-4)' }}>
              {([['store', `Store name (${me.tenant.name})`], ['name', 'Product name'], ['variant', 'Size / colour'], ['price', 'Selling price'], ['mrp', 'MRP'],
                ['sku', 'SKU'], ['netWeight', 'Net weight'], ['codeText', 'Code under the barcode']] as [keyof Show, string][]).map(([k, label]) => (
                <label key={k} className="ui-check"><input type="checkbox" checked={settings.show[k]} onChange={(e) => setShow(k, e.target.checked)} /> {label}</label>
              ))}
            </div>
          </fieldset>
          {!g.fits && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">This size is wider than the paper. Edit it before printing.</div></div>}
        </div>
      </div>

      {pages.length > 0 && <h2 className="ui-h3">Preview</h2>}
      <div id="label-sheet" aria-label="Label preview">
        {pages.map((page, pi) => (
          <div className="label-page" key={pi}>
            {page.map((l, i) => (
              <div className="label" key={i}>{l && <LabelFace l={l} design={settings.design} show={settings.show} store={me.tenant.name} h={layout.heightMm} pt={pt} />}</div>
            ))}
          </div>
        ))}
      </div>

      {editing && <LayoutDialog layout={editing} isNew={!settings.custom.some((c) => c.id === editing.id)}
        onClose={() => setEditing(null)}
        onDelete={() => { const next = { ...settings, custom: settings.custom.filter((c) => c.id !== editing.id), layout: settings.layout === editing.id ? DEFAULTS.layout : settings.layout }; setEditing(null); save(next); }}
        onSave={(l) => { const custom = settings.custom.some((c) => c.id === l.id) ? settings.custom.map((c) => (c.id === l.id ? l : c)) : [...settings.custom, l]; setEditing(null); save({ ...settings, custom, layout: l.id }); }} />}
    </div>
  );
}

function LayoutDialog({ layout, isNew, onClose, onSave, onDelete }: { layout: Layout; isNew: boolean; onClose: () => void; onSave: (l: Layout) => void; onDelete: () => void }) {
  const [l, setL] = useState(layout);
  const g = geometry(l);
  const num = (k: keyof Layout, label: string, step = 0.1) => (
    <label className="ui-field"><span className="ui-label">{label}</span>
      <input className="ui-input ui-input--num" type="number" step={step} min={0} value={l[k] as number} onChange={(e) => setL({ ...l, [k]: k === 'columns' ? Math.max(1, Math.min(8, Math.floor(Number(e.target.value)) || 1)) : Math.round(Number(e.target.value) * 20) / 20 || 0 })} /></label>
  );
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <form className="ui-dialog" role="dialog" aria-modal aria-labelledby="layout-title" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(l); }} style={{ maxWidth: 560 }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="layout-title">{isNew ? 'Your own label size' : 'Edit label size'}</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <label className="ui-field"><span className="ui-label">Name</span><input className="ui-input" required maxLength={40} value={l.name} onChange={(e) => setL({ ...l, name: e.target.value })} /></label>
          <label className="ui-field"><span className="ui-label">Paper</span>
            <select className="ui-select" value={l.paper} onChange={(e) => setL({ ...l, paper: e.target.value as Paper })}>
              <option value="roll">Label printer roll</option><option value="a4">A4 sheet</option><option value="a5">A5 sheet</option></select></label>
          <div className="ui-form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
            {num('widthMm', 'Label width (mm)')}{num('heightMm', 'Label height (mm)')}
            {num('columns', 'Labels across', 1)}{num('gapXMm', 'Gap between (mm)')}
            {l.paper !== 'roll' && <>{num('gapYMm', 'Gap between rows (mm)')}{num('marginTopMm', 'Top margin (mm)')}</>}
            {num('marginLeftMm', 'Side margin (mm)')}
          </div>
          <p className={g.fits ? 'ui-help' : 'ui-error'} style={{ margin: 0 }}>
            {g.fits ? (l.paper === 'roll' ? `The printer’s paper width is ${g.pageW.toFixed(1)} mm.` : `${g.perPage} labels per page.`) : 'Too wide for the paper.'}
          </p>
        </div>
        <div className="ui-dialog-foot">
          {!isNew && <button className="ui-btn ui-btn--ghost" type="button" onClick={onDelete} style={{ marginRight: 'auto' }}>Delete this size</button>}
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="submit" disabled={!g.fits || !l.name.trim() || l.columns < 1 || l.widthMm < 10 || l.heightMm < 10}>Save size</button>
        </div>
      </form>
    </div>
  );
}

export default function Page() {
  return <Suspense><LabelsPage /></Suspense>;
}
