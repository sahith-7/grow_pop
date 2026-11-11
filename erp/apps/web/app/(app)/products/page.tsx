'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, errorText, type ProductSummary, type Ref } from '../../../lib/catalog-api';
import { priceRange } from '../../../lib/format';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../lib/suggest';
import { useCan } from '../../../lib/me';
import { ExportDialog } from './_components/export-dialog';

const MAX_SELECTED = 500;

const TABS = [
  { status: 'active', label: 'Active' },
  { status: 'draft', label: 'Drafts' },
  { status: 'archived', label: 'Archived' },
] as const;

const PUBLISH: Record<string, [string, string]> = {
  not_published: ['', 'Not published'], queued: ['warning', 'Queued'], synced: ['success', 'Synced'],
  failed: ['danger', 'Sync failed'], needs_review: ['warning', 'Needs review'],
};

function ProductsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? 'active';
  const categoryId = params.get('categoryId') ?? '';
  const stock = params.get('stock') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const sg = useSuggest<SearchHit>({ q, load: (t) => searchHits(t, ['product']) });
  const openHit = (h: SearchHit) => router.push(h.href);
  const [items, setItems] = useState<ProductSummary[] | null>(null);
  const [cursors, setCursors] = useState<string[]>([]); // stack of cursors for Previous
  const [next, setNext] = useState<string | null>(null);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [error, setError] = useState('');
  const search = useRef<HTMLInputElement>(null);
  // Ticked products, kept across pages and filters (v2, D98/D97/D100): print labels, change prices or export them together.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [exporting, setExporting] = useState(false);
  const canExport = useCan('report.export');
  const canBulkPrice = useCan('price.bulk');

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ status, limit: '25' });
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (categoryId) qs.set('categoryId', categoryId);
    if (stock) qs.set('stock', stock);
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: ProductSummary[]; nextCursor: string | null }>(`/products?${qs}`);
      setItems(data.items);
      setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };

  useEffect(() => { setCursors([]); load(); }, [params]);
  useEffect(() => { api<{ items: Ref[] }>('/categories').then((r) => setCategories(r.data.items)).catch(() => {}); }, []);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    router.replace(`/products?${p}`);
  };

  // A scanner types the code and presses Enter: an exact barcode/SKU hit opens the product directly.
  const onSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term && /^\S+$/.test(term)) {
      try {
        const { data } = await api<{ productId: string }>(`/lookup?code=${encodeURIComponent(term)}`);
        router.push(`/products/${data.productId}`);
        return;
      } catch { /* not an exact code: fall through to a name search */ }
    }
    setParam('q', term);
  };

  const toggle = (p: ProductSummary) => setSelected((m) => {
    const n = new Map(m);
    if (n.has(p.id)) n.delete(p.id); else if (n.size < MAX_SELECTED) n.set(p.id, p.name);
    return n;
  });
  const pageIds = items?.map((p) => p.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const togglePage = () => setSelected((m) => {
    const n = new Map(m);
    if (allOnPage) pageIds.forEach((id) => n.delete(id));
    else items!.forEach((p) => { if (n.size < MAX_SELECTED) n.set(p.id, p.name); });
    return n;
  });
  const ids = [...selected.keys()];
  // What the export can filter on: status (not archived), category and the search text.
  const exportFilter: Record<string, string> = {
    ...(status === 'active' || status === 'draft' ? { status } : {}), ...(categoryId ? { categoryId } : {}), ...(params.get('q') ? { q: params.get('q')! } : {}),
  };
  const filterLabel = [status === 'draft' ? 'drafts' : null, categoryId ? categories.find((c) => c.id === categoryId)?.name : null, params.get('q') ? `“${params.get('q')}”` : null]
    .filter(Boolean).join(', ') || null;

  const catName = (c: Ref) => { const p = categories.find((x) => x.id === c.parentId); return p ? `${p.name} › ${c.name}` : c.name; };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <h1 className="ui-h1">Products</h1>
        <div className="ui-actions">
          <Link className="ui-btn" href="/products/categories">Categories &amp; brands</Link>
          <Link className="ui-btn" href="/products/import">Import</Link>
          {canBulkPrice && <Link className="ui-btn" href="/products/prices">Bulk price update</Link>}
          {canExport && <button className="ui-btn" type="button" onClick={() => setExporting(true)}>Export</button>}
          <Link className="ui-btn ui-btn--primary" href="/products/new">Add product</Link>
        </div>
      </div>

      <div className="ui-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.status} className="ui-tab" role="tab" type="button" aria-selected={status === t.status} onClick={() => setParam('status', t.status)}>{t.label}</button>
        ))}
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" onSubmit={onSearch} role="search">
          <div className="gp-suggest">
            <input ref={search} className="ui-input ui-search" placeholder="Search name, SKU or scan barcode" aria-label="Search products"
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, openHit)} />
            <Suggestions s={sg} onPick={openHit} render={(h) => <HitRow hit={h} />} label="Matching products" />
          </div>
          <select className="ui-select" aria-label="Category" value={categoryId} onChange={(e) => setParam('categoryId', e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
          </select>
          <select className="ui-select" aria-label="Stock" value={stock} onChange={(e) => setParam('stock', e.target.value)}>
            <option value="">All stock levels</option>
            <option value="in_stock">In stock</option>
            <option value="low">Low stock (at or below min qty)</option>
            <option value="out_of_stock">Out of stock</option>
          </select>
          {params.get('q') && <button className="ui-chip" type="button" aria-pressed="true" onClick={() => { setQ(''); setParam('q', ''); }}>“{params.get('q')}” ✕</button>}
        </form>

        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

        {selected.size > 0 && (
          <div className="ui-bulkbar" role="region" aria-label="Selected products" style={{ flexWrap: 'wrap' }}>
            <span>{selected.size} selected{selected.size >= MAX_SELECTED ? ` (the most at once)` : ''}</span>
            <Link className="ui-btn ui-btn--sm" href={`/products/labels?products=${ids.join(',')}`}>Print labels</Link>
            {canBulkPrice && <Link className="ui-btn ui-btn--sm" href={`/products/prices?products=${ids.join(',')}`}>Change prices</Link>}
            {canExport && <button className="ui-btn ui-btn--sm" type="button" onClick={() => setExporting(true)}>Export</button>}
            <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setSelected(new Map())}>Clear</button>
          </div>
        )}

        {items === null ? (
          <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
        ) : items.length === 0 ? (
          <div className="ui-empty">
            <p className="ui-h3">{params.get('q') || stock ? 'No products match' : status === 'active' ? 'No products yet' : `No ${status} products`}</p>
            {status === 'active' && !params.get('q') && <p className="ui-muted">Add your first product, or import a CSV from your old system.</p>}
          </div>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table" data-collapse>
              <thead><tr>
                <th scope="col" style={{ width: 36 }}><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={togglePage} /></th>
                <th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Category</th>
                <th scope="col" className="ui-money">Price</th><th scope="col" className="ui-qty" title="Free to sell: on hand minus reserved, in sellable locations">In stock</th><th scope="col">Website</th>
              </tr></thead>
              <tbody>
                {items.map((p) => {
                  const [tone, label] = PUBLISH[p.publishState] ?? ['', p.publishState];
                  return (
                    <tr key={p.id} style={{ cursor: 'pointer' }} aria-selected={selected.has(p.id)} onClick={() => router.push(`/products/${p.id}`)}>
                      <td onClick={(e) => e.stopPropagation()} data-label="Select">
                        <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p)} />
                      </td>
                      <td data-primary>
                        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                          {p.thumbnailUrl ? <img className="ui-thumb" src={p.thumbnailUrl} alt="" loading="lazy" /> : <span className="ui-thumb" />}
                          <div>
                            <Link className="ui-cell-title" href={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                            <div className="ui-cell-sub">{p.variantCount === 1 ? '1 variant' : `${p.variantCount} variants`}</div>
                          </div>
                        </div>
                      </td>
                      <td className="ui-code" data-label="SKU">{p.skus.join(', ')}{p.variantCount > p.skus.length ? '…' : ''}</td>
                      <td data-label="Category">{p.category ?? <span className="ui-muted">—</span>}</td>
                      <td className="ui-money" data-label="Price">{priceRange(p.priceRange)}</td>
                      <td className="ui-qty" data-label="In stock">
                        {Number(p.stock.free) <= 0 ? <span className="ui-badge ui-badge--danger">Out · {p.stock.free}</span>
                          : p.stock.low ? <span className="ui-badge ui-badge--warning">Low · {p.stock.free}</span> : p.stock.free}
                      </td>
                      <td data-label="Website"><span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length}
              onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next}
              onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Next</button>
          </div>
        </div>
      </div>
      {exporting && <ExportDialog scope={{ filter: exportFilter, filterLabel, selected: ids }} onClose={() => setExporting(false)} />}
    </div>
  );
}

export default function Page() {
  return <Suspense><ProductsPage /></Suspense>;
}
