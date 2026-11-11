'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, idemKey, noEnterSubmit, type Picked, type PostedDocument, type PurchaseOrder, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell, ItemPicker } from '../../stock/_components/item-picker';
import { useSuppliers } from '../_components/use-suppliers';
import { QtyStepper } from '../../../../lib/qty';
import { useMe } from '../../../../lib/me';
import { metaInView } from '../../../../lib/outlet-scope';

interface Line { key: string; item: Picked; poLineId: string | null; outstanding: string | null; locationId: string; received: string; accepted: string; unitCost: string }

const add1 = (v: string) => String((Number(v) || 0) + 1);
const damaged = (l: Line) => { const d = (Number(l.received) || 0) - (Number(l.accepted) || 0); return d > 0 ? String(Math.round(d * 1000) / 1000) : ''; };

/**
 * Goods in. Against a purchase order the lines start from what is still to come; scan each item as it is unpacked
 * (+1 arrived and accepted) or use "Fill what was ordered". Anything not accepted goes to damaged stock.
 */
function ReceivePage() {
  const router = useRouter();
  const poId = useSearchParams().get('po');
  const view = useMe().outlets;
  const { suppliers } = useSuppliers();
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [note, setNote] = useState('');
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idemKey);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then(({ data: all }) => {
      const data = metaInView(view, all);   // v2 (D115): received into a room at the outlet in view
      setMeta(data);
      const active = data.locations.filter((l) => l.active);
      const loc = active.find((l) => l.type === 'back_room')?.id ?? active[0]?.id ?? '';
      setLocationId(loc);
      if (!poId) return;
      api<PurchaseOrder>(`/purchase-orders/${poId}`).then(({ data: p }) => {
        setPo(p); setSupplierId(p.supplier.id);
        setLines(p.lines.filter((l) => l.outstandingQty !== '0').map((l) => ({
          key: l.id, item: l, poLineId: l.id, outstanding: l.outstandingQty, locationId: loc, received: '', accepted: '', unitCost: '',
        })));
      }).catch((e) => setError(errorText(e)));
    }).catch((e) => setError(errorText(e)));
  }, [poId]);

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (item: Picked) => setLines((ls) => {
    // Prefer the order line for this item while it still has room; extras go on their own line.
    const i = ls.findIndex((l) => l.item.variantId === item.variantId && (l.poLineId === null || Number(l.accepted || 0) < Number(l.outstanding)));
    if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, received: add1(l.received), accepted: add1(l.accepted) } : l));
    const cost = item.cost ? item.cost.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : '';
    return [...ls, { key: crypto.randomUUID(), item, poLineId: null, outstanding: null, locationId, received: '1', accepted: '1', unitCost: cost }];
  });
  const fillAll = () => setLines((ls) => ls.map((l) => (l.poLineId && !l.received ? { ...l, received: l.outstanding!, accepted: l.outstanding! } : l)));

  const sending = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.received.trim() !== '' && Number(l.received) > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    const body = {
      supplierId, ...(po ? { purchaseOrderId: po.id } : {}),
      ...(invoice.trim() ? { supplierInvoiceNo: invoice.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      lines: sending.map(({ l }) => ({
        ...(l.poLineId ? { poLineId: l.poLineId } : {}), variantId: l.item.variantId, locationId: l.locationId,
        receivedQty: l.received.trim(), acceptedQty: (l.accepted.trim() || '0'),
        ...(!l.poLineId && l.unitCost.trim() && meta?.can.seeCost ? { unitCost: l.unitCost.trim() } : {}),
      })),
    };
    try {
      const { data } = await api<PostedDocument>('/goods-receipts', { method: 'POST', body, headers: key });
      router.push(`/purchasing/receipts/${data.id}?posted=1`);
    } catch (err) {
      setKey(idemKey());
      setError(errorText(err));
      // Errors name lines by their position in what was sent; map them back to the rows on screen.
      if (err instanceof ApiError) setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => {
        const m = /^lines\.(\d+)\.(.+)$/.exec(k);
        return [m ? `lines.${sending[Number(m[1])]?.i}.${m[2]}` : k, v];
      })));
      setBusy(false);
    }
  };

  if (!meta) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 200 }} />}</div>;
  const active = meta.locations.filter((l) => l.active);
  const err = (i: number, f: string) => fieldError(errors, `lines.${i}.${f}`);

  return (
    <form className="ui-content" onSubmit={submit} onKeyDown={noEnterSubmit}>
      <div className="ui-page-header"><div>
        <Link className="ui-caption" href={po ? `/purchasing/${po.id}` : '/purchasing'}>{po ? `${po.number} /` : 'Purchasing /'}</Link>
        <h1 className="ui-h1">Receive goods{po ? ` from ${po.supplier.name}` : ''}</h1>
      </div></div>

      <div className="ui-panel"><div className="ui-panel-body ui-form-grid">
        {!po && (
          <label className="ui-field"><span className="ui-label">Supplier</span>
            <select className="ui-select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required aria-invalid={!!fieldError(errors, 'supplierId')}>
              <option value="">Choose a supplier</option>
              {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {fieldError(errors, 'supplierId') && <span className="ui-error">{fieldError(errors, 'supplierId')}</span>}
          </label>
        )}
        <label className="ui-field"><span className="ui-label">Supplier invoice number</span>
          <input className="ui-input" value={invoice} maxLength={40} onChange={(e) => setInvoice(e.target.value)} placeholder="Optional" />
        </label>
        <label className="ui-field"><span className="ui-label">Put new lines in</span>
          <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label className="ui-field ui-span-all"><span className="ui-label">Note</span>
          <input className="ui-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </label>
      </div></div>

      <div className="ui-panel">
        <div className="ui-panel-head">
          <span className="ui-h3">Items</span>
          {po && <button className="ui-btn ui-btn--sm" type="button" onClick={fillAll}>Fill what was ordered</button>}
        </div>
        <div className="ui-panel-body"><ItemPicker onPick={pick} autoFocus placeholder="Scan each item as you unpack it" /></div>
        {lines.length > 0 && (
          <div className="ui-table-wrap"><table className="ui-table ui-table--touch">
            <thead><tr>
              <th scope="col">Item</th>{po && <th scope="col" className="ui-num">Still to come</th>}
              <th scope="col" className="ui-num">Arrived</th><th scope="col" className="ui-num">Accepted</th><th scope="col" className="ui-num">Damaged</th>
              <th scope="col">Put in</th>{meta.can.seeCost && <th scope="col" className="ui-money">Unit cost</th>}<th scope="col"><span className="ui-sr-only">Remove line</span></th>
            </tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.key}>
                <td><ItemCell item={l.item} />{!l.poLineId && po && <span className="ui-badge ui-badge--warning">not on order</span>}
                  {(err(i, 'variantId') || err(i, 'poLineId')) && <div className="ui-error">{err(i, 'variantId') ?? err(i, 'poLineId')}</div>}</td>
                {po && <td className="ui-num">{l.outstanding ?? <span className="ui-muted">—</span>}</td>}
                <td className="ui-num">
                  <QtyStepper value={l.received} placeholder="0" label={`Arrived: ${l.item.sku}`} invalid={!!err(i, 'receivedQty')}
                    onChange={(v) => set(i, { received: v, accepted: l.accepted === l.received ? v : l.accepted })} />
                  {err(i, 'receivedQty') && <div className="ui-error">{err(i, 'receivedQty')}</div>}
                </td>
                <td className="ui-num">
                  <QtyStepper value={l.accepted} placeholder="0" label={`Accepted: ${l.item.sku}`} max={Number(l.received) || 0} invalid={!!err(i, 'acceptedQty')} onChange={(v) => set(i, { accepted: v })} />
                  {err(i, 'acceptedQty') && <div className="ui-error">{err(i, 'acceptedQty')}</div>}
                </td>
                <td className="ui-num">{damaged(l) || <span className="ui-muted">0</span>}</td>
                <td><select className="ui-select" aria-label="Location" value={l.locationId} onChange={(e) => set(i, { locationId: e.target.value })}>{active.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
                {meta.can.seeCost && <td className="ui-money">{l.poLineId ? <span className="ui-muted">as ordered</span> : (
                  <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" value={l.unitCost} placeholder="0.00" aria-label="Unit cost before GST" onChange={(e) => set(i, { unitCost: e.target.value })} />
                )}</td>}
                <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-footer">
        <span className="ui-muted">{sending.length} of {lines.length} lines will be received</span>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={busy || !supplierId || !sending.length} aria-busy={busy}>Post receipt</button>
      </div>
    </form>
  );
}

export default function Page() {
  return <Suspense><ReceivePage /></Suspense>;
}
