'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, idemKey, noEnterSubmit, type Picked, type PostedDocument, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell, ItemPicker } from '../_components/item-picker';

const REASONS = [
  { code: 'correction', label: 'Correction (miscount, wrong entry)', perm: 'adjust' },
  { code: 'opening', label: 'Opening stock', perm: 'adjust' },
  { code: 'damage', label: 'Damaged — write off', perm: 'writeoff' },
  { code: 'expiry', label: 'Expired — write off', perm: 'writeoff' },
  { code: 'loss', label: 'Lost or stolen — write off', perm: 'writeoff' },
] as const;

interface Line { item: Picked; qty: string; bucket: 'sellable' | 'non_sellable'; unitCost: string }

export default function AdjustPage() {
  const router = useRouter();
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState<string>('');
  const [direction, setDirection] = useState<'add' | 'remove'>('remove');
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idemKey);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then(({ data }) => {
      setMeta(data);
      setLocationId(data.locations.find((l) => l.active)?.id ?? '');
      setReason(REASONS.find((r) => data.can[r.perm])?.code ?? '');
    }).catch((e) => setError(errorText(e)));
  }, []);

  const sign = reason === 'opening' ? 1 : reason === 'correction' ? (direction === 'add' ? 1 : -1) : -1;
  const pick = (item: Picked) => setLines((ls) => {
    const i = ls.findIndex((l) => l.item.variantId === item.variantId && l.bucket === 'sellable');
    if (i < 0) return [...ls, { item, qty: '1', bucket: 'sellable', unitCost: '' }];
    return ls.map((l, j) => (j === i ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l));  // every scan adds one
  });
  const update = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try {
      const body = {
        locationId, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}), overrideNegative: override,
        lines: lines.map((l) => ({
          variantId: l.item.variantId, qtyDelta: sign < 0 ? `-${l.qty}` : l.qty, bucket: l.bucket,
          ...(reason === 'opening' && l.unitCost.trim() ? { unitCost: l.unitCost.trim() } : {}),
        })),
      };
      const { data } = await api<PostedDocument>('/stock/adjustments', { method: 'POST', body, headers: key });
      router.push(`/stock/movements?sourceId=${data.id}&posted=${encodeURIComponent(data.number)}`);
    } catch (err) {
      setKey(idemKey());
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    } finally { setBusy(false); }
  };

  if (!meta) return <div className="ui-content">{error ? <div className="ui-error">{error}</div> : <div className="ui-skeleton" style={{ height: 200 }} />}</div>;
  const reasons = REASONS.filter((r) => meta.can[r.perm]);

  return (
    <form className="ui-content" onSubmit={submit} onKeyDown={noEnterSubmit}>
      <div className="ui-page-header"><div><Link className="ui-caption" href="/stock">Stock /</Link><h1 className="ui-h1">Adjust stock</h1></div></div>
      <div className="ui-panel"><div className="ui-panel-body ui-form-grid">
        <label className="ui-field"><span className="ui-label">Location</span>
          <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-invalid={!!fieldError(errors, 'locationId')}>
            {meta.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label className="ui-field"><span className="ui-label">Reason</span>
          <select className="ui-select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </label>
        {reason === 'correction' && (
          <div className="ui-field"><span className="ui-label">Change</span>
            <div className="ui-segmented">
              <button type="button" aria-pressed={direction === 'remove'} onClick={() => setDirection('remove')}>Remove stock</button>
              <button type="button" aria-pressed={direction === 'add'} onClick={() => setDirection('add')}>Add stock</button>
            </div>
          </div>
        )}
        <label className="ui-field ui-span-all"><span className="ui-label">Note{override && <span className="ui-req">*</span>}</span>
          <input className="ui-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What happened? This goes into the stock history." aria-invalid={!!fieldError(errors, 'note')} />
          {fieldError(errors, 'note') && <span className="ui-error">{fieldError(errors, 'note')}</span>}
        </label>
        {meta.can.overrideNegative && sign < 0 && (
          <label className="ui-check ui-span-all"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            Allow stock to go below zero (owner only, needs a note, recorded in the audit log)</label>
        )}
      </div></div>

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Items</span></div>
        <div className="ui-panel-body"><ItemPicker onPick={pick} autoFocus /></div>
        {lines.length > 0 && (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Item</th><th scope="col">Stock</th>
              <th scope="col" className="ui-num">{sign < 0 ? 'Remove' : 'Add'}</th>
              {reason === 'opening' && meta.can.seeCost && <th scope="col" className="ui-money">Unit cost (₹, excl. GST)</th>}
              <th scope="col"><span className="ui-sr-only">Remove line</span></th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={`${l.item.variantId}-${i}`}>
                <td><ItemCell item={l.item} />{fieldError(errors, `lines.${i}.variantId`) && <div className="ui-error">{fieldError(errors, `lines.${i}.variantId`)}</div>}</td>
                <td>
                  <select className="ui-select" value={l.bucket} disabled={reason === 'opening'} onChange={(e) => update(i, { bucket: e.target.value as Line['bucket'] })} aria-label="Stock type">
                    <option value="sellable">Sellable</option><option value="non_sellable">Damaged (non-sellable)</option>
                  </select>
                </td>
                <td className="ui-num">
                  <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" value={l.qty} onChange={(e) => update(i, { qty: e.target.value.trim() })}
                    aria-label="Quantity" aria-invalid={!!fieldError(errors, `lines.${i}.qtyDelta`)} />
                  {fieldError(errors, `lines.${i}.qtyDelta`) && <div className="ui-error">{fieldError(errors, `lines.${i}.qtyDelta`)}</div>}
                </td>
                {reason === 'opening' && meta.can.seeCost && (
                  <td className="ui-money"><input className="ui-input ui-input--num" style={{ width: 110 }} inputMode="decimal" value={l.unitCost} onChange={(e) => update(i, { unitCost: e.target.value })} aria-label="Unit cost" /></td>
                )}
                <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-footer">
        <Link className="ui-btn" href="/stock">Cancel</Link>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={!lines.length || !reason} aria-busy={busy}>Post adjustment</button>
      </div>
    </form>
  );
}
