'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { api, ApiError, errorText, type Ref } from '../../../../lib/catalog-api';
import { fmtDateTime } from '../../../../lib/datetime';
import { attrLabel, money } from '../../../../lib/format';
import { useCan } from '../../../../lib/me';

// Bulk price update (v2, D97): change many prices by a rule or from a spreadsheet, check every change first, undo later.

type Field = 'price' | 'mrp' | 'cost';
interface Values { price: string; mrp: string | null; cost: string | null }
interface Row { variantId: string; productId: string; version: number; sku: string; name: string; attributes: Record<string, string>; current: Values; next: Values; problem: string | null }
interface Preview { rows: Row[]; unchanged: number; ok: number; matched?: number; errors?: { row: number; sku: string; message: string }[]; sheetRows?: number }
interface Run { id: string; source: 'rule' | 'sheet'; description: string; variantCount: number; createdAt: string; createdBy: string | null; undoneAt: string | null; undoneBy: string | null; undoneCount: number | null }
interface RunLine { variantId: string; productId: string; sku: string; name: string; attributes: Record<string, string>; old: Values; new: Values; stillCurrent: boolean }

const FIELD_LABEL: Record<Field, string> = { price: 'Selling price', mrp: 'MRP', cost: 'Cost price' };
const METHODS: { value: string; label: string; unit: '%' | '₹'; priceOnly?: boolean }[] = [
  { value: 'increase_pct', label: 'Increase by %', unit: '%' },
  { value: 'decrease_pct', label: 'Decrease by %', unit: '%' },
  { value: 'increase_amt', label: 'Increase by ₹', unit: '₹' },
  { value: 'decrease_amt', label: 'Decrease by ₹', unit: '₹' },
  { value: 'set', label: 'Set to ₹', unit: '₹' },
  { value: 'mrp_less_pct', label: 'MRP less %', unit: '%', priceOnly: true },
  { value: 'cost_plus_pct', label: 'Cost plus % (markup)', unit: '%', priceOnly: true },
];
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

function PricesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get('tab') ?? 'rule';
  const productIds = (params.get('products') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
  const showCost = useCan('cost.view');
  const [categories, setCategories] = useState<Ref[]>([]);
  const [brands, setBrands] = useState<Ref[]>([]);
  const [done, setDone] = useState<{ id: string; count: number } | null>(null);

  useEffect(() => {
    api<{ items: Ref[] }>('/categories').then((r) => setCategories(r.data.items.filter((c) => !c.archivedAt))).catch(() => {});
    api<{ items: Ref[] }>('/brands').then((r) => setBrands(r.data.items.filter((c) => !c.archivedAt))).catch(() => {});
  }, []);
  const go = (t: string) => { const p = new URLSearchParams(params); p.set('tab', t); router.replace(`/products/prices?${p}`); };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">Bulk price update</h1>
          <div className="ui-caption">Change many prices at once. You see every change before it is saved, and you can undo a run later.</div></div>
      </div>
      {done && (
        <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">
          <strong>{done.count} price{done.count === 1 ? '' : 's'} changed.</strong> Bills use the new prices from now on, and the website gets them at the next sync.{' '}
          <button className="gp-link-btn" type="button" onClick={() => { setDone(null); go('history'); }}>See it in History, or undo it</button>
        </div></div>
      )}
      <div className="ui-tabs" role="tablist">
        <button className="ui-tab" role="tab" type="button" aria-selected={tab === 'rule'} onClick={() => go('rule')}>By rule</button>
        <button className="ui-tab" role="tab" type="button" aria-selected={tab === 'sheet'} onClick={() => go('sheet')}>From a spreadsheet</button>
        <button className="ui-tab" role="tab" type="button" aria-selected={tab === 'history'} onClick={() => go('history')}>History</button>
      </div>
      {tab === 'rule' && <RuleTab categories={categories} brands={brands} productIds={productIds} showCost={showCost} onDone={(id, count) => setDone({ id, count })} />}
      {tab === 'sheet' && <SheetTab categories={categories} brands={brands} showCost={showCost} onDone={(id, count) => setDone({ id, count })} />}
      {tab === 'history' && <HistoryTab showCost={showCost} />}
    </div>
  );
}

const catLabel = (cats: Ref[], c: Ref) => { const p = cats.find((x) => x.id === c.parentId); return p ? `${p.name} › ${c.name}` : c.name; };

function RuleTab({ categories, brands, productIds, showCost, onDone }: { categories: Ref[]; brands: Ref[]; productIds: string[]; showCost: boolean; onDone: (id: string, n: number) => void }) {
  const [f, setF] = useState({ categoryId: '', brandId: '', q: '', field: 'price' as Field, method: 'increase_pct', value: '', rounding: 'none' });
  const [useSelection, setUseSelection] = useState(productIds.length > 0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const method = METHODS.find((m) => m.value === f.method)!;
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPreview(null); };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({}); setPreview(null);
    const filter = useSelection ? { productIds } : { ...(f.categoryId ? { categoryId: f.categoryId } : {}), ...(f.brandId ? { brandId: f.brandId } : {}), ...(f.q.trim() ? { q: f.q.trim() } : {}) };
    try {
      const { data } = await api<Preview>('/price-updates/preview', { method: 'POST', body: { filter, field: f.field, method: f.method, value: f.value.trim(), rounding: f.rounding } });
      setPreview(data);
    } catch (err) { setError(errorText(err)); if (err instanceof ApiError) setErrors(err.fieldErrors); } finally { setBusy(false); }
  };
  const scope = useSelection ? `${productIds.length} selected product${productIds.length === 1 ? '' : 's'}`
    : [f.categoryId && categories.find((c) => c.id === f.categoryId)?.name, f.brandId && brands.find((b) => b.id === f.brandId)?.name, f.q.trim() && `“${f.q.trim()}”`].filter(Boolean).join(', ') || 'all items';
  const description = `${FIELD_LABEL[f.field]}: ${method.label.replace(/ (%|₹)$/, '')} ${method.unit === '₹' ? `₹${f.value}` : `${f.value}%`}${f.rounding !== 'none' ? `, rounded to ₹${f.rounding}` : ''} (${scope})`;

  return (
    <>
      <form className="ui-panel" onSubmit={run}>
        <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
            <legend className="ui-h3" style={{ marginBottom: 'var(--space-2)' }}>1. Which items</legend>
            {productIds.length > 0 && (
              <div className="ui-segmented" role="group" aria-label="Which items">
                <button type="button" aria-pressed={useSelection} onClick={() => { setUseSelection(true); setPreview(null); }}>The {productIds.length} I selected</button>
                <button type="button" aria-pressed={!useSelection} onClick={() => { setUseSelection(false); setPreview(null); }}>Pick by category or brand</button>
              </div>
            )}
            {!useSelection && (
              <div className="ui-form-grid">
                <label className="ui-field"><span className="ui-label">Category</span>
                  <select className="ui-select" value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                    <option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{catLabel(categories, c)}</option>)}</select></label>
                <label className="ui-field"><span className="ui-label">Brand</span>
                  <select className="ui-select" value={f.brandId} onChange={(e) => set({ brandId: e.target.value })}>
                    <option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
                <label className="ui-field"><span className="ui-label">Name or SKU contains (optional)</span>
                  <input className="ui-input" value={f.q} maxLength={100} onChange={(e) => set({ q: e.target.value })} /></label>
              </div>
            )}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="ui-h3" style={{ marginBottom: 'var(--space-2)' }}>2. The change</legend>
            <div className="ui-form-grid">
              <label className="ui-field"><span className="ui-label">Change</span>
                <select className="ui-select" value={f.field} onChange={(e) => { const field = e.target.value as Field; set({ field, method: field !== 'price' && method.priceOnly ? 'increase_pct' : f.method }); }}>
                  <option value="price">Selling price</option><option value="mrp">MRP</option>{showCost && <option value="cost">Cost price</option>}</select></label>
              <label className="ui-field"><span className="ui-label">How</span>
                <select className="ui-select" value={f.method} onChange={(e) => set({ method: e.target.value })}>
                  {METHODS.filter((m) => !m.priceOnly || f.field === 'price').map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
                {errors.method && <span className="ui-error">{errors.method[0]}</span>}</label>
              <label className="ui-field"><span className="ui-label">{method.unit === '%' ? 'Percent' : 'Amount (₹)'}</span>
                <input className="ui-input ui-input--num" inputMode="decimal" required value={f.value} aria-invalid={!!errors.value} onChange={(e) => set({ value: e.target.value })} placeholder={method.unit === '%' ? '5' : '10'} />
                {errors.value && <span className="ui-error">{errors.value[0]}</span>}</label>
              <label className="ui-field"><span className="ui-label">Round the result</span>
                <select className="ui-select" value={f.rounding} onChange={(e) => set({ rounding: e.target.value })}>
                  <option value="none">To the paisa (no rounding)</option><option value="1">To the nearest ₹1</option><option value="5">To the nearest ₹5</option><option value="10">To the nearest ₹10</option></select></label>
            </div>
            {f.method === 'mrp_less_pct' && <p className="ui-help">Example: MRP ₹120 less 10% gives ₹108. Items without an MRP are left out.</p>}
            {f.method === 'cost_plus_pct' && <p className="ui-help">Example: cost ₹80 plus 25% gives ₹100. Items without a cost price are left out.</p>}
          </fieldset>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        </div>
        <div className="ui-form-footer" style={{ padding: 'var(--space-3) var(--space-4)' }}>
          <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !f.value.trim()} aria-busy={busy}>Check the changes</button>
        </div>
      </form>
      {preview && <PreviewPanel preview={preview} source="rule" initialDescription={description} showCost={showCost} onDone={(id, n) => { setPreview(null); onDone(id, n); }} />}
    </>
  );
}

function SheetTab({ categories, brands, showCost, onDone }: { categories: Ref[]; brands: Ref[]; showCost: boolean; onDone: (id: string, n: number) => void }) {
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qs = new URLSearchParams({ ...(categoryId ? { categoryId } : {}), ...(brandId ? { brandId } : {}) });

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(''); setPreview(null);
    try {
      if (file.size > 1_000_000) throw new Error('big');
      const csv = await file.text();
      const { data } = await api<Preview>('/price-updates/preview-sheet', { method: 'POST', body: { csv } });
      setPreview(data);
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors.csv?.[0] ?? err.message) : (err as Error).message === 'big' ? 'The file is over 1 MB. Split it into smaller sheets.' : errorText(err));
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div>
          <h2 className="ui-h3">1. Download the price sheet</h2>
          <p className="ui-muted">Today’s prices as a CSV file. Open it in Excel or Google Sheets.</p>
          <div className="ui-form-grid">
            <label className="ui-field"><span className="ui-label">Category</span>
              <select className="ui-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{catLabel(categories, c)}</option>)}</select></label>
            <label className="ui-field"><span className="ui-label">Brand</span>
              <select className="ui-select" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          </div>
          <a className="ui-btn" style={{ marginTop: 'var(--space-3)' }} href={`/api/v1/exports/prices.csv${qs.size ? `?${qs}` : ''}`} download>Download price sheet</a>
        </div>
        <div>
          <h2 className="ui-h3">2. Change the prices</h2>
          <ul className="ui-muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Type new amounts in the <b>price</b>, <b>mrp</b>{showCost && <> or <b>cost</b></>} columns. Leave a cell empty to keep that price.</li>
            <li>Do not change the <b>sku</b> column: it tells GroPop which item a row is. You may delete rows you are not changing.</li>
            <li>Save it as CSV (in Excel: File › Save As › “CSV UTF-8”). Up to 2,000 rows at a time.</li>
          </ul>
        </div>
        <form onSubmit={upload}>
          <h2 className="ui-h3">3. Upload it and check</h2>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
            <input className="ui-input" type="file" accept=".csv,text/csv" aria-label="Price sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
            <button className="ui-btn ui-btn--primary" type="submit" disabled={!file || busy} aria-busy={busy}>Check the changes</button>
          </div>
          {error && <div className="ui-alert ui-alert--danger" role="alert" style={{ marginTop: 'var(--space-3)' }}><div className="ui-alert-body">{error}</div></div>}
        </form>
      </div></div>
      {preview && preview.errors && preview.errors.length > 0 && (
        <div className="ui-panel">
          <div className="ui-panel-head"><h2 className="ui-h3">{preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} left out</h2></div>
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col" className="ui-num">Row</th><th scope="col">SKU</th><th scope="col">Problem</th></tr></thead>
            <tbody>{preview.errors.slice(0, 100).map((e) => <tr key={`${e.row}`}><td className="ui-num">{e.row}</td><td className="ui-code">{e.sku || '—'}</td><td>{e.message}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
      {preview && <PreviewPanel preview={preview} source="sheet" initialDescription={`Price sheet ${file?.name ?? ''}`.trim()} showCost={showCost} onDone={(id, n) => { setPreview(null); setFile(null); onDone(id, n); }} />}
    </>
  );
}

function PreviewPanel({ preview, source, initialDescription, showCost, onDone }: { preview: Preview; source: 'rule' | 'sheet'; initialDescription: string; showCost: boolean; onDone: (id: string, n: number) => void }) {
  const [description, setDescription] = useState(initialDescription.slice(0, 300));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(idem);
  const good = preview.rows.filter((r) => !r.problem);
  const flagged = preview.rows.length - good.length;
  const changed = (k: Field) => preview.rows.some((r) => r.current[k] !== r.next[k]);
  // MRP stays on screen, unchanged, when selling prices move, so the owner can see how close each price gets to it.
  const cols: Field[] = (['price', 'mrp', 'cost'] as Field[]).filter((k) => (k !== 'cost' || showCost)
    && (changed(k) || (k === 'mrp' && changed('price') && preview.rows.some((r) => r.current.mrp != null))));

  const save = async () => {
    setBusy(true); setError('');
    try {
      const lines = good.map((r) => ({ variantId: r.variantId, version: r.version, price: r.next.price, mrp: r.next.mrp, ...(showCost && cols.includes('cost') ? { cost: r.next.cost } : {}) }));
      const { data } = await api<{ id: string; variantCount: number }>('/price-updates', { method: 'POST', headers: key, body: { source, description: description.trim(), lines } });
      onDone(data.id, data.variantCount);
    } catch (e) { setError(errorText(e) + (e instanceof ApiError && e.fieldErrors.lines ? ` ${e.fieldErrors.lines.join('; ')}` : '')); } finally { setBusy(false); }
  };

  if (!preview.rows.length) {
    return <div className="ui-alert ui-alert--info" role="status"><div className="ui-alert-body">{preview.matched === 0 ? 'No items match.' : `Nothing changes: ${preview.unchanged} item${preview.unchanged === 1 ? ' is' : 's are'} already at that price.`}</div></div>;
  }
  return (
    <div className="ui-panel">
      <div className="ui-panel-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <h2 className="ui-h3">{good.length} price{good.length === 1 ? '' : 's'} will change</h2>
        <span className="ui-caption">{[flagged ? `${flagged} left out (see below)` : '', preview.unchanged ? `${preview.unchanged} already at that price` : ''].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="ui-table-wrap" style={{ maxHeight: 480, overflow: 'auto' }}><table className="ui-table" data-collapse>
        <thead><tr><th scope="col">Item</th>{cols.map((c) => <th key={c} scope="col" className="ui-money">{FIELD_LABEL[c]}</th>)}<th scope="col"><span className="ui-sr-only">Status</span></th></tr></thead>
        <tbody>{[...preview.rows].sort((a, b) => Number(!!b.problem) - Number(!!a.problem)).map((r) => (
          <tr key={r.variantId}>
            <td data-primary><span className="ui-cell-title">{r.name}</span><div className="ui-cell-sub"><span className="ui-code">{r.sku}</span>{Object.keys(r.attributes).length > 0 && ` · ${attrLabel(r.attributes)}`}</div></td>
            {cols.map((c) => (
              <td key={c} className="ui-money" data-label={FIELD_LABEL[c]}>
                {r.current[c] === r.next[c] ? <span className="ui-muted">{money(r.current[c])}</span>
                  : <><span className="ui-muted" style={{ textDecoration: 'line-through' }}>{money(r.current[c])}</span> <b>{money(r.next[c])}</b></>}
              </td>
            ))}
            <td data-label="Status">{r.problem ? <span className="ui-badge ui-badge--warning" title={r.problem}>Left out: {r.problem}</span> : null}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <label className="ui-field"><span className="ui-label">Note for History</span>
          <input className="ui-input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        <div><button className="ui-btn ui-btn--primary" type="button" disabled={busy || !good.length || !description.trim()} aria-busy={busy} onClick={save}>
          Change {good.length} price{good.length === 1 ? '' : 's'}</button></div>
      </div>
    </div>
  );
}

function HistoryTab({ showCost }: { showCost: boolean }) {
  const [items, setItems] = useState<Run[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; lines: RunLine[] | null } | null>(null);
  const [confirm, setConfirm] = useState<Run | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (cursor?: string) => {
    try {
      const { data } = await api<{ items: Run[]; nextCursor: string | null }>(`/price-updates${cursor ? `?cursor=${cursor}` : ''}`);
      setItems((prev) => (cursor && prev ? [...prev, ...data.items] : data.items)); setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { load(); }, []);
  const show = async (id: string) => {
    if (open?.id === id) { setOpen(null); return; }
    setOpen({ id, lines: null });
    try { const { data } = await api<{ lines: RunLine[] }>(`/price-updates/${id}`); setOpen({ id, lines: data.lines }); } catch (e) { setError(errorText(e)); setOpen(null); }
  };
  const undo = async (r: Run) => {
    setBusy(true); setError(''); setResult('');
    try {
      const { data } = await api<{ restored: number; kept: number; keptSkus: string[] }>(`/price-updates/${r.id}/undo`, { method: 'POST' });
      setResult(`${data.restored} price${data.restored === 1 ? '' : 's'} put back.${data.kept ? ` ${data.kept} kept their newer price because they were changed again after this run (${data.keptSkus.slice(0, 10).join(', ')}${data.kept > 10 ? '…' : ''}).` : ''}`);
      setConfirm(null); setOpen(null); await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="ui-panel">
      {result && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">{result}</div></div>}
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div>
        : items.length === 0 ? <div className="ui-empty"><p className="ui-h3">No bulk price changes yet</p></div>
        : (
          <div className="ui-table-wrap"><table className="ui-table" data-collapse>
            <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" className="ui-num">Items</th><th scope="col"><span className="ui-sr-only">Actions</span></th></tr></thead>
            <tbody>{items.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td data-primary><span className="ui-cell-title">{fmtDateTime(r.createdAt)}</span><div className="ui-cell-sub">{r.createdBy ?? '—'} · {r.source === 'rule' ? 'by rule' : 'from a sheet'}</div></td>
                  <td data-label="What">{r.description}
                    {r.undoneAt && <div className="ui-cell-sub">Undone {fmtDateTime(r.undoneAt)} by {r.undoneBy ?? '—'}{r.undoneCount !== r.variantCount ? ` (${r.undoneCount} of ${r.variantCount} put back)` : ''}</div>}</td>
                  <td className="ui-num" data-label="Items">{r.variantCount}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" aria-expanded={open?.id === r.id} onClick={() => show(r.id)}>{open?.id === r.id ? 'Hide' : 'View'}</button>
                    {!r.undoneAt && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setConfirm(r)}>Undo</button>}
                  </td>
                </tr>
                {open?.id === r.id && (
                  <tr><td colSpan={4} style={{ background: 'var(--surface-sunken)' }}>
                    {!open.lines ? <div className="ui-skeleton" style={{ height: 60 }} /> : (
                      <table className="ui-table">
                        <thead><tr><th scope="col">Item</th><th scope="col" className="ui-money">Price</th><th scope="col" className="ui-money">MRP</th>{showCost && <th scope="col" className="ui-money">Cost</th>}<th scope="col">Now</th></tr></thead>
                        <tbody>{open.lines.map((l) => (
                          <tr key={l.variantId}>
                            <td><Link href={`/products/${l.productId}`}>{l.name}</Link><div className="ui-cell-sub"><span className="ui-code">{l.sku}</span>{Object.keys(l.attributes).length > 0 && ` · ${attrLabel(l.attributes)}`}</div></td>
                            {(['price', 'mrp', ...(showCost ? ['cost'] : [])] as Field[]).map((k) => (
                              <td key={k} className="ui-money">{l.old[k] === l.new[k] ? <span className="ui-muted">{money(l.old[k])}</span> : <>{money(l.old[k])} → <b>{money(l.new[k])}</b></>}</td>
                            ))}
                            <td>{l.stillCurrent ? <span className="ui-badge ui-badge--success">As set</span> : <span className="ui-badge">Changed since</span>}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    )}
                  </td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table></div>
        )}
      {next && <div className="ui-pager"><span>{items?.length} shown</span><button className="ui-btn ui-btn--sm" type="button" onClick={() => load(next)}>Show more</button></div>}

      {confirm && (
        <div className="ui-backdrop" role="presentation" onClick={() => setConfirm(null)}>
          <div className="ui-dialog" role="alertdialog" aria-modal aria-labelledby="undo-title" onClick={(e) => e.stopPropagation()}>
            <div className="ui-dialog-head"><h2 className="ui-h3" id="undo-title">Undo this price change?</h2></div>
            <div className="ui-dialog-body">
              <p>The {confirm.variantCount} item{confirm.variantCount === 1 ? '' : 's'} in “{confirm.description}” go back to their old prices.</p>
              <p className="ui-muted">Items whose price was changed again after this run keep their newer price. A run can be undone once.</p>
            </div>
            <div className="ui-dialog-foot">
              <button className="ui-btn" type="button" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="ui-btn ui-btn--primary" type="button" disabled={busy} aria-busy={busy} onClick={() => undo(confirm)}>Undo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><PricesPage /></Suspense>;
}
