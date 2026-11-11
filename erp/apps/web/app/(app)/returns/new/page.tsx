'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { QtyStepper } from '../../../../lib/qty';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../../lib/suggest';
import { idemKey, type StockMeta } from '../../../../lib/stock-api';
import { ApiError, api, CONDITION, errorText, PAY_METHOD, type InvoiceSummary, type TaxDocument } from '../../../../lib/sales-api';
import type { Till } from '../../../../lib/cash-api';
import { useMe } from '../../../../lib/me';
import { roomsInView } from '../../../../lib/outlet-scope';

// Customer return (J12): find the invoice, pick what comes back and its condition, choose how the money goes back.
// The server works out the credit in proportion to the invoice line and issues the credit note.

type Pick = { qty: string; condition: 'resellable' | 'damaged' | 'not_returned' };
const NONE: Pick = { qty: '0', condition: 'resellable' };

function NewReturn() {
  const router = useRouter();
  const params = useSearchParams();
  const [number, setNumber] = useState('');
  const sg = useSuggest<SearchHit>({ q: number, load: (t) => searchHits(t, ['invoice']) });
  const pickHit = (h: SearchHit) => { sg.quiet(h.title); setNumber(h.title); router.replace(`/returns/new?invoice=${h.id}`); };
  const [inv, setInv] = useState<TaxDocument | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('cash');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const view = useMe().outlets;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [key, setKey] = useState(idemKey);
  // Cash given back leaves a till's drawer (v2, D110). With one register open the server picks it; with several, say which.
  const [openTills, setOpenTills] = useState<Till[]>([]);
  const [tillId, setTillId] = useState('');
  useEffect(() => { api<{ items: Till[] }>('/tills').then(({ data }) => setOpenTills(data.items.filter((t) => t.open))).catch(() => {}); }, []);

  const open = async (id: string) => {
    setError('');
    try {
      const { data } = await api<TaxDocument>(`/invoices/${id}`);
      if (data.type !== 'invoice') { setError('That is a credit note. Open the invoice it was issued against.'); return; }
      setInv(data); setPicks({}); setKey(idemKey());
      setRefund(data.order?.channel === 'pos' ? (data.payments?.find((p) => p.kind === 'payment')?.method ?? 'cash') : 'original');
    } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { const id = params.get('invoice'); if (id) open(id); }, [params]);
  // Locations are only listed to people who can see stock; everyone else returns to the sale's own location. v2 (D115):
  // the rooms at the outlet in view, where the goods are being taken back.
  useEffect(() => { api<StockMeta>('/stock/meta').then(({ data }) => setLocations(roomsInView(view, data.locations.filter((l) => l.active)))).catch(() => {}); }, []);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = number.trim();
    if (!n) return;
    setError('');
    try {
      const { data } = await api<{ items: InvoiceSummary[] }>(`/invoices?type=invoice&limit=5&q=${encodeURIComponent(n)}`);
      const hit = data.items.find((d) => d.number.toLowerCase() === n.toLowerCase()) ?? (data.items.length === 1 ? data.items[0] : null);
      if (!hit) { setError(data.items.length ? 'Several invoices match. Type the full number.' : 'No invoice with that number.'); return; }
      router.replace(`/returns/new?invoice=${hit.id}`);
    } catch (err) { setError(errorText(err)); }
  };

  const set = (lineId: string, patch: Partial<Pick>) => { setPicks((p) => ({ ...p, [lineId]: { ...NONE, ...p[lineId], ...patch } })); setKey(idemKey()); };
  const chosen = Object.entries(picks).filter(([, p]) => Number(p.qty) > 0);

  const submit = async () => {
    if (!inv) return;
    setBusy(true); setError(''); setFieldErrors({});
    try {
      const { data } = await api<{ creditNoteId: string }>('/returns', {
        method: 'POST', headers: key,
        body: { invoiceId: inv.id, reason, refundMethod: refund, ...(locationId ? { locationId } : {}), ...(tillId && (refund === 'cash' || refund === 'original') ? { tillId } : {}), lines: chosen.map(([invoiceLineId, p]) => ({ invoiceLineId, qty: p.qty, condition: p.condition })) },
      });
      router.push(`/invoices/${data.creditNoteId}`);
    } catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFieldErrors(e.fieldErrors); setBusy(false); }
  };

  const items = inv?.lines.filter((l) => l.kind === 'item') ?? [];
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/returns">Returns /</Link><h1 className="ui-h1">New return</h1></div></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <form className="ui-toolbar" onSubmit={find}>
        <div className="gp-suggest">
          <input className="ui-input ui-search" placeholder="Invoice number, customer name or phone" aria-label="Invoice number" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus={!params.get('invoice')}
            {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, pickHit)} />
          <Suggestions s={sg} onPick={pickHit} render={(h) => <HitRow hit={h} />} label="Matching invoices" />
        </div>
        <button className="ui-btn" type="submit">Find invoice</button>
      </form>

      {inv && (
        <>
          <div className="ui-panel">
            <div className="ui-panel-head"><span className="ui-h3"><Link href={`/invoices/${inv.id}`}>{inv.number}</Link> · {inv.buyer?.name || 'Walk-in'} · {money(inv.total)}</span></div>
            {inv.voided ? <div className="ui-panel-body">This invoice was voided; nothing more can be returned.</div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Item</th><th scope="col" className="ui-num">Sold</th><th scope="col" className="ui-num">Can return</th><th scope="col">Return</th><th scope="col">Condition</th></tr></thead>
                <tbody>{items.map((l, i) => {
                  const p = picks[l.id];
                  const left = Number(l.returnableQty);
                  const idx = chosen.findIndex(([id]) => id === l.id);
                  const err = idx >= 0 ? fieldErrors[`lines.${idx}.qty`]?.[0] : undefined;
                  return (
                    <tr key={l.id} style={left <= 0 ? { opacity: 0.6 } : undefined}>
                      <td data-primary><div className="ui-cell-title">{l.description}</div><div className="ui-cell-sub ui-code">{l.sku}</div><div className="ui-cell-sub">{money(l.lineTotal)} for {l.qty}</div></td>
                      <td className="ui-num" data-label="Sold">{l.qty}</td>
                      <td className="ui-num" data-label="Can return">{l.returnableQty}</td>
                      <td data-label="Return">
                        <QtyStepper label={`Quantity of ${l.description} to return`} disabled={left <= 0} max={left}
                          value={p?.qty ?? ''} placeholder="0" onChange={(v) => set(l.id, { qty: v })} invalid={!!err} />
                        {left > 0 && <button className="ui-btn ui-btn--sm" type="button" onClick={() => set(l.id, { qty: l.returnableQty! })}>All</button>}
                        {err && <div className="ui-error">{err}</div>}
                      </td>
                      <td data-label="Condition">
                        <select className="ui-select" disabled={left <= 0} value={p?.condition ?? 'resellable'} onChange={(e) => set(l.id, { condition: e.target.value as Pick['condition'] })} aria-label={`Condition of ${l.description}`} data-row={i}>
                          {Object.entries(CONDITION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>

          {!inv.voided && (
            <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 520 }}>
              <label className="ui-field"><span className="ui-label">Reason</span>
                <input className="ui-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong size" aria-invalid={!!fieldErrors.reason} />
                {fieldErrors.reason && <span className="ui-error">{fieldErrors.reason[0]}</span>}</label>
              <label className="ui-field"><span className="ui-label">Money back</span>
                <select className="ui-select" value={refund} onChange={(e) => setRefund(e.target.value)} aria-invalid={!!fieldErrors.refundMethod}>
                  {['cash', 'upi', 'card', 'other', 'original', 'none'].map((m) => <option key={m} value={m}>{PAY_METHOD[m]}</option>)}
                </select>
                {fieldErrors.refundMethod && <span className="ui-error">{fieldErrors.refundMethod[0]}</span>}
                <span className="ui-help">“Original payment”: on a counter bill, the way it was paid (cash comes out of the drawer); on a web order, back through the shop’s payment gateway, which the ERP only records.</span></label>
              {(refund === 'cash' || refund === 'original') && openTills.length > 1 && (
                <label className="ui-field"><span className="ui-label">Cash comes out of</span>
                  <select className="ui-select" value={tillId} onChange={(e) => setTillId(e.target.value)} aria-invalid={!!fieldErrors.tillId}>
                    <option value="">Choose the till…</option>
                    {openTills.map((t) => <option key={t.id} value={t.id}>{t.name}{new Set(openTills.map((x) => x.outletId)).size > 1 ? ` · ${t.outlet}` : ''}</option>)}
                  </select>
                  {fieldErrors.tillId && <span className="ui-error">{fieldErrors.tillId[0]}</span>}</label>
              )}
              {locations.length > 1 && (
                <label className="ui-field"><span className="ui-label">Goods go back to</span>
                  <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Where it was sold from</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select></label>
              )}
              <div className="ui-actions">
                <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !chosen.length || reason.trim().length < 3} aria-busy={busy} onClick={submit}>
                  Issue credit note{chosen.length ? ` for ${chosen.length} item${chosen.length > 1 ? 's' : ''}` : ''}</button>
              </div>
              <p className="ui-caption" style={{ margin: 0 }}>The credit is worked out from what the customer paid on this invoice, including any discount. Damaged goods go to non-sellable stock.</p>
            </div></div>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><NewReturn /></Suspense>;
}
