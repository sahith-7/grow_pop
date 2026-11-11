'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, errorText, type Product, type Ref, type Unit, type Variant } from '../../../../lib/catalog-api';
import { attrLabel } from '../../../../lib/format';
import { Icon } from '../../../../lib/icons';
import { useCan, useMe } from '../../../../lib/me';
import { roomsInView } from '../../../../lib/outlet-scope';
import type { Location } from '../../../../lib/stock-api';
import { ImagesPanel } from './images-panel';

export interface Meta { units: Unit[]; gstRates: string[]; attributeKeys: string[]; can: { write: boolean; seeCost: boolean; export: boolean } }

type WeightUnit = 'g' | 'kg' | 'ml' | 'l';
const WEIGHT_UNITS: WeightUnit[] = ['g', 'kg', 'ml', 'l'];

interface Row {
  key: string; id?: string; version?: number; status?: 'active' | 'archived';
  attributes: Record<string, string>; sku: string; barcode: string; price: string; mrp: string; cost: string; reorderLevel: string;
  netWeight: string; netWeightUnit: WeightUnit; openingQty: string;
}

const toRow = (v: Variant): Row => ({
  key: v.id, id: v.id, version: v.version, status: v.status, attributes: v.attributes, sku: v.sku, barcode: v.barcode ?? '',
  price: v.price, mrp: v.mrp ?? '', cost: v.cost ?? '', reorderLevel: v.reorderLevel ?? '',
  netWeight: v.netWeight ?? '', netWeightUnit: v.netWeightUnit ?? 'g', openingQty: '0',
});
const blankRow = (attributes: Record<string, string> = {}): Row => ({
  key: crypto.randomUUID(), attributes, sku: '', barcode: '', price: '', mrp: '', cost: '', reorderLevel: '',
  netWeight: '', netWeightUnit: 'g', openingQty: '0',
});
/** Thrown after an error has already been shown next to its field. */
class Shown extends Error {}
const skuPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6);
const nullable = (s: string) => (s.trim() === '' ? null : s.trim());

function variantBody(r: Row, seeCost: boolean, includeAttributes: boolean) {
  const netWeight = nullable(r.netWeight);
  return {
    sku: r.sku.trim(), barcode: nullable(r.barcode), price: r.price.trim(), mrp: nullable(r.mrp), reorderLevel: nullable(r.reorderLevel),
    netWeight, netWeightUnit: netWeight ? r.netWeightUnit : null,
    ...(seeCost ? { cost: nullable(r.cost) } : {}),
    ...(includeAttributes ? { attributes: r.attributes } : {}),
  };
}

/** v2 (D88): add a category or brand without leaving the product form. The new one is selected at once. */
function QuickAdd({ kind, parents, onAdded }: { kind: 'categories' | 'brands'; parents?: Ref[]; onAdded: (r: Ref) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const what = kind === 'categories' ? 'category' : 'brand';
  const add = async () => {
    if (!name.trim()) { setError(`Type the ${what} name`); return; }
    setBusy(true); setError('');
    try {
      const { data } = await api<Ref>(`/${kind}`, { method: 'POST', body: kind === 'categories' ? { name: name.trim(), parentId: parentId || null } : { name: name.trim() } });
      onAdded(data); setName(''); setParentId(''); setOpen(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="gp-link-btn" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> New {what}</button>;
  return (
    <div className="gp-quick-add">
      <input className="ui-input" aria-label={`New ${what} name`} placeholder={`New ${what} name`} value={name} maxLength={80} autoFocus
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') setOpen(false); }} />
      {parents && (
        <select className="ui-select" aria-label="Under" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">Top level</option>
          {parents.filter((p) => !p.parentId && !p.archivedAt).map((p) => <option key={p.id} value={p.id}>Under {p.name}</option>)}
        </select>
      )}
      <div className="gp-quick-add-actions">
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" onClick={add} disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
      </div>
      {error && <span className="ui-error" role="alert">{error}</span>}
    </div>
  );
}

/** `onSaved` replaces the form with fresh data; `onImagesChanged` must not, so unsaved field edits survive an upload. */
export function ProductForm({ product, meta, onSaved, onImagesChanged }: {
  product?: Product; meta: Meta; onSaved?: (p: Product) => void; onImagesChanged?: (p: Product) => void;
}) {
  const router = useRouter();
  const editing = Boolean(product);
  const readOnly = !meta.can.write || product?.status === 'archived';
  // Opening stock is a stock adjustment, so it needs that permission; without it the column is not shown at all.
  const canOpen = useCan('stock.adjust') && !editing;
  const [cats, setCats] = useState<Ref[]>([]);
  const [brands, setBrands] = useState<Ref[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [openingLocationId, setOpeningLocationId] = useState('');
  const view = useMe().outlets;
  const [f, setF] = useState({
    name: product?.name ?? '', description: product?.description ?? '', categoryId: product?.categoryId ?? '', brandId: product?.brandId ?? '',
    unitCode: product?.unitCode ?? 'NOS', type: product?.type ?? 'simple', status: product?.status === 'active' ? 'active' : 'draft',
    hsnCode: product?.hsnCode ?? '', gstRate: product?.gstRate ?? '',
  });
  const [rows, setRows] = useState<Row[]>(product ? product.variants.map(toRow) : [blankRow()]);
  const original = useMemo(() => new Map(product?.variants.map((v) => [v.id, toRow(v)]) ?? []), [product]);
  // Variable products: chosen attribute names and their comma-separated values
  const [options, setOptions] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const v of product?.variants ?? []) for (const [k, val] of Object.entries(v.attributes)) o[k] = [...new Set([...(o[k] ? o[k].split(', ') : []), val])].join(', ');
    return o;
  });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [banner, setBanner] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ items: Ref[] }>('/categories').then((r) => setCats(r.data.items)).catch(() => {});
    api<{ items: Ref[] }>('/brands').then((r) => setBrands(r.data.items)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!canOpen) return;
    api<{ items: Location[] }>('/locations').then((r) => {
      const active = roomsInView(view, r.data.items.filter((l) => l.active));   // v2 (D115): opening stock goes in at the outlet in view
      setLocations(active);
      setOpeningLocationId((cur) => cur || (active.find((l) => l.type === 'shop_floor') ?? active[0])?.id || '');
    }).catch(() => {});
  }, [canOpen]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const setRow = (key: string, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const err = (k: string) => errors[k]?.[0];
  const attrKeys = Object.keys(options).filter((k) => options[k] !== undefined);

  /** Cartesian product of the option values; keeps rows that already exist. */
  const generateVariants = () => {
    const lists = attrKeys.map((k) => options[k].split(',').map((s) => s.trim()).filter(Boolean).map((v) => [k, v] as const));
    if (!lists.length || lists.some((l) => !l.length)) { setBanner('Enter at least one value for each option.'); return; }
    const combos = lists.reduce<(readonly [string, string])[][]>((acc, l) => acc.flatMap((c) => l.map((x) => [...c, x])), [[]]);
    const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const base = skuPart(f.name) || 'ITEM';
    setRows(combos.map((c) => {
      const attributes = Object.fromEntries(c);
      return rows.find((r) => same(r.attributes, attributes))
        ?? { ...blankRow(attributes), sku: [base, ...Object.values(attributes).map(skuPart)].join('-'), price: rows[0]?.price ?? '', mrp: rows[0]?.mrp ?? '' };
    }));
    setBanner('');
  };

  /** v2 (D88): the next code in the store's own series (AC1204 → AC1205), or an in-store EAN-13 when there is none yet.
   *  Codes already typed on this form are skipped, so several rows can be filled before saving. */
  const generateBarcode = async (key: string) => {
    try {
      const { data } = await api<{ codes: string[] }>('/barcodes/next', { method: 'POST', body: { count: Math.min(200, rows.length) } });
      const onForm = new Set(rows.map((r) => r.barcode.trim()).filter(Boolean));
      const code = data.codes.find((c) => !onForm.has(c));
      if (code) setRow(key, { barcode: code });
    } catch (e) { setBanner(errorText(e)); }
  };

  const fail = (e: unknown, prefix = '') => {
    if (e instanceof ApiError) {
      const fe = Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [prefix + k, v]));
      setErrors((x) => ({ ...x, ...fe }));
      setBanner(e.message);
    } else setBanner(errorText(e));
  };

  /** Checks the API would also make, shown before sending so the person sees every problem at once. */
  const checkCreate = () => {
    const fe: Record<string, string[]> = {};
    if (!f.name.trim()) fe.name = ['Enter the product name'];
    if (!f.categoryId) fe.categoryId = ['Choose a category, or add a new one'];
    rows.forEach((r, i) => {
      if (!r.sku.trim()) fe[`variants.${i}.sku`] = ['Required'];
      if (!r.price.trim()) fe[`variants.${i}.price`] = ['Required'];
      if (canOpen && r.openingQty.trim() === '') fe[`variants.${i}.openingQty`] = ['Enter 0 if none'];
    });
    if (canOpen && rows.some((r) => Number(r.openingQty) > 0) && !openingLocationId) fe.openingLocationId = ['Choose where the opening stock is'];
    if (Object.keys(fe).length) { setErrors(fe); setBanner('Check the highlighted fields'); throw new Shown(); }
  };

  const create = async () => {
    checkCreate();
    const opening = canOpen && rows.some((r) => Number(r.openingQty) > 0);
    const body = {
      name: f.name, description: f.description, categoryId: f.categoryId, brandId: f.brandId || null, unitCode: f.unitCode,
      type: f.type, status: f.status, hsnCode: nullable(f.hsnCode), gstRate: nullable(f.gstRate),
      ...(opening ? { openingLocationId } : {}),
      variants: rows.map((r) => ({
        ...variantBody(r, meta.can.seeCost, f.type === 'variable'),
        ...(canOpen && Number(r.openingQty) > 0 ? { openingQty: r.openingQty.trim() } : {}),
      })),
    };
    const { data } = await api<Product>('/products', { method: 'POST', body, headers: { 'idempotency-key': idemKey } });
    router.push(`/products/${data.id}`);
  };

  const update = async () => {
    const p = product!;
    let version = p.version;
    const patch: Record<string, unknown> = {};
    const cmp: [keyof typeof f, unknown, unknown][] = [
      ['name', f.name, p.name], ['description', f.description, p.description], ['categoryId', f.categoryId || null, p.categoryId],
      ['brandId', f.brandId || null, p.brandId], ['unitCode', f.unitCode, p.unitCode], ['status', f.status, p.status],
      ['hsnCode', nullable(f.hsnCode), p.hsnCode], ['gstRate', nullable(f.gstRate), p.gstRate],
    ];
    for (const [k, now, was] of cmp) if (now !== was) patch[k] = now;
    if (Object.keys(patch).length) {
      const { data } = await api<Product>(`/products/${p.id}`, { method: 'PATCH', body: patch, headers: { 'if-match': `"${version}"` } });
      version = data.version;
    }
    for (const [i, r] of rows.entries()) {
      try {
        if (!r.id) {
          await api(`/products/${p.id}/variants`, { method: 'POST', body: variantBody(r, meta.can.seeCost, true) });
          continue;
        }
        const was = original.get(r.id)!;
        type F = 'sku' | 'barcode' | 'price' | 'mrp' | 'reorderLevel' | 'cost' | 'netWeight' | 'netWeightUnit';
        const fields: F[] = ['sku', 'barcode', 'price', 'mrp', 'reorderLevel', 'netWeight', 'netWeightUnit'];
        if (meta.can.seeCost) fields.push('cost');
        const changed: string[] = fields.filter((k) => r[k] !== was[k]);
        // Net weight and its unit always travel together (the API checks the pair).
        if (changed.includes('netWeight') || changed.includes('netWeightUnit')) changed.push('netWeight', 'netWeightUnit');
        const attrsChanged = JSON.stringify(r.attributes) !== JSON.stringify(was.attributes);
        if (!changed.length && !attrsChanged) continue;
        const full = variantBody(r, meta.can.seeCost, attrsChanged) as Record<string, unknown>;
        const body = Object.fromEntries(Object.entries(full).filter(([k]) => changed.includes(k) || k === 'attributes'));
        await api(`/variants/${r.id}`, { method: 'PATCH', body, headers: { 'if-match': `"${r.version}"` } });
      } catch (e) { fail(e, `variants.${i}.`); throw new Shown(); }
    }
    const { data } = await api<Product>(`/products/${p.id}`);
    onSaved?.(data);
  };

  const [idemKey] = useState(() => crypto.randomUUID()); // one create per form, even if Save is double-clicked

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setErrors({}); setBanner('');
    try {
      await (editing ? update() : create());
    } catch (e2) { if (!(e2 instanceof Shown)) fail(e2); }
    finally { setSaving(false); }
  };

  const toggleArchive = async (v: Row) => {
    try {
      await api(`/variants/${v.id}/${v.status === 'archived' ? 'restore' : 'archive'}`, { method: 'POST' });
      const { data } = await api<Product>(`/products/${product!.id}`);
      onSaved?.(data);
    } catch (e) { fail(e); }
  };

  const catLabel = (c: Ref) => { const p = cats.find((x) => x.id === c.parentId); return p ? `${p.name} › ${c.name}` : c.name; };
  const showCost = meta.can.seeCost;
  const unitAbbr = meta.units.find((u) => u.code === f.unitCode)?.abbr ?? '';

  return (
    <form onSubmit={save} noValidate>
      {banner && <div className="ui-alert ui-alert--danger" role="alert" style={{ marginBottom: 'var(--space-4)' }}><div className="ui-alert-body">{banner}</div></div>}
      <div className={`g gside gp-form-side${editing ? ' gp-form-side--with' : ''}`}>
        <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>
          <fieldset className="ui-panel" disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="ui-panel-head"><span className="ui-h3">Details</span></div>
            <div className="ui-panel-body ui-form-grid">
              <div className="ui-field ui-span-all">
                <label className="ui-label" htmlFor="p-name">Name<span className="ui-req" aria-hidden="true">*</span></label>
                <input className="ui-input" id="p-name" value={f.name} onChange={set('name')} required maxLength={200} aria-invalid={!!err('name')} />
                {err('name') && <span className="ui-error">{err('name')}</span>}
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-cat">Category<span className="ui-req" aria-hidden="true">*</span></label>
                <select className="ui-select" id="p-cat" value={f.categoryId} onChange={set('categoryId')} required aria-invalid={!!err('categoryId')}>
                  <option value="" disabled>Choose a category</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
                </select>
                {err('categoryId') && <span className="ui-error">{err('categoryId')}</span>}
                {!readOnly && <QuickAdd kind="categories" parents={cats} onAdded={(r) => { setCats((x) => [...x, r]); setF((x) => ({ ...x, categoryId: r.id })); }} />}
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-brand">Brand</label>
                <select className="ui-select" id="p-brand" value={f.brandId} onChange={set('brandId')}>
                  <option value="">None</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {!readOnly && <QuickAdd kind="brands" onAdded={(r) => { setBrands((x) => [...x, r]); setF((x) => ({ ...x, brandId: r.id })); }} />}
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-hsn">HSN code</label>
                <input className="ui-input ui-code" id="p-hsn" inputMode="numeric" value={f.hsnCode} onChange={set('hsnCode')} aria-invalid={!!err('hsnCode')} />
                {err('hsnCode') && <span className="ui-error">{err('hsnCode')}</span>}
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-gst">GST rate</label>
                <select className="ui-select" id="p-gst" value={f.gstRate} onChange={set('gstRate')}>
                  <option value="">Not set</option>
                  {meta.gstRates.map((g) => <option key={g} value={g}>{g}%</option>)}
                </select>
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-unit">Unit</label>
                <select className="ui-select" id="p-unit" value={f.unitCode} onChange={set('unitCode')}>
                  {meta.units.map((u) => <option key={u.code} value={u.code}>{u.name} ({u.abbr})</option>)}
                </select>
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-status">Status</label>
                <select className="ui-select" id="p-status" value={f.status} onChange={set('status')} disabled={product?.status === 'archived'}>
                  <option value="draft">Draft (hidden from POS)</option>
                  <option value="active">Active</option>
                </select>
              </div>
              <div className="ui-field ui-span-all">
                <label className="ui-label" htmlFor="p-desc">Description</label>
                <textarea className="ui-textarea" id="p-desc" rows={3} value={f.description} onChange={set('description')} maxLength={5000} />
              </div>
            </div>
          </fieldset>

          <fieldset className="ui-panel" disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="ui-panel-head">
              <span className="ui-h3">{f.type === 'variable' ? 'Variants, price and stock' : 'Price, codes and stock'}</span>
              {!editing && (
                <div className="ui-segmented" role="group" aria-label="Product type" style={{ marginLeft: 'auto' }}>
                  <button type="button" aria-pressed={f.type === 'simple'} onClick={() => { setF({ ...f, type: 'simple' }); setRows([rows[0] ? { ...rows[0], attributes: {} } : blankRow()]); setOptions({}); }}>One item</button>
                  <button type="button" aria-pressed={f.type === 'variable'} onClick={() => { setF({ ...f, type: 'variable' }); setOptions({ size: '' }); }}>Sizes / colours</button>
                </div>
              )}
            </div>

            {f.type === 'variable' && !editing && (
              <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
                {meta.attributeKeys.map((k) => (
                  <div key={k} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                    <label className="ui-check" style={{ minWidth: 110 }}>
                      <input type="checkbox" checked={options[k] !== undefined}
                        onChange={(e) => { const o = { ...options }; if (e.target.checked) o[k] = ''; else delete o[k]; setOptions(o); }} /> {k[0].toUpperCase() + k.slice(1)}
                    </label>
                    {options[k] !== undefined && (
                      <input className="ui-input" aria-label={`${k} values`} placeholder={k === 'size' ? 'S, M, L, XL' : 'Comma-separated values'}
                        value={options[k]} onChange={(e) => setOptions({ ...options, [k]: e.target.value })} />
                    )}
                  </div>
                ))}
                <div><button className="ui-btn ui-btn--sm" type="button" onClick={generateVariants}>Make variants</button></div>
              </div>
            )}

            {canOpen && (
              <div className="ui-panel-body gp-opening">
                <div className="ui-field" style={{ maxWidth: 320 }}>
                  <label className="ui-label" htmlFor="p-open-loc">Opening stock goes to</label>
                  <select className="ui-select" id="p-open-loc" value={openingLocationId} onChange={(e) => setOpeningLocationId(e.target.value)} aria-invalid={!!err('openingLocationId')}>
                    {!locations.length && <option value="">Loading…</option>}
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  {err('openingLocationId') && <span className="ui-error">{err('openingLocationId')}</span>}
                </div>
                <p className="ui-help" style={{ margin: 0 }}>Opening quantity is the stock you already have on the shelf. It is posted to stock history as “Opening stock”. Enter 0 if you have none yet.</p>
              </div>
            )}

            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr>
                  {f.type === 'variable' && <th scope="col">Variant</th>}
                  <th scope="col">SKU *</th><th scope="col">Barcode *</th>
                  <th scope="col" className="ui-money">Price *</th><th scope="col" className="ui-money">MRP</th>
                  {showCost && <th scope="col" className="ui-money">Cost</th>}
                  <th scope="col" className="ui-qty"><abbr title="Minimum quantity: below this the item shows as low stock" style={{ textDecoration: 'none' }}>Min qty</abbr></th>
                  {canOpen && <th scope="col" className="ui-qty" title={unitAbbr ? `In ${unitAbbr}` : undefined}>Opening qty *</th>}
                  <th scope="col">Net weight</th>
                  {editing && f.type === 'variable' && <th scope="col"><span className="ui-sr-only">Actions</span></th>}
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const e = (k: string) => err(`variants.${i}.${k}`);
                    const cell = (k: 'sku' | 'barcode' | 'price' | 'mrp' | 'cost' | 'reorderLevel' | 'openingQty', cls = '', mode: 'text' | 'decimal' | 'numeric' = 'text', label: string = k) => (
                      <td className="ui-wrap">
                        <input className={`ui-input ${cls}`} style={{ height: 32, minWidth: k === 'sku' ? 140 : 76 }} inputMode={mode} value={r[k]} aria-label={`${label} ${attrLabel(r.attributes)}`}
                          aria-invalid={!!e(k)} onChange={(ev) => setRow(r.key, { [k]: ev.target.value })} disabled={r.status === 'archived'} />
                        {e(k) && <div className="ui-error">{e(k)}</div>}
                      </td>
                    );
                    return (
                      <tr key={r.key} data-tone={r.status === 'archived' ? undefined : (Object.keys(errors).some((k) => k.startsWith(`variants.${i}.`)) ? 'danger' : undefined)}
                        style={r.status === 'archived' ? { opacity: 0.55 } : undefined}>
                        {f.type === 'variable' && <td>{attrLabel(r.attributes) || <span className="ui-muted">—</span>}{e('attributes') && <div className="ui-error">{e('attributes')}</div>}</td>}
                        {cell('sku', 'ui-code', 'text', 'SKU')}
                        <td className="ui-wrap">
                          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                            <input className="ui-input ui-code" style={{ height: 32, minWidth: 128 }} value={r.barcode} aria-label={`barcode ${attrLabel(r.attributes)}`} aria-invalid={!!e('barcode')}
                              placeholder={r.id ? '' : 'Auto on save'} onChange={(ev) => setRow(r.key, { barcode: ev.target.value })} disabled={r.status === 'archived'} />
                            {!r.barcode && r.status !== 'archived' && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => generateBarcode(r.key)} title="Fill in the next code in your series now">Generate</button>}
                          </div>
                          {e('barcode') && <div className="ui-error">{e('barcode')}</div>}
                        </td>
                        {cell('price', 'ui-input--num', 'decimal', 'Price')}
                        {cell('mrp', 'ui-input--num', 'decimal', 'MRP')}
                        {showCost && cell('cost', 'ui-input--num', 'decimal', 'Cost')}
                        {cell('reorderLevel', 'ui-input--num', 'decimal', 'Minimum quantity')}
                        {canOpen && cell('openingQty', 'ui-input--num', 'decimal', 'Opening quantity')}
                        <td className="ui-wrap">
                          <div className="gp-weight">
                            <input className="ui-input ui-input--num" style={{ height: 32, width: 72 }} inputMode="decimal" value={r.netWeight} placeholder="—"
                              aria-label={`Net weight ${attrLabel(r.attributes)}`} aria-invalid={!!e('netWeight')} onChange={(ev) => setRow(r.key, { netWeight: ev.target.value })} disabled={r.status === 'archived'} />
                            <select className="ui-select" style={{ height: 32, width: 58, padding: '0 var(--space-1)' }} value={r.netWeightUnit} aria-label={`Net weight unit ${attrLabel(r.attributes)}`}
                              onChange={(ev) => setRow(r.key, { netWeightUnit: ev.target.value as WeightUnit })} disabled={r.status === 'archived'}>
                              {WEIGHT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                          </div>
                          {(e('netWeight') || e('netWeightUnit')) && <div className="ui-error">{e('netWeight') || e('netWeightUnit')}</div>}
                        </td>
                        {editing && f.type === 'variable' && (
                          <td>{r.id
                            ? <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => toggleArchive(r)}>{r.status === 'archived' ? 'Restore' : 'Archive'}</button>
                            : <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>Remove</button>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!readOnly && (
              <p className="ui-help gp-form-note">
                Barcode: leave it blank and GroPop gives the next code in your series when you save (after AC1204 comes AC1205), or scan the maker’s barcode to use that.
                Min qty: below this the item shows as low stock. Net weight is the weight or volume printed on the pack.
              </p>
            )}
            {editing && f.type === 'variable' && !readOnly && (
              <div className="ui-panel-body" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end' }}>
                {Object.keys(rows[0]?.attributes ?? {}).map((k) => (
                  <div className="ui-field" key={k}>
                    <label className="ui-label" htmlFor={`new-${k}`}>{k}</label>
                    <input className="ui-input" id={`new-${k}`} style={{ width: 120 }} value={options[`new:${k}`] ?? ''} onChange={(e) => setOptions({ ...options, [`new:${k}`]: e.target.value })} />
                  </div>
                ))}
                <button className="ui-btn ui-btn--sm" type="button" onClick={() => {
                  const keys = Object.keys(rows[0]?.attributes ?? {});
                  const attributes = Object.fromEntries(keys.map((k) => [k, (options[`new:${k}`] ?? '').trim()]));
                  if (keys.some((k) => !attributes[k])) { setBanner(`Fill in ${keys.join(' and ')} for the new variant.`); return; }
                  setRows([...rows, { ...blankRow(attributes), price: rows[0]?.price ?? '', sku: [skuPart(f.name), ...Object.values(attributes).map(skuPart)].join('-') }]);
                }}>Add variant</button>
              </div>
            )}
          </fieldset>

          {!readOnly && (
            <div className="ui-form-footer">
              <Link className="ui-btn" href="/products">Cancel</Link>
              <button className="ui-btn ui-btn--primary" type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create product'}</button>
            </div>
          )}
        </div>

        {editing && product && (
          <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>
            <ImagesPanel product={product} canWrite={!readOnly} onChange={(p) => onImagesChanged?.(p)} />
          </div>
        )}
      </div>
    </form>
  );
}
