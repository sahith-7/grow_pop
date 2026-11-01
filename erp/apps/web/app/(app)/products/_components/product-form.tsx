'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, errorText, type Product, type Ref, type Unit, type Variant } from '../../../../lib/catalog-api';
import { attrLabel } from '../../../../lib/format';
import { ImagesPanel } from './images-panel';

export interface Meta { units: Unit[]; gstRates: string[]; attributeKeys: string[]; can: { write: boolean; seeCost: boolean; export: boolean } }

interface Row {
  key: string; id?: string; version?: number; status?: 'active' | 'archived';
  attributes: Record<string, string>; sku: string; barcode: string; price: string; mrp: string; cost: string; reorderLevel: string;
}

const toRow = (v: Variant): Row => ({
  key: v.id, id: v.id, version: v.version, status: v.status, attributes: v.attributes, sku: v.sku, barcode: v.barcode ?? '',
  price: v.price, mrp: v.mrp ?? '', cost: v.cost ?? '', reorderLevel: v.reorderLevel ?? '',
});
const blankRow = (attributes: Record<string, string> = {}): Row => ({
  key: crypto.randomUUID(), attributes, sku: '', barcode: '', price: '', mrp: '', cost: '', reorderLevel: '',
});
/** Thrown after an error has already been shown next to its field. */
class Shown extends Error {}
const skuPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6);
const nullable = (s: string) => (s.trim() === '' ? null : s.trim());

function variantBody(r: Row, seeCost: boolean, includeAttributes: boolean) {
  return {
    sku: r.sku.trim(), barcode: nullable(r.barcode), price: r.price.trim(), mrp: nullable(r.mrp), reorderLevel: nullable(r.reorderLevel),
    ...(seeCost ? { cost: nullable(r.cost) } : {}),
    ...(includeAttributes ? { attributes: r.attributes } : {}),
  };
}

/** `onSaved` replaces the form with fresh data; `onImagesChanged` must not, so unsaved field edits survive an upload. */
export function ProductForm({ product, meta, onSaved, onImagesChanged }: {
  product?: Product; meta: Meta; onSaved?: (p: Product) => void; onImagesChanged?: (p: Product) => void;
}) {
  const router = useRouter();
  const editing = Boolean(product);
  const readOnly = !meta.can.write || product?.status === 'archived';
  const [cats, setCats] = useState<Ref[]>([]);
  const [brands, setBrands] = useState<Ref[]>([]);
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

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const setRow = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
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

  const generateBarcode = async (key: string) => {
    try {
      const { data } = await api<{ codes: string[] }>('/barcodes/generate', { method: 'POST', body: { count: 1 } });
      setRow(key, { barcode: data.codes[0] });
    } catch (e) { setBanner(errorText(e)); }
  };

  const fail = (e: unknown, prefix = '') => {
    if (e instanceof ApiError) {
      const fe = Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [prefix + k, v]));
      setErrors((x) => ({ ...x, ...fe }));
      setBanner(e.message);
    } else setBanner(errorText(e));
  };

  const create = async () => {
    const body = {
      name: f.name, description: f.description, categoryId: f.categoryId || null, brandId: f.brandId || null, unitCode: f.unitCode,
      type: f.type, status: f.status, hsnCode: nullable(f.hsnCode), gstRate: nullable(f.gstRate),
      variants: rows.map((r) => variantBody(r, meta.can.seeCost, f.type === 'variable')),
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
        const fields: ('sku' | 'barcode' | 'price' | 'mrp' | 'reorderLevel' | 'cost')[] = ['sku', 'barcode', 'price', 'mrp', 'reorderLevel'];
        if (meta.can.seeCost) fields.push('cost');
        const changed = fields.filter((k) => r[k] !== was[k]);
        const attrsChanged = JSON.stringify(r.attributes) !== JSON.stringify(was.attributes);
        if (!changed.length && !attrsChanged) continue;
        const full = variantBody(r, meta.can.seeCost, attrsChanged) as Record<string, unknown>;
        const body = Object.fromEntries(Object.entries(full).filter(([k]) => (changed as string[]).includes(k) || k === 'attributes'));
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

  return (
    <form onSubmit={save} noValidate>
      {banner && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{banner}</div></div>}
      <div className="g gside" style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: editing ? 'minmax(0,1fr) 340px' : 'minmax(0,1fr)' }}>
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
                <label className="ui-label" htmlFor="p-cat">Category</label>
                <select className="ui-select" id="p-cat" value={f.categoryId} onChange={set('categoryId')}>
                  <option value="">None</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
                </select>
                {err('categoryId') && <span className="ui-error">{err('categoryId')}</span>}
              </div>
              <div className="ui-field">
                <label className="ui-label" htmlFor="p-brand">Brand</label>
                <select className="ui-select" id="p-brand" value={f.brandId} onChange={set('brandId')}>
                  <option value="">None</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
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
              <span className="ui-h3">{f.type === 'variable' ? 'Variants' : 'Price and codes'}</span>
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

            <div className="ui-table-wrap">
              <table className="ui-table">
                <thead><tr>
                  {f.type === 'variable' && <th scope="col">Variant</th>}
                  <th scope="col">SKU *</th><th scope="col">Barcode</th>
                  <th scope="col" className="ui-money">Price *</th><th scope="col" className="ui-money">MRP</th>
                  {showCost && <th scope="col" className="ui-money">Cost</th>}
                  <th scope="col" className="ui-qty">Reorder at</th>
                  {editing && f.type === 'variable' && <th scope="col"><span className="ui-sr-only">Actions</span></th>}
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const e = (k: string) => err(`variants.${i}.${k}`);
                    const cell = (k: 'sku' | 'barcode' | 'price' | 'mrp' | 'cost' | 'reorderLevel', cls = '', mode: 'text' | 'decimal' | 'numeric' = 'text') => (
                      <td className="ui-wrap">
                        <input className={`ui-input ${cls}`} style={{ height: 32, minWidth: k === 'sku' ? 150 : 96 }} inputMode={mode} value={r[k]} aria-label={`${k} ${attrLabel(r.attributes)}`}
                          aria-invalid={!!e(k)} onChange={(ev) => setRow(r.key, { [k]: ev.target.value })} disabled={r.status === 'archived'} />
                        {e(k) && <div className="ui-error">{e(k)}</div>}
                      </td>
                    );
                    return (
                      <tr key={r.key} data-tone={r.status === 'archived' ? undefined : (Object.keys(errors).some((k) => k.startsWith(`variants.${i}.`)) ? 'danger' : undefined)}
                        style={r.status === 'archived' ? { opacity: 0.55 } : undefined}>
                        {f.type === 'variable' && <td>{attrLabel(r.attributes) || <span className="ui-muted">—</span>}{e('attributes') && <div className="ui-error">{e('attributes')}</div>}</td>}
                        {cell('sku', 'ui-code')}
                        <td className="ui-wrap">
                          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                            <input className="ui-input ui-code" style={{ height: 32, minWidth: 150 }} value={r.barcode} aria-label={`barcode ${attrLabel(r.attributes)}`} aria-invalid={!!e('barcode')}
                              onChange={(ev) => setRow(r.key, { barcode: ev.target.value })} disabled={r.status === 'archived'} />
                            {!r.barcode && r.status !== 'archived' && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => generateBarcode(r.key)}>Generate</button>}
                          </div>
                          {e('barcode') && <div className="ui-error">{e('barcode')}</div>}
                        </td>
                        {cell('price', 'ui-input--num', 'decimal')}
                        {cell('mrp', 'ui-input--num', 'decimal')}
                        {showCost && cell('cost', 'ui-input--num', 'decimal')}
                        {cell('reorderLevel', 'ui-input--num', 'decimal')}
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
