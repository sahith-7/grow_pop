'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attrLabel, money } from '../../lib/format';
import { idemKey } from '../../lib/stock-api';
import {
  ApiError, api, errorText, PAY_METHOD, type Customer, type DaySummary, type LookupItem, type PosContext, type Quote, type SaleResult,
} from '../../lib/sales-api';
import { SubscriptionBanner } from '../(app)/_components/subscription-banner';
import { PRINT_CSS, TaxDocumentView, type Paper } from '../(app)/invoices/_components/tax-document';

// Counter sale (J11). The browser only collects what the cashier typed; the server prices the cart (quote) and the sale
// re-prices it and checks the total the cashier saw. Enter in the scan box adds an item and never takes payment.

interface Line { variantId: string; sku: string; name: string; attributes: Record<string, string>; price: string; mrp: string | null; allowFraction: boolean; qty: string; unitPriceOverride: string; discountPct: string }
interface Pay { method: 'cash' | 'card' | 'upi' | 'other'; amount: string; reference: string }

const paise = (v: string) => Math.round(Number(v || '0') * 100);
const rupees = (p: number) => (p / 100).toFixed(2);

export default function PosPage() {
  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [error, setError] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [cartPct, setCartPct] = useState('');
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<{ message: string; fields: Record<string, string[]> } | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [paysTouched, setPaysTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SaleResult | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [key, setKey] = useState(idemKey);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api<PosContext>('/pos/context').then((r) => setCtx(r.data)).catch((e) => setError(errorText(e))); }, []);

  // What the server prices. Any change makes a new sale attempt, so it also gets a new idempotency key.
  const cart = useMemo(() => ({
    customerId: customer?.id ?? null,
    lines: lines.map((l) => ({
      variantId: l.variantId, qty: l.qty || '0',
      ...(l.unitPriceOverride ? { unitPriceOverride: l.unitPriceOverride } : {}),
      ...(l.discountPct ? { discountPct: l.discountPct } : {}),
    })),
    ...(cartPct ? { cartDiscountPct: cartPct } : {}),
    ...(reason.trim() ? { cartDiscountReason: reason.trim() } : {}),
  }), [lines, customer, cartPct, reason]);
  const cartJson = JSON.stringify(cart);

  useEffect(() => {
    setKey(idemKey());
    if (!lines.length) { setQuote(null); setQuoteError(null); return; }
    const t = setTimeout(() => {
      api<Quote>('/pos/quote', { method: 'POST', body: cart })
        .then((r) => { setQuote(r.data); setQuoteError(null); })
        .catch((e) => {
          // "Check the highlighted fields" alone does not say what to fix at a busy counter: show the field messages too.
          const fields = e instanceof ApiError ? e.fieldErrors : {};
          const detail = [...new Set(Object.values(fields).flat())].join(' · ');
          setQuote(null); setQuoteError({ message: e instanceof ApiError && e.code === 'VALIDATION_ERROR' && detail ? detail : errorText(e), fields });
        });
    }, 250);
    return () => clearTimeout(t);
  }, [cartJson]);

  // Until the cashier edits payments, the bill is paid in one cash amount equal to the total.
  useEffect(() => { if (quote && !paysTouched) setPays([{ method: 'cash', amount: quote.total, reference: '' }]); }, [quote?.total, paysTouched]);

  const add = (item: LookupItem) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.variantId === item.variantId);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: String(Number(l.qty || '0') + 1) } : l));
      return [...ls, { variantId: item.variantId, sku: item.sku, name: item.name, attributes: item.attributes, price: item.price, mrp: item.mrp, allowFraction: item.allowFraction, qty: '1', unitPriceOverride: '', discountPct: '' }];
    });
    scanRef.current?.focus();
  };
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const reset = () => { setLines([]); setCustomer(null); setCartPct(''); setReason(''); setPays([]); setPaysTouched(false); setDone(null); setError(''); setTimeout(() => scanRef.current?.focus(), 0); };

  const totalP = quote ? paise(quote.total) : 0;
  const paidP = pays.reduce((a, p) => a + paise(p.amount), 0);
  const nonCashP = pays.filter((p) => p.method !== 'cash').reduce((a, p) => a + paise(p.amount), 0);
  const changeP = paidP - totalP;
  const payProblem = !quote ? '' : nonCashP > totalP ? 'Card, UPI and other cannot be more than the total; only cash gives change.' : paidP < totalP ? `${money(rupees(totalP - paidP))} still to pay` : '';
  const discountsOn = Number(cartPct) > 0 || lines.some((l) => Number(l.discountPct) > 0);
  const needReason = !!ctx && (Number(cartPct) > Number(ctx.discount.reasonAbovePct) || lines.some((l) => Number(l.discountPct) > Number(ctx.discount.reasonAbovePct))
    || Object.keys(quoteError?.fields ?? {}).some((k) => k.endsWith('discountReason')));

  const charge = async () => {
    if (!quote || payProblem) return;
    setBusy(true); setError('');
    try {
      const { data } = await api<SaleResult>('/pos/sales', {
        method: 'POST', headers: key,
        body: { ...cart, expectedTotal: quote.total, payments: pays.filter((p) => paise(p.amount) > 0).map((p) => ({ method: p.method, amount: p.amount, ...(p.reference.trim() ? { reference: p.reference.trim() } : {}) })) },
      });
      setDone(data);
    } catch (e) {
      setError(errorText(e));
      // Prices or stock changed under us: re-quote with a fresh key so the cashier sees the new total before paying.
      if (e instanceof ApiError && e.status === 409) { setKey(idemKey()); api<Quote>('/pos/quote', { method: 'POST', body: cart }).then((r) => setQuote(r.data)).catch(() => {}); }
    } finally { setBusy(false); }
  };

  if (!ctx) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 320 }} />}</div>;

  const header = (
    <div className="ui-page-header" style={{ marginBottom: 0 }}>
      <div><h1 className="ui-h1">Counter</h1><div className="ui-caption">{ctx.seller.name}{ctx.location ? ` · selling from ${ctx.location.name}` : ''}{ctx.pricesIncludeTax ? ' · prices include GST' : ' · GST added to prices'}</div></div>
      <div className="ui-actions">
        <button className="ui-btn" type="button" onClick={() => setShowSummary(true)}>Today’s takings</button>
        <Link className="ui-btn" href="/returns/new">Return</Link>
        <Link className="ui-btn" href="/invoices">Invoices</Link>
        <Link className="ui-btn" href="/dashboard">Exit</Link>
      </div>
    </div>
  );

  if (!ctx.ready) {
    return (
      <div className="ui-content">{header}
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          <strong>The counter cannot bill yet.</strong>
          <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.2em' }}>{ctx.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          <div style={{ marginTop: 'var(--space-2)' }}>An owner fixes this in <Link href="/billing">Billing &amp; GST</Link> and <Link href="/settings">Settings</Link>.</div>
        </div></div>
      </div>
    );
  }

  if (done) return <SaleDone sale={done} onNext={reset} />;

  const lineErr = (i: number, k: string) => quoteError?.fields[`lines.${i}.${k}`]?.[0];
  return (
    <div className="ui-content" style={{ maxWidth: 'none' }}>
      {header}
      <SubscriptionBanner />
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 380px)', alignItems: 'start' }} className="pos-grid">
        <div style={{ display: 'grid', gap: 'var(--space-4)', minWidth: 0 }}>
          <Scanner inputRef={scanRef} onAdd={add} />

          <div className="ui-panel">
            {lines.length === 0 ? <div className="ui-empty"><p className="ui-h3">Scan or search to start a bill</p></div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th>{ctx.discount.allowed && <th scope="col">Disc %</th>}<th scope="col" className="ui-money">Total</th><th scope="col" aria-label="Remove" /></tr></thead>
                <tbody>{lines.map((l, i) => {
                  const q = quote?.lines[i];
                  return (
                    <tr key={l.variantId}>
                      <td data-primary><div className="ui-cell-title">{l.name}{Object.keys(l.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(l.attributes)}</span>}</div>
                        <div className="ui-cell-sub"><span className="ui-code">{l.sku}</span>{q && <> · GST {q.gstRate}%{Number(q.available) < Number(l.qty) && <span style={{ color: 'var(--danger)' }}> · only {q.available} in stock</span>}</>}</div>
                        {lineErr(i, 'variantId') && <div className="ui-error">{lineErr(i, 'variantId')}</div>}</td>
                      <td data-label="Qty">
                        <input className="ui-input ui-input--num" style={{ width: 80 }} inputMode={l.allowFraction ? 'decimal' : 'numeric'} value={l.qty} aria-label={`Quantity of ${l.name}`}
                          onChange={(e) => setLine(i, { qty: e.target.value })} aria-invalid={!!lineErr(i, 'qty')} />
                        {lineErr(i, 'qty') && <div className="ui-error">{lineErr(i, 'qty')}</div>}</td>
                      <td data-label="Price">
                        {ctx.canOverridePrice
                          ? <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" placeholder={l.price} value={l.unitPriceOverride} aria-label={`Price of ${l.name}`}
                              onChange={(e) => setLine(i, { unitPriceOverride: e.target.value })} aria-invalid={!!lineErr(i, 'unitPriceOverride')} />
                          : money(l.price)}
                        {l.mrp && <div className="ui-cell-sub">MRP {money(l.mrp)}</div>}
                        {lineErr(i, 'unitPriceOverride') && <div className="ui-error">{lineErr(i, 'unitPriceOverride')}</div>}</td>
                      {ctx.discount.allowed && (
                        <td data-label="Disc %">
                          <input className="ui-input ui-input--num" style={{ width: 70 }} inputMode="decimal" placeholder="0" value={l.discountPct} aria-label={`Discount on ${l.name}`}
                            onChange={(e) => setLine(i, { discountPct: e.target.value })} aria-invalid={!!lineErr(i, 'discountPct')} />
                          {lineErr(i, 'discountPct') && <div className="ui-error">{lineErr(i, 'discountPct')}</div>}</td>
                      )}
                      <td className="ui-money" data-label="Total">{q ? money(q.lineTotal) : '…'}{q && Number(q.discount) > 0 && <div className="ui-cell-sub">−{money(q.discount)}</div>}</td>
                      <td><button className="ui-btn ui-btn--sm" type="button" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>

          {ctx.discount.allowed && lines.length > 0 && (
            <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="ui-field" style={{ width: 140 }}><span className="ui-label">Bill discount %</span>
                <input className="ui-input ui-input--num" inputMode="decimal" placeholder="0" value={cartPct} onChange={(e) => setCartPct(e.target.value)} /></label>
              {(needReason || (discountsOn && reason)) && (
                <label className="ui-field" style={{ flex: 1, minWidth: 220 }}><span className="ui-label">Reason for the discount</span>
                  <input className="ui-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged box, regular customer" aria-invalid={needReason && !reason.trim()} /></label>
              )}
              <span className="ui-help">Your limit: {ctx.discount.limitPct}% in total per item. Above {ctx.discount.reasonAbovePct}% needs a reason.</span>
            </div></div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <CustomerBox customer={customer} onChange={setCustomer} states={ctx.states} error={quoteError?.fields.customerId?.[0]} />

          {(quote || quoteError) && <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {quoteError && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{quoteError.message}</div></div>}
            {quote && (
              <>
                <Row label="Items" value={money(quote.subtotal)} />
                {Number(quote.discountTotal) > 0 && <Row label="Discount" value={`−${money(quote.discountTotal)}`} />}
                {Number(quote.taxBreakdown.igst) > 0
                  ? <Row label="IGST" value={money(quote.taxBreakdown.igst)} muted />
                  : Number(quote.taxBreakdown.cgst) > 0 && <><Row label="CGST" value={money(quote.taxBreakdown.cgst)} muted /><Row label="SGST" value={money(quote.taxBreakdown.sgst)} muted /></>}
                {Number(quote.roundOff) !== 0 && <Row label="Round off" value={money(quote.roundOff)} muted />}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-2)' }}>
                  <span className="ui-h3">Total</span><span className="ui-money" style={{ fontSize: '1.75rem', fontWeight: 600 }}>{money(quote.total)}</span>
                </div>
                <div className="ui-caption">{quote.docTitle}{quote.pricesIncludeTax ? ' · tax included in prices' : ''}</div>
                {quote.shortages.length > 0 && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">
                  Not enough free stock: {quote.shortages.map((x) => `${x.sku} (${x.available} free)`).join(', ')}. Stock held for web orders does not count.
                  The sale is refused until a manager corrects the stock (Stock → Adjust) or you lower the quantity.</div></div>}
              </>
            )}
          </div></div>}

          {quote && (
            <Payments total={quote.total} pays={pays} onChange={(p) => { setPays(p); setPaysTouched(true); }} />
          )}

          {quote && (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              {payProblem ? <div className="ui-caption" style={{ color: 'var(--danger)' }}>{payProblem}</div>
                : changeP > 0 && <div className="ui-h3">Give change: {money(rupees(changeP))}</div>}
              <button className="ui-btn ui-btn--primary" type="button" style={{ height: 56, fontSize: '1.1rem' }} disabled={busy || !!payProblem || !!quoteError || quote.shortages.length > 0 || (needReason && !reason.trim())} aria-busy={busy} onClick={charge}>
                Take {money(quote.total)}
              </button>
              <button className="ui-btn" type="button" disabled={busy} onClick={reset}>Clear bill</button>
            </div>
          )}
        </div>
      </div>

      {showSummary && <Summary onClose={() => setShowSummary(false)} />}
      <style>{`@media (max-width: 900px) { .pos-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }} className={muted ? 'ui-muted' : undefined}><span>{label}</span><span className="ui-money">{value}</span></div>;
}

/** Scan box: a barcode scanner types the code and presses Enter. An exact barcode or SKU adds at once; anything else lists matches. */
function Scanner({ inputRef, onAdd }: { inputRef: React.RefObject<HTMLInputElement | null>; onAdd: (i: LookupItem) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<LookupItem[] | null>(null);
  const [msg, setMsg] = useState('');

  // A scanner can send the next code before the last lookup answers. Clear the box at once and run lookups one at a time,
  // in scan order, so no scan is lost or added out of order.
  const chain = useRef(Promise.resolve());
  const look = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    setQ(''); setMsg('');
    chain.current = chain.current.then(async () => {
      try {
        const { data } = await api<{ items: LookupItem[] }>(`/pos/lookup?q=${encodeURIComponent(text)}`);
        const exact = data.items.filter((i) => i.exact);
        if (exact.length === 1) { onAdd(exact[0]); setHits(null); return; }
        if (!data.items.length) { setMsg(`Nothing found for “${text}”`); setHits(null); return; }
        setHits(data.items); setQ((cur) => cur || text);
      } catch (err) { setMsg(errorText(err)); }
    });
  };

  return (
    <div className="ui-panel">
      <form className="ui-toolbar" role="search" onSubmit={look}>
        <input ref={inputRef} className="ui-input ui-search" autoFocus autoComplete="off" placeholder="Scan a barcode, or type a SKU or name and press Enter" aria-label="Scan or search items" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      {msg && <div className="ui-panel-body ui-error" role="status">{msg}</div>}
      {hits && (
        <div>{hits.map((h) => (
          <button key={h.variantId} type="button" className="ui-list-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
            onClick={() => { onAdd(h); setQ(''); setHits(null); }}>
            <span><span className="ui-cell-title">{h.name}</span>{Object.keys(h.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(h.attributes)}</span>}
              <span className="ui-cell-sub"> <span className="ui-code">{h.sku}</span> · {h.available} in stock{h.gstRate === null ? ' · no GST rate set' : ''}</span></span>
            <span className="ui-money">{money(h.price)}</span>
          </button>
        ))}</div>
      )}
    </div>
  );
}

function CustomerBox({ customer, onChange, states, error }: { customer: Customer | null; onChange: (c: Customer | null) => void; states: { code: string; name: string }[]; error?: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Customer[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    try { const { data } = await api<{ items: Customer[] }>(`/customers?limit=8&q=${encodeURIComponent(q.trim())}`); setHits(data.items); setMsg(data.items.length ? '' : 'No customer found'); }
    catch (err) { setMsg(errorText(err)); }
  };

  if (customer) {
    return (
      <div className="ui-panel"><div className="ui-panel-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <div><div className="ui-cell-title">{customer.name}</div>
            <div className="ui-cell-sub">{[customer.phone, customer.gstin ? `GSTIN ${customer.gstin}` : null, customer.stateName].filter(Boolean).join(' · ')}</div></div>
          <button className="ui-btn ui-btn--sm" type="button" onClick={() => onChange(null)}>Remove</button>
        </div>
        {customer.gstin && <div className="ui-help">Business sale (B2B): the invoice shows their GSTIN.</div>}
        {error && <div className="ui-error">{error}</div>}
      </div></div>
    );
  }

  return (
    <div className="ui-panel">
      <form className="ui-toolbar" onSubmit={search}>
        <input className="ui-input ui-search" placeholder="Customer phone, name or GSTIN (optional)" aria-label="Find a customer" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ui-btn ui-btn--sm" type="button" onClick={() => setCreating(true)}>New</button>
      </form>
      {error && <div className="ui-panel-body ui-error">{error}</div>}
      {msg && <div className="ui-panel-body ui-muted">{msg}</div>}
      {hits?.map((c) => (
        <button key={c.id} type="button" className="ui-list-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => { onChange(c); setHits(null); setQ(''); }}>
          <span><span className="ui-cell-title">{c.name || 'No name'}</span><span className="ui-cell-sub"> {[c.phone, c.gstin].filter(Boolean).join(' · ')}</span></span>
        </button>
      ))}
      {creating && <NewCustomer initial={q} states={states} onClose={() => setCreating(false)} onCreated={(c) => { onChange(c); setCreating(false); setQ(''); setHits(null); }} />}
    </div>
  );
}

function NewCustomer({ initial, states, onClose, onCreated }: { initial: string; states: { code: string; name: string }[]; onClose: () => void; onCreated: (c: Customer) => void }) {
  const digits = /^\+?\d{8,15}$/.test(initial.trim());
  const [f, setF] = useState({ name: digits ? '' : initial.trim(), phone: digits ? initial.trim() : '', gstin: '', stateCode: '', address: '' });
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError(''); setErrors({});
    const body = Object.fromEntries(Object.entries(f).filter(([k, v]) => k === 'name' || v.trim()).map(([k, v]) => [k, v.trim()]));
    try { const { data } = await api<Customer>('/customers', { method: 'POST', body }); onCreated(data); }
    catch (e) { setError(errorText(e)); if (e instanceof ApiError) setErrors(e.fieldErrors); } finally { setBusy(false); }
  };
  const field = (k: keyof typeof f, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="ui-field"><span className="ui-label">{label}</span>
      <input className="ui-input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={!!errors[k]} {...extra} />
      {errors[k] && <span className="ui-error">{errors[k][0]}</span>}</label>
  );

  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="cust-title" onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="cust-title">New customer</h2></div>
        <div className="ui-dialog-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          {field('name', 'Name', { autoFocus: true })}
          {field('phone', 'Phone', { inputMode: 'tel' })}
          {field('gstin', 'GSTIN (business customers)', { style: { textTransform: 'uppercase' } })}
          {!f.gstin.trim() && (
            <label className="ui-field"><span className="ui-label">State</span>
              <select className="ui-select" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}>
                <option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          )}
          {field('address', 'Address')}
          <span className="ui-help">Only what the bill needs. A bill of ₹50,000 or more to a customer without a GSTIN needs their name, address and state.</span>
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !f.name.trim()} aria-busy={busy} onClick={save}>Add customer</button>
        </div>
      </div>
    </div>
  );
}

function Payments({ total, pays, onChange }: { total: string; pays: Pay[]; onChange: (p: Pay[]) => void }) {
  const set = (i: number, patch: Partial<Pay>) => onChange(pays.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const left = paise(total) - pays.reduce((a, p) => a + paise(p.amount), 0);
  return (
    <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div className="ui-segmented" role="group" aria-label="Pay all by">
        {(['cash', 'upi', 'card'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={pays.length === 1 && pays[0].method === m} onClick={() => onChange([{ method: m, amount: total, reference: '' }])}>{PAY_METHOD[m]}</button>
        ))}
      </div>
      {pays.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <select className="ui-select" style={{ width: 100 }} value={p.method} aria-label="Payment method" onChange={(e) => set(i, { method: e.target.value as Pay['method'] })}>
            {(['cash', 'upi', 'card', 'other'] as const).map((m) => <option key={m} value={m}>{PAY_METHOD[m]}</option>)}
          </select>
          <input className="ui-input ui-input--num" inputMode="decimal" value={p.amount} aria-label={p.method === 'cash' ? 'Cash received' : 'Amount'} onChange={(e) => set(i, { amount: e.target.value })} />
          {p.method !== 'cash' && <input className="ui-input" placeholder="Ref / last 4" aria-label="Reference" value={p.reference} maxLength={100} onChange={(e) => set(i, { reference: e.target.value })} />}
          {pays.length > 1 && <button className="ui-btn ui-btn--sm" type="button" aria-label="Remove payment" onClick={() => onChange(pays.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {pays.length < 6 && <button className="ui-btn ui-btn--sm" type="button" style={{ justifySelf: 'start' }}
        onClick={() => onChange([...pays, { method: 'upi', amount: left > 0 ? rupees(left) : '', reference: '' }])}>Split payment</button>}
      <span className="ui-help">For cash, type what the customer handed over; the change is worked out.</span>
    </div></div>
  );
}

function SaleDone({ sale, onNext }: { sale: SaleResult; onNext: () => void }) {
  const [paper, setPaper] = useState<Paper>('receipt');
  const print = (p: Paper) => { setPaper(p); setTimeout(() => window.print(), 50); };
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { nextRef.current?.focus(); }, []);
  return (
    <div className="ui-content">
      <style>{PRINT_CSS(paper)}</style>
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Paid · {sale.invoiceNumber}</h1>
          <div className="ui-caption">{money(sale.total)}{Number(sale.change) > 0 ? ` · change to give ${money(sale.change)}` : ''}</div></div>
        <div className="ui-actions">
          <button className="ui-btn" type="button" onClick={() => print('receipt')}>Print receipt</button>
          <button className="ui-btn" type="button" onClick={() => print('a4')}>Print A4</button>
          <button ref={nextRef} className="ui-btn ui-btn--primary" type="button" onClick={onNext}>Next customer</button>
        </div>
      </div>
      {Number(sale.change) > 0 && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body"><strong>Give change: {money(sale.change)}</strong></div></div>}
      <div style={{ overflowX: 'auto' }}><TaxDocumentView doc={sale.invoice} paper={paper} /></div>
    </div>
  );
}

function Summary({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<DaySummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<DaySummary>('/pos/summary').then((r) => setS(r.data)).catch((e) => setError(errorText(e))); }, []);
  return (
    <div className="ui-backdrop" role="presentation" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal aria-labelledby="sum-title" onClick={(e) => e.stopPropagation()}>
        <div className="ui-dialog-head"><h2 className="ui-h3" id="sum-title">Today’s takings{s ? ` · ${s.date}` : ''}</h2></div>
        <div className="ui-dialog-body">
          {error && <div className="ui-error">{error}</div>}
          {!s ? !error && <div className="ui-skeleton" style={{ height: 120 }} /> : (
            <>
              <p style={{ marginTop: 0 }}>{s.sales} counter sale{s.sales === 1 ? '' : 's'} · {money(s.salesTotal)}</p>
              <table className="ui-table">
                <thead><tr><th scope="col">Method</th><th scope="col" className="ui-money">In</th><th scope="col" className="ui-money">Refunded</th><th scope="col" className="ui-money">Net</th></tr></thead>
                <tbody>{s.methods.map((m) => (
                  <tr key={m.method}><td>{PAY_METHOD[m.method] ?? m.method}</td><td className="ui-money">{money(m.received)}</td><td className="ui-money">{money(m.refunded)}</td><td className="ui-money"><strong>{money(m.net)}</strong></td></tr>
                ))}</tbody>
              </table>
              <p className="ui-help">Net cash is what the drawer should hold above the opening float. Web order payments are not counted; cash refunds for web returns are.</p>
            </>
          )}
        </div>
        <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
