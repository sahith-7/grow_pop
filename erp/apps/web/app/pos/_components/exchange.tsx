'use client';

import { useState } from 'react';
import { money } from '../../../lib/format';
import { QtyStepper } from '../../../lib/qty';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../lib/suggest';
import { ApiError, api, errorText, type ExchangeQuote, type InvoiceSummary, type TaxDocument } from '../../../lib/sales-api';

// Exchange (v2, D108): pick what comes back from the old bill. Its credit then pays for the bill on screen; the customer
// pays what is left, or gets the rest back. Nothing is posted until the cashier finishes the new bill.

export interface ExchangeState {
  invoiceId: string; invoiceNumber: string; reason: string; credit: string; creditNoteFrom: string;
  lines: { invoiceLineId: string; qty: string; condition: 'resellable' | 'damaged' }[];
  items: { description: string; qty: string; credit: string }[];
  customer: { id: string; name: string; phone: string | null } | null;
}

type Pick = { qty: string; condition: 'resellable' | 'damaged' };

export function ExchangeDialog({ outletId, onDone, onClose }: { outletId: string; onDone: (x: ExchangeState) => void; onClose: () => void }) {
  const [number, setNumber] = useState('');
  const sg = useSuggest<SearchHit>({ q: number, load: (t) => searchHits(t, ['invoice']) });
  const [inv, setInv] = useState<TaxDocument | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});

  const open = async (id: string) => {
    setError(''); setFields({});
    try {
      const { data } = await api<TaxDocument>(`/invoices/${id}`);
      if (data.type !== 'invoice') { setError('That is a credit note. Find the bill it was issued against.'); return; }
      if (data.voided) { setError(`${data.number} was voided: nothing on it can be exchanged.`); return; }
      setInv(data); setPicks({});
    } catch (e) { setError(errorText(e)); }
  };
  const pickHit = (h: SearchHit) => { sg.quiet(h.title); setNumber(h.title); open(h.id); };
  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = number.trim();
    if (!n) return;
    setError('');
    try {
      const { data } = await api<{ items: InvoiceSummary[] }>(`/invoices?type=invoice&limit=5&q=${encodeURIComponent(n)}`);
      const hit = data.items.find((d) => d.number.toLowerCase() === n.toLowerCase()) ?? (data.items.length === 1 ? data.items[0] : null);
      if (!hit) { setError(data.items.length ? 'Several bills match. Type the full number.' : 'No bill with that number.'); return; }
      open(hit.id);
    } catch (err) { setError(errorText(err)); }
  };

  const items = (inv?.lines ?? []).filter((l) => l.kind === 'item');
  const chosen = items.filter((l) => Number(picks[l.id]?.qty ?? 0) > 0);
  const use = async () => {
    if (!inv) return;
    setBusy(true); setError(''); setFields({});
    const lines = chosen.map((l) => ({ invoiceLineId: l.id, qty: picks[l.id].qty, condition: picks[l.id].condition }));
    try {
      const { data } = await api<ExchangeQuote>('/pos/exchanges/quote', { method: 'POST', body: { outletId, invoiceId: inv.id, lines } });
      onDone({
        invoiceId: inv.id, invoiceNumber: inv.number, reason: reason.trim(), credit: data.credit, creditNoteFrom: data.creditNoteFrom, lines,
        items: data.lines.map((l) => ({ description: l.description, qty: l.qty, credit: l.credit })),
        customer: data.invoice.customerId ? { id: data.invoice.customerId, name: inv.buyer?.name ?? data.invoice.customer ?? '', phone: inv.buyer?.phone ?? null } : null,
      });
    } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); } finally { setBusy(false); }
  };

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="ex-title" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 100%)' }}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="ex-title">Exchange: what comes back</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          <form className="gp-suggest" onSubmit={find} role="search">
            <input className="ui-input ui-search" autoFocus placeholder="Old bill number, e.g. INV/26-27/41" aria-label="Old bill number" value={number}
              onChange={(e) => setNumber(e.target.value)} {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, pickHit)} />
            <Suggestions s={sg} onPick={pickHit} label="Matching bills" render={(h) => <HitRow hit={h} />} />
          </form>
          {inv && (
            <>
              <div className="ui-caption"><strong>{inv.number}</strong> · {inv.buyer?.name || 'Walk-in'} · {money(inv.total)} · {inv.issuedDate}</div>
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Item</th><th scope="col" className="ui-num">Can return</th><th scope="col">Coming back</th><th scope="col">Condition</th></tr></thead>
                <tbody>{items.map((l) => {
                  const left = Number(l.returnableQty ?? 0);
                  const p = picks[l.id] ?? { qty: '0', condition: 'resellable' as const };
                  const set = (patch: Partial<Pick>) => setPicks({ ...picks, [l.id]: { ...p, ...patch } });
                  const err = fields[`lines.${chosen.indexOf(l)}.qty`]?.[0];
                  return (
                    <tr key={l.id}>
                      <td data-primary><div className="ui-cell-title">{l.description}</div><div className="ui-cell-sub"><span className="ui-code">{l.sku}</span> · {money(l.lineTotal)} for {l.qty}</div></td>
                      <td className="ui-num" data-label="Can return">{l.returnableQty}</td>
                      <td data-label="Coming back">{left > 0 ? (
                        <><QtyStepper value={p.qty} onChange={(v) => set({ qty: v })} label={`Quantity of ${l.description} coming back`} max={left} decimals={!!l.allowFraction} width={56} invalid={!!err} />
                          {err && <div className="ui-error">{err}</div>}</>
                      ) : <span className="ui-muted">All returned</span>}</td>
                      <td data-label="Condition">{left > 0 && (
                        <select className="ui-select" style={{ width: 'auto' }} value={p.condition} aria-label={`Condition of ${l.description}`} onChange={(e) => set({ condition: e.target.value as Pick['condition'] })}>
                          <option value="resellable">Back to stock</option><option value="damaged">Damaged</option>
                        </select>)}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              <label className="ui-field"><span className="ui-label">Reason</span>
                <input className="ui-input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong size" aria-invalid={!!fields['exchange.reason']} /></label>
              <span className="ui-help">The items come back into this counter’s stock room. A credit note is issued against {inv.number}; its value pays for the new bill.</span>
            </>
          )}
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !inv || !chosen.length || reason.trim().length < 3} aria-busy={busy} onClick={use}>Use as credit</button>
        </div>
      </div>
    </div>
  );
}
