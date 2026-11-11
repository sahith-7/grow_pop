'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { attrLabel } from '../../../../lib/format';
import { api, dateTime, errorText, MOVEMENT_LABEL, signed, type Movement } from '../../../../lib/stock-api';

// v2 (D88): the product ledger. Every stock movement of every variant of this product, newest first, straight from the
// stock history (the ledger is the only place stock changes, so this is the full story: opening, receipts, sales, returns,
// adjustments, transfers, stocktakes). Shown to roles with stock.read; the API checks it again.

export function ProductLedger({ productId, variable }: { productId: string; variable: boolean }) {
  const [items, setItems] = useState<Movement[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setBusy(true); setError('');
    try {
      const qs = new URLSearchParams({ productId, limit: '25', ...(cursor ? { cursor } : {}) });
      const { data } = await api<{ items: Movement[]; nextCursor: string | null }>(`/stock/movements?${qs}`);
      setItems((cur) => (cursor && cur ? [...cur, ...data.items] : data.items));
      setNext(data.nextCursor);
    } catch (e) { setError(errorText(e)); setItems((cur) => cur ?? []); } finally { setBusy(false); }
  }, [productId]);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="ui-panel" aria-labelledby="ledger-title">
      <div className="ui-panel-head">
        <h2 className="ui-h3" id="ledger-title">Product ledger</h2>
        <span className="ui-caption">every stock movement, newest first</span>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert" style={{ margin: 'var(--space-3) var(--space-4)' }}><div className="ui-alert-body">{error}</div></div>}
      {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 120 }} /></div>
        : items.length === 0 ? <div className="ui-panel-body ui-muted">No stock movements yet. Opening stock, purchases and sales of this product will show here.</div>
          : (
            <div className="ui-table-wrap">
              <table className="ui-table" data-collapse>
                <thead><tr>
                  <th scope="col">When</th><th scope="col">What</th><th scope="col">Document</th>
                  {variable && <th scope="col">Variant</th>}
                  <th scope="col">Location</th><th scope="col" className="ui-qty">Change</th><th scope="col" className="ui-qty">Balance</th><th scope="col">By</th>
                </tr></thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.id}>
                      <td data-primary style={{ whiteSpace: 'nowrap' }}>{dateTime(m.postedAt)}</td>
                      <td data-label="What">{m.reasonCode === 'opening' ? 'Opening stock' : MOVEMENT_LABEL[m.movementType] ?? m.movementType}</td>
                      <td data-label="Document"><Link className="ui-code" href={`/stock/movements?sourceId=${m.source.id}`}>{m.source.number}</Link></td>
                      {variable && <td data-label="Variant">{attrLabel(m.attributes) || m.sku}</td>}
                      <td data-label="Location">{m.locationName}{m.bucket === 'non_sellable' && <span className="ui-caption"> (not for sale)</span>}</td>
                      <td data-label="Change" className="ui-qty" style={{ color: m.qtyDelta.startsWith('-') ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{signed(m.qtyDelta)}</td>
                      <td data-label="Balance" className="ui-qty">{m.balanceAfter}</td>
                      <td data-label="By">{m.actor.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {next && <div className="ui-pager"><span /><button className="ui-btn ui-btn--sm" type="button" onClick={() => load(next)} disabled={busy}>{busy ? 'Loading…' : 'Show older'}</button></div>}
    </section>
  );
}
