'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { money } from '../../../../lib/format';
import { ApiError, api, errorText, fieldError, idemKey, noEnterSubmit, lineTotal, type Picked, type PurchaseOrder, sumMoney } from '../../../../lib/stock-api';
import { ItemCell, ItemPicker } from '../../stock/_components/item-picker';
import { useSuppliers } from './use-suppliers';

interface Line { item: Picked; orderedQty: string; unitCost: string }

/** Create a purchase order, or edit one that is still a draft. Prices are per unit, before GST. */
export function PoForm({ po, etag, onSaved }: { po?: PurchaseOrder; etag?: string | null; onSaved?: (po: PurchaseOrder, etag: string | null) => void }) {
  const router = useRouter();
  const { suppliers, error: supplierError } = useSuppliers();
  const [supplierId, setSupplierId] = useState(po?.supplier.id ?? '');
  const [expectedDate, setExpectedDate] = useState(po?.expectedDate ?? '');
  const [notes, setNotes] = useState(po?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(po?.lines.map((l) => ({ item: l, orderedQty: l.orderedQty, unitCost: l.unitCost ?? '' })) ?? []);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [key, setKey] = useState(idemKey);

  const pick = (item: Picked) => setLines((ls) => {
    const i = ls.findIndex((l) => l.item.variantId === item.variantId);
    if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, orderedQty: String((Number(l.orderedQty) || 0) + 1) } : l));
    return [...ls, { item, orderedQty: '1', unitCost: item.cost ? item.cost.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : '' }];
  });
  const set = (i: number, patch: Partial<Line>) => { setSaved(false); setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({}); setSaved(false);
    const body = {
      supplierId, expectedDate: expectedDate || null, ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: lines.map((l) => ({ variantId: l.item.variantId, orderedQty: l.orderedQty.trim(), unitCost: l.unitCost.trim() })),
    };
    try {
      if (!po) {
        const { data } = await api<PurchaseOrder>('/purchase-orders', { method: 'POST', body, headers: key });
        router.push(`/purchasing/${data.id}`);
        return;
      }
      const { data, etag: next } = await api<PurchaseOrder>(`/purchase-orders/${po.id}`, { method: 'PATCH', body, headers: { 'if-match': etag ?? `"${po.version}"` } });
      setSaved(true);
      onSaved?.(data, next);
    } catch (err) {
      setKey(idemKey());
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    } finally { setBusy(false); }
  };

  const totals = lines.map((l) => lineTotal(l.orderedQty, l.unitCost));

  return (
    <form onSubmit={submit} onKeyDown={noEnterSubmit} style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="ui-panel"><div className="ui-panel-body ui-form-grid">
        <label className="ui-field"><span className="ui-label">Supplier</span>
          <select className="ui-select" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setSaved(false); }} required aria-invalid={!!fieldError(errors, 'supplierId')}>
            <option value="">Choose a supplier</option>
            {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {(fieldError(errors, 'supplierId') || supplierError) && <span className="ui-error">{fieldError(errors, 'supplierId') ?? supplierError}</span>}
          {suppliers?.length === 0 && <span className="ui-help">No suppliers yet. <Link href="/suppliers">Add one</Link> first.</span>}
        </label>
        <label className="ui-field"><span className="ui-label">Expected on</span>
          <input className="ui-input" type="date" value={expectedDate} onChange={(e) => { setExpectedDate(e.target.value); setSaved(false); }} />
        </label>
        <label className="ui-field ui-span-all"><span className="ui-label">Notes</span>
          <input className="ui-input" value={notes} maxLength={1000} onChange={(e) => { setNotes(e.target.value); setSaved(false); }} placeholder="Optional" />
        </label>
      </div></div>

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Items</span><span className="ui-caption">Unit cost before GST</span></div>
        <div className="ui-panel-body"><ItemPicker onPick={(i) => { setSaved(false); pick(i); }} autoFocus={!po} /></div>
        {lines.length > 0 && (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Item</th><th scope="col" className="ui-num">Order</th><th scope="col" className="ui-money">Unit cost</th><th scope="col" className="ui-money">Total</th><th scope="col"><span className="ui-sr-only">Remove line</span></th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.item.variantId}>
                <td><ItemCell item={l.item} />{fieldError(errors, `lines.${i}.variantId`) && <div className="ui-error">{fieldError(errors, `lines.${i}.variantId`)}</div>}</td>
                <td className="ui-num">
                  <input className="ui-input ui-input--num" style={{ width: 90 }} inputMode="decimal" value={l.orderedQty} aria-label="Quantity" aria-invalid={!!fieldError(errors, `lines.${i}.orderedQty`)} onChange={(e) => set(i, { orderedQty: e.target.value })} />
                  {fieldError(errors, `lines.${i}.orderedQty`) && <div className="ui-error">{fieldError(errors, `lines.${i}.orderedQty`)}</div>}
                </td>
                <td className="ui-money">
                  <input className="ui-input ui-input--num" style={{ width: 110 }} inputMode="decimal" value={l.unitCost} placeholder="0.00" aria-label="Unit cost" aria-invalid={!!fieldError(errors, `lines.${i}.unitCost`)} onChange={(e) => set(i, { unitCost: e.target.value })} />
                  {fieldError(errors, `lines.${i}.unitCost`) && <div className="ui-error">{fieldError(errors, `lines.${i}.unitCost`)}</div>}
                </td>
                <td className="ui-money">{money(totals[i])}</td>
                <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => { setSaved(false); setLines((ls) => ls.filter((_, j) => j !== i)); }}>Remove</button></td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th scope="row" colSpan={3} style={{ textAlign: 'right' }}>Total before GST</th><td className="ui-money"><strong>{money(sumMoney(totals))}</strong></td><td /></tr></tfoot>
          </table></div>
        )}
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-footer">
        {saved && <span className="ui-muted" role="status">Saved</span>}
        {!po && <Link className="ui-btn" href="/purchasing">Cancel</Link>}
        <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !supplierId || !lines.length} aria-busy={busy}>{po ? 'Save draft' : 'Create draft'}</button>
      </div>
    </form>
  );
}
