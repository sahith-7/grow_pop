'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText, fieldError, idemKey, noEnterSubmit, type Picked, type PostedDocument, type StockMeta } from '../../../../lib/stock-api';
import { ItemCell, ItemPicker } from '../_components/item-picker';

interface Line { item: Picked; qty: string }

export default function TransferPage() {
  const router = useRouter();
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idemKey);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then(({ data }) => {
      setMeta(data);
      const active = data.locations.filter((l) => l.active);
      setFrom(active.find((l) => l.type === 'back_room')?.id ?? active[0]?.id ?? '');
      setTo(active.find((l) => l.type === 'shop_floor')?.id ?? active[1]?.id ?? '');
    }).catch((e) => setError(errorText(e)));
  }, []);

  const pick = (item: Picked) => setLines((ls) => {
    const i = ls.findIndex((l) => l.item.variantId === item.variantId);
    return i < 0 ? [...ls, { item, qty: '1' }] : ls.map((l, j) => (j === i ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l));
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try {
      const body = { fromLocationId: from, toLocationId: to, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ variantId: l.item.variantId, qty: l.qty })) };
      const { data } = await api<PostedDocument>('/stock/transfers', { method: 'POST', body, headers: key });
      router.push(`/stock/movements?sourceId=${data.id}&posted=${encodeURIComponent(data.number)}`);
    } catch (err) {
      setKey(idemKey());
      setError(errorText(err));
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    } finally { setBusy(false); }
  };

  if (!meta) return <div className="ui-content">{error ? <div className="ui-error">{error}</div> : <div className="ui-skeleton" style={{ height: 200 }} />}</div>;
  const active = meta.locations.filter((l) => l.active);

  return (
    <form className="ui-content" onSubmit={submit} onKeyDown={noEnterSubmit}>
      <div className="ui-page-header"><div><Link className="ui-caption" href="/stock">Stock /</Link><h1 className="ui-h1">Transfer stock</h1></div></div>
      <div className="ui-panel"><div className="ui-panel-body ui-form-grid">
        <label className="ui-field"><span className="ui-label">From</span>
          <select className="ui-select" value={from} onChange={(e) => setFrom(e.target.value)}>{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </label>
        <label className="ui-field"><span className="ui-label">To</span>
          <select className="ui-select" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={!!fieldError(errors, 'toLocationId')}>{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          {fieldError(errors, 'toLocationId') && <span className="ui-error">{fieldError(errors, 'toLocationId')}</span>}
        </label>
        <label className="ui-field ui-span-all"><span className="ui-label">Note</span>
          <input className="ui-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </label>
      </div></div>

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Items</span></div>
        <div className="ui-panel-body"><ItemPicker onPick={pick} autoFocus /></div>
        {lines.length > 0 && (
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Item</th><th scope="col" className="ui-num">Move</th><th scope="col"><span className="ui-sr-only">Remove line</span></th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.item.variantId}>
                <td><ItemCell item={l.item} /></td>
                <td className="ui-num">
                  <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" value={l.qty} aria-label="Quantity" aria-invalid={!!fieldError(errors, `lines.${i}.qty`)}
                    onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value.trim() } : x)))} />
                  {fieldError(errors, `lines.${i}.qty`) && <div className="ui-error">{fieldError(errors, `lines.${i}.qty`)}</div>}
                </td>
                <td><button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-form-footer">
        <Link className="ui-btn" href="/stock">Cancel</Link>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={!lines.length || from === to} aria-busy={busy}>Post transfer</button>
      </div>
    </form>
  );
}
