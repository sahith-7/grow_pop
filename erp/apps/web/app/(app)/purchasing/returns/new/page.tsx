'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, idemKey, noEnterSubmit, type Picked, type PostedDocument, type Receipt, type StockMeta } from '../../../../../lib/stock-api';
import { ItemCell, ItemPicker } from '../../../stock/_components/item-picker';
import { useSuppliers } from '../../_components/use-suppliers';
import { QtyStepper } from '../../../../../lib/qty';
import { useMe } from '../../../../../lib/me';
import { roomsInView } from '../../../../../lib/outlet-scope';

interface Line { key: string; item: Picked; locationId: string; bucket: 'sellable' | 'non_sellable'; qty: string }

/** Send stock back to a supplier. From a receipt, its damaged items are filled in. */
function SupplierReturnPage() {
  const router = useRouter();
  const receiptId = useSearchParams().get('receipt');
  const view = useMe().outlets;
  const { suppliers } = useSuppliers();
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idemKey);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then((r) => setMeta(r.data)).catch((e) => setError(errorText(e)));
    if (receiptId) api<Receipt>(`/goods-receipts/${receiptId}`).then(({ data }) => {
      setReceipt(data); setSupplierId(data.supplier.id); setReason('Damaged on arrival');
      setLines(data.lines.filter((l) => l.damagedQty !== '0').map((l) => ({ key: l.id, item: { ...l, barcode: null }, locationId: l.locationId, bucket: 'non_sellable' as const, qty: l.damagedQty })));
    }).catch((e) => setError(errorText(e)));
  }, [receiptId]);

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // v2 (D115): stock goes back from a room at the outlet in view (a receipt's own room is kept on its lines).
  const here = meta ? roomsInView(view, meta.locations.filter((l) => l.active)) : [];
  const defaultLocation = () => here.find((l) => l.type === 'quarantine')?.id ?? here[0]?.id ?? '';
  const pick = (item: Picked) => setLines((ls) => [...ls, { key: crypto.randomUUID(), item, locationId: defaultLocation(), bucket: 'non_sellable', qty: '1' }]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try {
      const body = { supplierId, receiptId: receipt?.id ?? null, reason: reason.trim(),
        lines: lines.map((l) => ({ variantId: l.item.variantId, locationId: l.locationId, bucket: l.bucket, qty: l.qty.trim() })) };
      const { data } = await api<PostedDocument>('/supplier-returns', { method: 'POST', body, headers: key });
      router.push(`/stock/movements?sourceId=${data.id}&posted=${encodeURIComponent(data.number)}`);
    } catch (err) {
      setKey(idemKey());
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setBusy(false);
    }
  };

  if (!meta) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 200 }} />}</div>;
  if (!meta.can.purchaseManage) return <div className="ui-content"><div className="ui-alert ui-alert--warning"><div className="ui-alert-body">Only the owner or a manager can return stock to a supplier.</div></div></div>;
  const active = meta.locations.filter((l) => l.active);
  const err = (i: number, f: string) => fieldError(errors, `lines.${i}.${f}`);

  return (
    <form className="ui-content" onSubmit={submit} onKeyDown={noEnterSubmit}>
      <div className="ui-page-header"><div>
        <Link className="ui-caption" href="/purchasing?tab=returns">Supplier returns /</Link>
        <h1 className="ui-h1">Return to supplier{receipt ? ` · ${receipt.number}` : ''}</h1>
      </div></div>

      <div className="ui-panel"><div className="ui-panel-body ui-form-grid">
        <label className="ui-field"><span className="ui-label">Supplier</span>
          <select className="ui-select" value={supplierId} disabled={!!receipt} onChange={(e) => setSupplierId(e.target.value)} required>
            {!receipt && <option value="">Choose a supplier</option>}
            {receipt && <option value={receipt.supplier.id}>{receipt.supplier.name}</option>}
            {!receipt && suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="ui-field"><span className="ui-label">Reason</span>
          <input className="ui-input" value={reason} minLength={3} maxLength={500} required onChange={(e) => setReason(e.target.value)} placeholder="e.g. Torn packaging" aria-invalid={!!fieldError(errors, 'reason')} />
          {fieldError(errors, 'reason') && <span className="ui-error">{fieldError(errors, 'reason')}</span>}
        </label>
      </div></div>

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Items going back</span></div>
        <div className="ui-panel-body"><ItemPicker onPick={pick} autoFocus={!receipt} /></div>
        {lines.length > 0 && (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Item</th><th scope="col">From</th><th scope="col">Stock</th><th scope="col" className="ui-num">Qty</th><th scope="col"><span className="ui-sr-only">Remove line</span></th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.key}>
                <td><ItemCell item={l.item} />{err(i, 'variantId') && <div className="ui-error">{err(i, 'variantId')}</div>}</td>
                <td><select className="ui-select" aria-label="Location" value={l.locationId} onChange={(e) => set(i, { locationId: e.target.value })}>{active.filter((x) => x.id === l.locationId || here.some((h) => h.id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
                <td><select className="ui-select" aria-label="Stock type" value={l.bucket} onChange={(e) => set(i, { bucket: e.target.value as Line['bucket'] })}>
                  <option value="non_sellable">Damaged</option><option value="sellable">Sellable</option>
                </select></td>
                <td className="ui-num">
                  <QtyStepper value={l.qty} onChange={(v) => set(i, { qty: v })} label={`Quantity of ${l.item.sku}`} invalid={!!err(i, 'qty')} />
                  {err(i, 'qty') && <div className="ui-error">{err(i, 'qty')}</div>}
                </td>
                <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-footer">
        <Link className="ui-btn" href="/purchasing?tab=returns">Cancel</Link>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !supplierId || reason.trim().length < 3 || !lines.length} aria-busy={busy}>Post return</button>
      </div>
    </form>
  );
}

export default function Page() {
  return <Suspense><SupplierReturnPage /></Suspense>;
}
