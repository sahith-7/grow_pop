'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attrLabel, money, qtyTotal } from '../../lib/format';
import { idemKey } from '../../lib/stock-api';
import {
  ApiError, api, errorText, PAY_METHOD, type CartInput, type Customer, type DaySummary, type LookupItem, type PosContext, type Quote, type ResumedBill, type SaleResult,
} from '../../lib/sales-api';
import { SubscriptionBanner } from '../(app)/_components/subscription-banner';
import { PaperPicker, PRINT_CSS, TaxDocumentView, type Paper } from '../(app)/invoices/_components/tax-document';
import { Suggestions, useSuggest } from '../../lib/suggest';
import { QtyStepper } from '../../lib/qty';
import { readOutletCookie } from '../../lib/outlet-scope';
import { ApprovalDialog } from './_components/approval';
import { ExchangeDialog, type ExchangeState } from './_components/exchange';
import { HeldList, HoldDialog } from './_components/held';
import { OpenRegister, RegisterDialog } from './_components/register';
import type { CounterMethod, MethodKind, Till } from '../../lib/cash-api';

// Counter sale (J11). The browser only collects what the cashier typed; the server prices the cart (quote) and the sale
// re-prices it and checks the total the cashier saw. Enter in the scan box adds an item and never takes payment.
// v2 phase 2: customer or Walk-in on every bill (D104), hold bill (D105), discounts in % or ₹ (D106), approval above the
// cashier's limit (D107), exchange against an old bill (D108).
// v2 phase 3: the till's register must be open to bill (D110), the store's own payment methods (D109), "give back" worked
// out as the cash is typed (with quick amounts), and the return rules on exchanges (D113).

type Mode = 'pct' | 'amt';
interface Line {
  variantId: string; sku: string; name: string; attributes: Record<string, string>; price: string; mrp: string | null; unitCode: string; allowFraction: boolean;
  qty: string; unitPriceOverride: string; disc: string; discMode: Mode;
}
interface Pay { methodId: string; method: MethodKind; amount: string; reference: string }
type RefundMethod = 'cash' | 'upi' | 'card' | 'other';

const paise = (v: string) => Math.round(Number(v || '0') * 100);
// The outlet this till is at (v2, D101), remembered on this device. Storage can be blocked; the till then asks again.
const OUTLET_KEY = 'gp-pos-outlet';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const savedOutlet = () => { try { return localStorage.getItem(OUTLET_KEY) ?? ''; } catch { return ''; } };
const saveOutlet = (id: string) => { try { localStorage.setItem(OUTLET_KEY, id); } catch { /* not remembered */ } };
const rupees = (p: number) => (p / 100).toFixed(2);
// The till this screen is, per outlet, remembered on this device (v2, D110).
const TILL_KEY = (outletId: string) => `gp-pos-till:${outletId}`;
const savedTill = (outletId: string) => { try { return localStorage.getItem(TILL_KEY(outletId)) ?? ''; } catch { return ''; } };
const saveTill = (outletId: string, id: string) => { try { localStorage.setItem(TILL_KEY(outletId), id); } catch { /* not remembered */ } };
/** The saved till if it is still there; else one this person opened; else one that is open; else the first. */
const pickTill = (tills: Till[], saved: string) =>
  tills.find((t) => t.id === saved) ?? tills.find((t) => t.open?.mine) ?? tills.find((t) => t.open) ?? tills[0] ?? null;

export default function PosPage() {
  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [billDisc, setBillDisc] = useState('');
  const [billMode, setBillMode] = useState<Mode>('pct');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<{ id: string; by: string | null } | null>(null);
  const [exchange, setExchange] = useState<ExchangeState | null>(null);
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('cash');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<{ code: string; message: string; fields: Record<string, string[]> } | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [paysTouched, setPaysTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SaleResult | null>(null);
  const [dialog, setDialog] = useState<'summary' | 'hold' | 'held' | 'approval' | 'exchange' | 'register' | null>(null);
  const [tillId, setTillId] = useState('');
  const [heldCount, setHeldCount] = useState(0);
  const [key, setKey] = useState(idemKey);
  const scanRef = useRef<HTMLInputElement>(null);

  const loadContext = (outletId: string): Promise<void> => api<PosContext>(`/pos/context${outletId ? `?outletId=${outletId}` : ''}`)
    .then((r) => { setCtx(r.data); saveOutlet(r.data.outlet.id); setTillId(pickTill(r.data.tills, savedTill(r.data.outlet.id))?.id ?? ''); })
    .catch((e): Promise<void> | void => {
      // A remembered outlet that was closed, or that this person no longer works at: fall back to their default.
      if (outletId && e instanceof ApiError && e.code === 'OUTLET_NOT_ALLOWED') { saveOutlet(''); return loadContext(''); }
      setError(errorText(e));
    });
  // A new counter device starts at the outlet the back office has in view (D115); after that it keeps its own outlet,
  // because a till is a place, and someone looking at another outlet's figures is not billing there.
  useEffect(() => { const v = readOutletCookie(); loadContext(savedOutlet() || (UUID.test(v) ? v : '')); }, []);
  const countHeld = () => { if (ctx) api<{ items: unknown[] }>(`/pos/held?outletId=${ctx.outlet.id}`).then((r) => setHeldCount(r.data.items.length)).catch(() => {}); };
  useEffect(countHeld, [ctx?.outlet.id]);
  const till = ctx?.tills.find((t) => t.id === tillId) ?? null;
  const chooseTill = (id: string) => { if (!ctx) return; setTillId(id); saveTill(ctx.outlet.id, id); };
  // The register can be opened or closed elsewhere (another cashier, the owner): read the tills again.
  const reloadTills = () => (ctx ? loadContext(ctx.outlet.id) : Promise.resolve());
  const cashMethod = ctx?.paymentMethods.find((m) => m.kind === 'cash') ?? null;
  const firstPay = (amount: string): Pay[] => {
    const m = cashMethod ?? ctx?.paymentMethods[0];
    return m ? [{ methodId: m.id, method: m.kind, amount, reference: '' }] : [];
  };

  const clearBill = () => {
    setLines([]); setCustomer(null); setWalkIn(false); setWalkInName(''); setBillDisc(''); setBillMode('pct'); setReason(''); setApproval(null);
    setExchange(null); setRefundMethod('cash'); setPays([]); setPaysTouched(false); setError('');
  };
  const switchOutlet = (id: string) => {
    if ((lines.length || exchange) && !window.confirm('Switch outlet? The bill on screen will be cleared, because stock and bill numbers belong to each outlet.')) return;
    clearBill(); setCtx(null);
    loadContext(id);
  };

  // What the server prices. Any change makes a new sale attempt, so it also gets a new idempotency key.
  const cart = useMemo<CartInput>(() => ({
    ...(ctx ? { outletId: ctx.outlet.id } : {}),
    customerId: customer?.id ?? null,
    ...(walkIn && !customer ? { walkIn: true, ...(walkInName.trim() ? { walkInName: walkInName.trim() } : {}) } : {}),
    lines: lines.map((l) => ({
      variantId: l.variantId, qty: l.qty || '0',
      ...(l.unitPriceOverride ? { unitPriceOverride: l.unitPriceOverride } : {}),
      ...(l.disc ? (l.discMode === 'pct' ? { discountPct: l.disc } : { discountAmount: l.disc }) : {}),
    })),
    ...(billDisc ? (billMode === 'pct' ? { cartDiscountPct: billDisc } : { cartDiscountAmount: billDisc }) : {}),
    ...(reason.trim() ? { cartDiscountReason: reason.trim() } : {}),
    ...(approval ? { approvalId: approval.id } : {}),
  }), [lines, customer, walkIn, walkInName, billDisc, billMode, reason, approval, ctx?.outlet.id]);
  const cartJson = JSON.stringify(cart);

  const requote = () => api<Quote>('/pos/quote', { method: 'POST', body: cart })
    .then((r) => { setQuote(r.data); setQuoteError(null); })
    .catch((e) => {
      // "Check the highlighted fields" alone does not say what to fix at a busy counter: show the field messages too.
      const fields = e instanceof ApiError ? e.fieldErrors : {};
      const detail = [...new Set(Object.values(fields).flat())].join(' · ');
      setQuote(null);
      setQuoteError({ code: e instanceof ApiError ? e.code : 'ERROR', message: e instanceof ApiError && e.code === 'VALIDATION_ERROR' && detail ? detail : errorText(e), fields });
    });
  useEffect(() => {
    setKey(idemKey());
    if (!lines.length) { setQuote(null); setQuoteError(null); return; }
    const t = setTimeout(requote, 250);
    return () => clearTimeout(t);
  }, [cartJson]);

  // The old bill's credit pays first (exchange); the rest is taken, or given back.
  const totalP = quote ? paise(quote.total) : 0;
  const creditP = exchange ? paise(exchange.credit) : 0;
  const dueP = Math.max(0, totalP - creditP);
  const backP = quote ? Math.max(0, creditP - totalP) : 0;

  // Until the cashier edits payments, what is due is paid in one cash amount.
  useEffect(() => { if (quote && !paysTouched) setPays(dueP > 0 ? firstPay(rupees(dueP)) : []); }, [quote?.total, dueP, paysTouched, ctx?.paymentMethods]);

  const add = (item: LookupItem) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.variantId === item.variantId);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: String(Number(l.qty || '0') + 1) } : l));
      return [...ls, { variantId: item.variantId, sku: item.sku, name: item.name, attributes: item.attributes, price: item.price, mrp: item.mrp, unitCode: item.unitCode, allowFraction: item.allowFraction, qty: '1', unitPriceOverride: '', disc: '', discMode: 'pct' }];
    });
    scanRef.current?.focus();
  };
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const reset = () => { clearBill(); setDone(null); setNotice(''); setTimeout(() => scanRef.current?.focus(), 0); };

  const resume = (b: ResumedBill) => {
    const info = new Map(b.items.map((x) => [x.variantId, x]));
    setLines(b.cart.lines.filter((l) => info.has(l.variantId)).map((l) => {
      const x = info.get(l.variantId)!;
      return { variantId: x.variantId, sku: x.sku, name: x.name, attributes: x.attributes, price: x.price, mrp: x.mrp, unitCode: x.unitCode, allowFraction: x.allowFraction,
        qty: l.qty, unitPriceOverride: l.unitPriceOverride ?? '', disc: l.discountAmount ?? l.discountPct ?? '', discMode: l.discountAmount ? 'amt' : 'pct' };
    }));
    setCustomer(b.cart.customerId ? { id: b.cart.customerId, name: b.customer ?? '', phone: null, email: null, gstin: null, stateCode: null, stateName: null, address: null, fromWooCommerce: false } : null);
    setWalkIn(!!b.cart.walkIn); setWalkInName(b.cart.walkInName ?? '');
    setBillDisc(b.cart.cartDiscountAmount ?? b.cart.cartDiscountPct ?? ''); setBillMode(b.cart.cartDiscountAmount ? 'amt' : 'pct');
    setReason(b.cart.cartDiscountReason ?? ''); setApproval(null); setDialog(null);
    setNotice(`Picked up ${b.label ? `“${b.label}”` : 'a held bill'}. Prices were checked again.`);
    countHeld();
  };

  const nonCashP = pays.filter((p) => p.method !== 'cash').reduce((a, p) => a + paise(p.amount), 0);
  const paidP = pays.reduce((a, p) => a + paise(p.amount), 0);
  const changeP = paidP - dueP;
  const payProblem = !quote ? '' : dueP === 0 && paidP > 0 ? 'Nothing is left to pay: remove the payment.'
    : nonCashP > dueP ? 'Card, UPI and other cannot be more than what is due; only cash gives change.' : paidP < dueP ? `${money(rupees(dueP - paidP))} still to pay` : '';
  const discountsOn = Number(billDisc) > 0 || lines.some((l) => Number(l.disc) > 0);
  const needReason = !!ctx && !approval && ((billMode === 'pct' && Number(billDisc) > Number(ctx.discount.reasonAbovePct)) || lines.some((l) => l.discMode === 'pct' && Number(l.disc) > Number(ctx.discount.reasonAbovePct))
    || Object.keys(quoteError?.fields ?? {}).some((k) => k.endsWith('discountReason')));
  const customerMissing = !!ctx?.requireCustomer && !customer && !walkIn;
  // Exchange only (D113): with no money back, the new items must use up the old bill's credit (the owner isn't held to it).
  const exchangeOnly = !!exchange && backP > 0 && !!ctx && !ctx.returnRules.moneyBack && ctx.returnRules.bindsMe;

  const charge = async () => {
    if (!quote || payProblem || customerMissing || exchangeOnly) return;
    setBusy(true); setError('');
    const payments = pays.filter((p) => paise(p.amount) > 0).map((p) => ({ method: p.method, methodId: p.methodId, amount: p.amount, ...(p.reference.trim() ? { reference: p.reference.trim() } : {}) }));
    const at = till ? { tillId: till.id } : {};
    try {
      const { data } = exchange
        ? await api<SaleResult>('/pos/exchanges', {
          method: 'POST', headers: key,
          body: { ...cart, ...at, expectedTotal: quote.total, payments, exchange: { invoiceId: exchange.invoiceId, reason: exchange.reason, lines: exchange.lines, expectedCredit: exchange.credit },
            ...(backP > 0 ? { refundMethod } : {}) },
        })
        : await api<SaleResult>('/pos/sales', { method: 'POST', headers: key, body: { ...cart, ...at, expectedTotal: quote.total, payments } });
      setDone(data);
    } catch (e) {
      setError(errorText(e));
      // Prices or stock changed under us: re-quote with a fresh key so the cashier sees the new total before paying.
      if (e instanceof ApiError && e.status === 409) { setKey(idemKey()); requote(); }
      if (e instanceof ApiError && (e.code === 'REGISTER_CLOSED' || e.code === 'METHOD_OFF')) reloadTills();
    } finally { setBusy(false); }
  };

  if (!ctx) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 320 }} />}</div>;

  const header = (
    <div className="ui-page-header" style={{ marginBottom: 0 }}>
      <div><h1 className="ui-h1">Counter</h1><div className="ui-caption">{ctx.seller.name}{ctx.outlets.length > 1 ? ` · ${ctx.outlet.name}` : ''}{till ? ` · ${till.name}` : ''}{ctx.location ? ` · selling from ${ctx.location.name}` : ''}{ctx.pricesIncludeTax ? ' · prices include GST' : ' · GST added to prices'}</div></div>
      <div className="ui-actions">
        {ctx.outlets.length > 1 && (
          <label className="ui-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}><span className="ui-label">Outlet</span>
            <select className="ui-select" style={{ width: 'auto' }} value={ctx.outlet.id} onChange={(e) => switchOutlet(e.target.value)}>
              {ctx.outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        )}
        {ctx.tills.length > 1 && (
          <label className="ui-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}><span className="ui-label">Till</span>
            <select className="ui-select" style={{ width: 'auto' }} value={tillId} onChange={(e) => chooseTill(e.target.value)} disabled={lines.length > 0 || !!exchange}
              title={lines.length || exchange ? 'Finish or clear the bill first' : undefined}>
              {ctx.tills.map((t) => <option key={t.id} value={t.id}>{t.name}{t.open ? '' : ' (closed)'}</option>)}</select></label>
        )}
        {ctx.ready && till?.open && <button className="ui-btn" type="button" onClick={() => setDialog('register')}>Register</button>}
        {ctx.ready && <button className="ui-btn" type="button" onClick={() => setDialog('held')}>Held bills{heldCount ? <span className="ui-badge gp-count">{heldCount}</span> : null}</button>}
        {ctx.ready && ctx.canExchange && <button className="ui-btn" type="button" disabled={!!exchange} onClick={() => setDialog('exchange')}>Exchange</button>}
        <button className="ui-btn" type="button" onClick={() => setDialog('summary')}>Today’s takings</button>
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
          <div style={{ marginTop: 'var(--space-2)' }}>An owner fixes this in <Link href="/billing">Billing &amp; GST</Link> and <Link href="/settings">Settings</Link>{ctx.outlets.length > 1 && <>, or on <Link href={`/account/outlets/${ctx.outlet.id}`}>{ctx.outlet.name}’s outlet page</Link> (its GSTIN and address)</>}.</div>
        </div></div>
      </div>
    );
  }

  if (done) return <SaleDone sale={done} format={ctx?.billFormat ?? '80mm'} onNext={() => { reset(); reloadTills(); }} />;

  // The register must be open before the first bill (D110): count the drawer.
  if (ctx.requireRegister && !till?.open) {
    return (
      <div className="ui-content">{header}
        <SubscriptionBanner />
        {ctx.tills.length === 0 ? <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">This outlet has no till switched on. An owner or manager adds one in Cash control.</div></div>
          : <OpenRegister till={till} tills={ctx.tills} onPickTill={chooseTill} onOpened={reloadTills} />}
      </div>
    );
  }

  const lineErr = (i: number, k: string) => quoteError?.fields[`lines.${i}.${k}`]?.[0];
  const overLimit = quoteError?.code === 'DISCOUNT_LIMIT';
  const takeLabel = !quote ? '' : dueP > 0 ? `Take ${money(rupees(dueP))}` : backP > 0 ? `Give back ${money(rupees(backP))} and finish` : 'Finish exchange';
  return (
    <div className="ui-content" style={{ maxWidth: 'none' }}>
      {header}
      <SubscriptionBanner />
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {notice && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body" style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}><span>{notice}</span><button className="ui-btn ui-btn--sm" type="button" onClick={() => setNotice('')}>OK</button></div></div>}

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 380px)', alignItems: 'start' }} className="pos-grid">
        <div style={{ display: 'grid', gap: 'var(--space-4)', minWidth: 0 }}>
          <Scanner inputRef={scanRef} onAdd={add} outletId={ctx.outlet.id} />

          {exchange && (
            <div className="ui-panel gp-exchange"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span className="ui-h3">Exchange: coming back from {exchange.invoiceNumber}</span>
                <button className="ui-btn ui-btn--sm" type="button" onClick={() => { setExchange(null); setPaysTouched(false); }}>Remove</button>
              </div>
              {exchange.items.map((x, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}><span>{x.qty} × {x.description}</span><span className="ui-money">{money(x.credit)}</span></div>)}
              {(() => {
                const diff = creditP - exchange.items.reduce((a, x) => a + paise(x.credit), 0);
                return diff !== 0 ? <div className="ui-muted" style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}><span>Round off</span><span className="ui-money">{diff > 0 ? '+' : '−'}{money(rupees(Math.abs(diff)))}</span></div> : null;
              })()}
              <div className="ui-caption">Credit {money(exchange.credit)} · {exchange.reason} · credit note from {exchange.creditNoteFrom}. Now add what the customer takes instead.</div>
            </div></div>
          )}

          <div className="ui-panel">
            {lines.length === 0 ? <div className="ui-empty"><p className="ui-h3">{exchange ? 'Scan what the customer takes instead' : 'Scan or search to start a bill'}</p></div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th>{ctx.discount.allowed && <th scope="col">Discount</th>}<th scope="col" className="ui-money">Total</th><th scope="col" aria-label="Remove" /></tr></thead>
                <tbody>{lines.map((l, i) => {
                  const q = quote?.lines[i];
                  const discErr = lineErr(i, 'discountPct') ?? lineErr(i, 'discountAmount');
                  return (
                    <tr key={l.variantId}>
                      <td data-primary><div className="ui-cell-title">{l.name}{Object.keys(l.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(l.attributes)}</span>}</div>
                        <div className="ui-cell-sub"><span className="ui-code">{l.sku}</span>{q && <> · GST {q.gstRate}%{Number(q.available) < Number(l.qty) && <span style={{ color: 'var(--danger)' }}> · only {q.available} in stock</span>}</>}</div>
                        {lineErr(i, 'variantId') && <div className="ui-error">{lineErr(i, 'variantId')}</div>}</td>
                      <td data-label="Qty">
                        <QtyStepper value={l.qty} onChange={(v) => setLine(i, { qty: v })} label={`Quantity of ${l.name}`} min={l.allowFraction ? 0.001 : 1}
                          decimals={l.allowFraction} width={56} invalid={!!lineErr(i, 'qty')} />
                        {lineErr(i, 'qty') && <div className="ui-error">{lineErr(i, 'qty')}</div>}</td>
                      <td data-label="Price">
                        {ctx.canOverridePrice
                          ? <input className="ui-input ui-input--num" style={{ width: 100 }} inputMode="decimal" placeholder={l.price} value={l.unitPriceOverride} aria-label={`Price of ${l.name}`}
                              onChange={(e) => setLine(i, { unitPriceOverride: e.target.value })} aria-invalid={!!lineErr(i, 'unitPriceOverride')} />
                          : money(l.price)}
                        {l.mrp && <div className="ui-cell-sub">MRP {money(l.mrp)}</div>}
                        {lineErr(i, 'unitPriceOverride') && <div className="ui-error">{lineErr(i, 'unitPriceOverride')}</div>}</td>
                      {ctx.discount.allowed && (
                        <td data-label="Discount">
                          <DiscountInput value={l.disc} mode={l.discMode} label={`Discount on ${l.name}`} invalid={!!discErr}
                            onChange={(v) => setLine(i, { disc: v })} onMode={(m) => setLine(i, { discMode: m })} />
                          {discErr && <div className="ui-error">{discErr}</div>}</td>
                      )}
                      <td className="ui-money" data-label="Total">{q ? money(q.lineTotal) : '…'}{q && Number(q.discount) > 0 && <div className="ui-cell-sub">−{money(q.discount)} ({q.discountPct}%)</div>}</td>
                      <td><button className="ui-btn ui-btn--sm" type="button" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>

          {ctx.discount.allowed && lines.length > 0 && (
            <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="ui-field" style={{ width: 170 }}><span className="ui-label">Bill discount</span>
                <DiscountInput value={billDisc} mode={billMode} label="Bill discount" onChange={setBillDisc} onMode={setBillMode} invalid={!!(quoteError?.fields.cartDiscountAmount)} /></label>
              {(needReason || (discountsOn && reason)) && (
                <label className="ui-field" style={{ flex: 1, minWidth: 220 }}><span className="ui-label">Reason for the discount</span>
                  <input className="ui-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged box, regular customer" aria-invalid={needReason && !reason.trim()} /></label>
              )}
              {approval && <span className="ui-badge ui-badge--success" role="status">Approved by {approval.by ?? 'manager'}</span>}
              <span className="ui-help" style={{ flexBasis: '100%' }}>
                Your limit: {ctx.discount.limitPct}% in total per item. Above {ctx.discount.reasonAbovePct}% needs a reason; above your limit, ask an owner or manager.
                {billMode === 'amt' && ' A ₹ bill discount is shared over the items by their value.'}{!ctx.pricesIncludeTax && ' ₹ discounts come off the price before GST.'}
              </span>
            </div></div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <CustomerBox customer={customer} onChange={(c) => { setCustomer(c); if (c) setWalkIn(false); }} states={ctx.states} required={ctx.requireCustomer}
            walkIn={walkIn} walkInName={walkInName} onWalkIn={(on) => { setWalkIn(on); if (on) setCustomer(null); }} onWalkInName={setWalkInName}
            error={quoteError?.fields.customerId?.[0]} />

          {(quote || quoteError) && <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {quoteError && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{quoteError.message}
              {overLimit && <div style={{ marginTop: 'var(--space-2)' }}><button className="ui-btn ui-btn--sm ui-btn--primary" type="button" onClick={() => { setApproval(null); setDialog('approval'); }}>Ask for approval</button></div>}
            </div></div>}
            {quote && (
              <>
                <Row label="Total quantity" value={qtyTotal(lines.map((l) => ({ qty: l.qty, unit: l.unitCode })))} />
                <Row label="Items" value={money(quote.subtotal)} />
                {Number(quote.discountTotal) > 0 && <Row label="Discount" value={`−${money(quote.discountTotal)}`} />}
                {Number(quote.taxBreakdown.igst) > 0
                  ? <Row label="IGST" value={money(quote.taxBreakdown.igst)} muted />
                  : Number(quote.taxBreakdown.cgst) > 0 && <><Row label="CGST" value={money(quote.taxBreakdown.cgst)} muted /><Row label="SGST" value={money(quote.taxBreakdown.sgst)} muted /></>}
                {Number(quote.roundOff) !== 0 && <Row label="Round off" value={money(quote.roundOff)} muted />}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-2)' }}>
                  <span className="ui-h3">{exchange ? 'New bill' : 'Total'}</span><span className="ui-money" style={{ fontSize: exchange ? '1.25rem' : '1.75rem', fontWeight: 600 }}>{money(quote.total)}</span>
                </div>
                {exchange && <>
                  <Row label={`Old bill credit (${exchange.invoiceNumber})`} value={`−${money(rupees(Math.min(creditP, totalP)))}`} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-2)' }}>
                    <span className="ui-h3">{backP > 0 ? 'Give back' : 'To pay'}</span><span className="ui-money" style={{ fontSize: '1.75rem', fontWeight: 600 }}>{money(rupees(backP > 0 ? backP : dueP))}</span>
                  </div>
                </>}
                <div className="ui-caption">{quote.docTitle}{quote.pricesIncludeTax ? ' · tax included in prices' : ''}</div>
                {quote.shortages.length > 0 && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">
                  Not enough free stock: {quote.shortages.map((x) => `${x.sku} (${x.available} free)`).join(', ')}. Stock held for web orders does not count.
                  The sale is refused until a manager corrects the stock (Stock → Adjust) or you lower the quantity.</div></div>}
              </>
            )}
          </div></div>}

          {quote && dueP > 0 && <Payments total={rupees(dueP)} pays={pays} methods={ctx.paymentMethods} onChange={(p) => { setPays(p); setPaysTouched(true); }} />}
          {quote && backP > 0 && (
            <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <span className="ui-label">Give {money(rupees(backP))} back by</span>
              <div className="ui-segmented" role="group" aria-label="Give back by">
                {(['cash', 'upi', 'card', 'other'] as const).map((m) => <button key={m} type="button" aria-pressed={refundMethod === m} onClick={() => setRefundMethod(m)}>{PAY_METHOD[m]}</button>)}
              </div>
              {exchangeOnly && <div className="ui-caption" style={{ color: 'var(--danger)' }}>This store gives exchanges, not money back: add items worth {money(rupees(backP))} more, or ask the owner.</div>}
            </div></div>
          )}

          {quote && (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              {customerMissing && <div className="ui-caption" style={{ color: 'var(--danger)' }}>Add the customer’s name and mobile number, or choose Walk-in.</div>}
              {payProblem ? <div className="ui-caption" style={{ color: 'var(--danger)' }}>{payProblem}</div>
                : changeP > 0 && <div className="gp-giveback" role="status" aria-live="polite"><span>Give back</span><strong className="ui-money">{money(rupees(changeP))}</strong></div>}
              <button className="ui-btn ui-btn--primary" type="button" style={{ height: 56, fontSize: '1.1rem' }}
                disabled={busy || !!payProblem || !!quoteError || customerMissing || exchangeOnly || quote.shortages.length > 0 || (needReason && !reason.trim())} aria-busy={busy} onClick={charge}>
                {takeLabel}
              </button>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
                <button className="ui-btn" type="button" disabled={busy || !!exchange} title={exchange ? 'Finish or remove the exchange first' : undefined} onClick={() => setDialog('hold')}>Hold bill</button>
                <button className="ui-btn" type="button" disabled={busy} onClick={reset}>Clear bill</button>
              </div>
            </div>
          )}
          {!quote && quoteError && lines.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
              <button className="ui-btn" type="button" disabled={busy || !!exchange} onClick={() => setDialog('hold')}>Hold bill</button>
              <button className="ui-btn" type="button" disabled={busy} onClick={reset}>Clear bill</button>
            </div>
          )}
        </div>
      </div>

      {dialog === 'summary' && <Summary outletId={ctx.outlet.id} onClose={() => setDialog(null)} />}
      {dialog === 'register' && till?.open && <RegisterDialog sessionId={till.open.id} canManage={ctx.canManageCash} expenseLimits={ctx.expenseLimits}
        onClosed={() => {}} onClose={() => { setDialog(null); reloadTills(); }} />}
      {dialog === 'hold' && <HoldDialog cart={cart} onClose={() => setDialog(null)} onHeld={() => { setDialog(null); reset(); setNotice('Bill held. Pick it up from Held bills.'); countHeld(); }} />}
      {dialog === 'held' && <HeldList outletId={ctx.outlet.id} busyCart={lines.length > 0 || !!exchange} onResume={resume} onClose={() => setDialog(null)} onCount={setHeldCount} />}
      {dialog === 'approval' && <ApprovalDialog cart={cart} reason={reason}
        onApproved={(id, by, why) => { setApproval({ id, by }); if (!reason.trim()) setReason(why); setDialog(null); }} onClose={() => setDialog(null)} />}
      {dialog === 'exchange' && <ExchangeDialog outletId={ctx.outlet.id} onClose={() => setDialog(null)}
        onDone={(x) => {
          setExchange(x); setPaysTouched(false); setDialog(null);
          if (x.customer && !customer) { setCustomer({ ...x.customer, email: null, gstin: null, stateCode: null, stateName: null, address: null, fromWooCommerce: false }); setWalkIn(false); }
          setTimeout(() => scanRef.current?.focus(), 0);
        }} />}
      <style>{`@media (max-width: 900px) { .pos-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }} className={muted ? 'ui-muted' : undefined}><span>{label}</span><span className="ui-money">{value}</span></div>;
}

/** A discount box with a % / ₹ switch beside it (v2, D106). */
function DiscountInput({ value, mode, onChange, onMode, label, invalid }: { value: string; mode: Mode; onChange: (v: string) => void; onMode: (m: Mode) => void; label: string; invalid?: boolean }) {
  return (
    <span className="gp-disc">
      <input className="ui-input ui-input--num" inputMode="decimal" placeholder="0" value={value} aria-label={`${label} in ${mode === 'pct' ? 'percent' : 'rupees'}`}
        aria-invalid={invalid} onChange={(e) => onChange(e.target.value)} />
      <span className="gp-disc-mode" role="group" aria-label={`${label}: percent or rupees`}>
        <button type="button" aria-pressed={mode === 'pct'} onClick={() => onMode('pct')}>%</button>
        <button type="button" aria-pressed={mode === 'amt'} onClick={() => onMode('amt')}>₹</button>
      </span>
    </span>
  );
}

/** Scan box: a barcode scanner types the code and presses Enter. An exact barcode or SKU adds at once; anything else lists matches. */
function Scanner({ inputRef, onAdd, outletId }: { inputRef: React.RefObject<HTMLInputElement | null>; onAdd: (i: LookupItem) => void; outletId: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<LookupItem[] | null>(null);
  const [msg, setMsg] = useState('');
  const sg = useSuggest<LookupItem>({ q, delay: 250, load: (t) => api<{ items: LookupItem[] }>(`/pos/lookup?q=${encodeURIComponent(t)}&outletId=${outletId}`).then((r) => r.data.items.slice(0, 8)) });
  const pickHit = (h: LookupItem) => { sg.quiet(''); setQ(''); setHits(null); setMsg(''); onAdd(h); };

  // A scanner can send the next code before the last lookup answers. Clear the box at once and run lookups one at a time,
  // in scan order, so no scan is lost or added out of order.
  const chain = useRef(Promise.resolve());
  const look = (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    sg.close(); setQ(''); setMsg('');
    chain.current = chain.current.then(async () => {
      try {
        const { data } = await api<{ items: LookupItem[] }>(`/pos/lookup?q=${encodeURIComponent(text)}&outletId=${outletId}`);
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
        <div className="gp-suggest">
          <input ref={inputRef} className="ui-input ui-search" autoFocus placeholder="Scan a barcode, or type a SKU or name" aria-label="Scan or search items" value={q} onChange={(e) => setQ(e.target.value)}
            {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, pickHit)} />
          <Suggestions s={sg} onPick={pickHit} label="Matching items" render={(h) => (<>
            <span className="gp-suggest-title">{h.name}{Object.keys(h.attributes).length > 0 && <span className="ui-muted"> · {attrLabel(h.attributes)}</span>}</span>
            <span className="gp-suggest-end">{money(h.price)}</span>
            <span className="gp-suggest-sub"><span className="ui-code">{h.sku}</span> · {h.available} in stock</span>
          </>)} />
        </div>
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

function CustomerBox({ customer, onChange, states, required, walkIn, walkInName, onWalkIn, onWalkInName, error }: {
  customer: Customer | null; onChange: (c: Customer | null) => void; states: { code: string; name: string }[]; required: boolean;
  walkIn: boolean; walkInName: string; onWalkIn: (on: boolean) => void; onWalkInName: (v: string) => void; error?: string;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Customer[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');
  const sg = useSuggest<Customer>({ q, enabled: !customer && !walkIn, load: (t) => api<{ items: Customer[] }>(`/customers?limit=8&q=${encodeURIComponent(t)}`).then((r) => r.data.items) });
  const pickHit = (c: Customer) => { sg.quiet(''); onChange(c); setHits(null); setQ(''); setMsg(''); };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    try { const { data } = await api<{ items: Customer[] }>(`/customers?limit=8&q=${encodeURIComponent(q.trim())}`); setHits(data.items); setMsg(data.items.length ? '' : 'No customer found. Add them with New, or choose Walk-in.'); }
    catch (err) { setMsg(errorText(err)); }
  };

  if (customer) {
    return (
      <div className="ui-panel"><div className="ui-panel-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <div><div className="ui-cell-title">{customer.name}</div>
            <div className="ui-cell-sub">{[customer.phone, customer.gstin ? `GSTIN ${customer.gstin}` : null, customer.stateName].filter(Boolean).join(' · ')}</div></div>
          <button className="ui-btn ui-btn--sm" type="button" onClick={() => onChange(null)}>Change</button>
        </div>
        {customer.gstin && <div className="ui-help">Business sale (B2B): the invoice shows their GSTIN.</div>}
        {error && <div className="ui-error">{error}</div>}
      </div></div>
    );
  }

  if (walkIn) {
    return (
      <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'baseline' }}>
          <div><div className="ui-cell-title">Walk-in customer</div><div className="ui-cell-sub">No mobile number on this bill</div></div>
          <button className="ui-btn ui-btn--sm" type="button" onClick={() => onWalkIn(false)}>Change</button>
        </div>
        <label className="ui-field"><span className="ui-label">Name on the bill (optional)</span>
          <input className="ui-input" maxLength={100} value={walkInName} onChange={(e) => onWalkInName(e.target.value)} placeholder="If the customer gave one" /></label>
        {error && <div className="ui-error">{error}</div>}
      </div></div>
    );
  }

  return (
    <div className="ui-panel">
      <form className="ui-toolbar" onSubmit={search}>
        <div className="gp-suggest">
          <input className="ui-input ui-search" placeholder={required ? 'Customer mobile or name' : 'Customer phone, name or GSTIN (optional)'} aria-label="Find a customer" value={q} onChange={(e) => setQ(e.target.value)}
            {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, pickHit)} />
          <Suggestions s={sg} onPick={pickHit} label="Matching customers" render={(c) => (<>
            <span className="gp-suggest-title">{c.name || 'No name'}</span>
            <span className="gp-suggest-sub">{[c.phone, c.gstin].filter(Boolean).join(' · ') || ' '}</span>
          </>)} />
        </div>
        <button className="ui-btn ui-btn--sm" type="button" onClick={() => setCreating(true)}>New</button>
        <button className="ui-btn ui-btn--sm" type="button" onClick={() => onWalkIn(true)} title="The customer won’t give a mobile number">Walk-in</button>
      </form>
      {required && !msg && !error && <div className="ui-panel-body ui-help" style={{ paddingTop: 0 }}>Every bill needs the customer’s name and mobile number. If they won’t give one, choose Walk-in.</div>}
      <div className="ui-panel-body ui-help gp-privacy" style={{ paddingTop: 0 }}>{PRIVACY_LINE}</div>
      {error && <div className="ui-panel-body ui-error">{error}</div>}
      {msg && <div className="ui-panel-body ui-muted">{msg}</div>}
      {hits?.map((c) => (
        <button key={c.id} type="button" className="ui-list-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => { onChange(c); setHits(null); setQ(''); }}>
          <span><span className="ui-cell-title">{c.name || 'No name'}</span><span className="ui-cell-sub"> {[c.phone, c.gstin].filter(Boolean).join(' · ')}</span></span>
        </button>
      ))}
      {creating && <NewCustomer initial={q} states={states} needPhone={required} onClose={() => setCreating(false)} onCreated={(c) => { onChange(c); setCreating(false); setQ(''); setHits(null); }} />}
    </div>
  );
}

/** Why the number is taken (DPDP Act 2023: say what personal data is for when it is collected). */
const PRIVACY_LINE = 'The mobile number is for the bill, returns and warranty. It isn’t used for offers or messages without the customer’s consent.';

function NewCustomer({ initial, states, needPhone, onClose, onCreated }: { initial: string; states: { code: string; name: string }[]; needPhone: boolean; onClose: () => void; onCreated: (c: Customer) => void }) {
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
          {field('name', 'Name', { autoFocus: !f.name, maxLength: 200 })}
          {field('phone', needPhone ? 'Mobile number' : 'Phone', { inputMode: 'tel', maxLength: 16, placeholder: '10-digit mobile', autoFocus: !!f.name && !f.phone })}
          {field('gstin', 'GSTIN (business customers)', { style: { textTransform: 'uppercase' } })}
          {!f.gstin.trim() && (
            <label className="ui-field"><span className="ui-label">State</span>
              <select className="ui-select" value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}>
                <option value="">—</option>{states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          )}
          {field('address', 'Address')}
          <span className="ui-help">Only what the bill needs. A bill of ₹50,000 or more to a customer without a GSTIN needs their name, address and state.</span>
          <span className="ui-help gp-privacy">{PRIVACY_LINE} Tell the customer this if they ask why.</span>
        </div>
        <div className="ui-dialog-foot">
          <button className="ui-btn" type="button" onClick={onClose}>Cancel</button>
          <button className="ui-btn ui-btn--primary" type="button" disabled={busy || !f.name.trim() || (needPhone && !f.phone.trim())} aria-busy={busy} onClick={save}>Add customer</button>
        </div>
      </div>
    </div>
  );
}

/** Amounts a customer is likely to hand over for this much cash: the next ₹10, ₹50, ₹100, ₹500 and a ₹2,000 note. */
// What a customer is likely to hand over: the next ₹10, ₹50, ₹100, ₹500 and ₹1,000 above the bill (₹500 notes are the
// largest in everyday use, so ₹1,000 means two of them).
function cashOffers(dueP: number) {
  const up = (step: number) => Math.ceil(dueP / step) * step;
  return [...new Set([up(1000), up(5000), up(10000), up(50000), up(100000)])].filter((p) => p > dueP).slice(0, 4);
}

function Payments({ total, pays, methods, onChange }: { total: string; pays: Pay[]; methods: CounterMethod[]; onChange: (p: Pay[]) => void }) {
  const set = (i: number, patch: Partial<Pay>) => onChange(pays.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const left = paise(total) - pays.reduce((a, p) => a + paise(p.amount), 0);
  const pay = (m: CounterMethod, amount: string): Pay => ({ methodId: m.id, method: m.kind, amount, reference: '' });
  // What cash has to cover: the total less the other payments.
  const cashI = pays.findIndex((p) => p.method === 'cash');
  const cashDueP = paise(total) - pays.filter((p) => p.method !== 'cash').reduce((a, p) => a + paise(p.amount), 0);
  const other = methods.find((m) => m.kind !== 'cash' && !pays.some((p) => p.methodId === m.id)) ?? methods.find((m) => m.kind !== 'cash') ?? methods[0];
  if (!methods.length) return <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">No payment method is switched on at this outlet. An owner or manager turns them on in Cash control.</div></div>;
  return (
    <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div className="ui-segmented gp-pay-all" role="group" aria-label="Pay all by">
        {methods.slice(0, 5).map((m) => (
          <button key={m.id} type="button" aria-pressed={pays.length === 1 && pays[0].methodId === m.id} onClick={() => onChange([pay(m, total)])}>{m.name}</button>
        ))}
      </div>
      {pays.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <select className="ui-select" style={{ width: 130 }} value={p.methodId} aria-label="Payment method"
            onChange={(e) => { const m = methods.find((x) => x.id === e.target.value)!; set(i, { methodId: m.id, method: m.kind }); }}>
            {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <input className="ui-input ui-input--num" inputMode="decimal" value={p.amount} aria-label={p.method === 'cash' ? 'Cash received' : 'Amount'} onChange={(e) => set(i, { amount: e.target.value })}
            onFocus={(e) => e.target.select()} />
          {p.method !== 'cash' && <input className="ui-input" placeholder="Ref / last 4" aria-label="Reference" value={p.reference} maxLength={100} onChange={(e) => set(i, { reference: e.target.value })} />}
          {pays.length > 1 && <button className="ui-btn ui-btn--sm" type="button" aria-label="Remove payment" onClick={() => onChange(pays.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {cashI >= 0 && cashDueP > 0 && (
        <div className="gp-cash-offers" role="group" aria-label="Cash handed over">
          <span className="ui-caption">Customer gave</span>
          <button className="ui-btn ui-btn--sm" type="button" aria-pressed={paise(pays[cashI].amount) === cashDueP} onClick={() => set(cashI, { amount: rupees(cashDueP) })}>Exact</button>
          {cashOffers(cashDueP).map((o) => (
            <button key={o} className="ui-btn ui-btn--sm" type="button" aria-pressed={paise(pays[cashI].amount) === o} onClick={() => set(cashI, { amount: rupees(o) })}>₹{(o / 100).toLocaleString('en-IN')}</button>
          ))}
        </div>
      )}
      {pays.length < 6 && other && <button className="ui-btn ui-btn--sm" type="button" style={{ justifySelf: 'start' }}
        onClick={() => onChange([...pays, pay(other, left > 0 ? rupees(left) : '')])}>Split payment</button>}
      <span className="ui-help">For cash, type or tap what the customer handed over; what to give back shows at once.</span>
    </div></div>
  );
}

function SaleDone({ sale, format, onNext }: { sale: SaleResult; format: Paper; onNext: () => void }) {
  const [paper, setPaper] = useState<Paper>(format);
  const print = (p: Paper) => { setPaper(p); setTimeout(() => window.print(), 50); };
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { nextRef.current?.focus(); }, []);
  const x = sale.exchange;
  return (
    <div className="ui-content">
      <style>{PRINT_CSS(paper)}</style>
      <div className="ui-page-header">
        <div><h1 className="ui-h1">{x ? 'Exchanged' : 'Paid'} · {sale.invoiceNumber}</h1>
          <div className="ui-caption">{money(sale.total)}{x ? ` · ${money(x.used)} from ${x.oldInvoice} (credit note ${x.creditNoteNumber})` : ''}{Number(sale.change) > 0 ? ` · change to give ${money(sale.change)}` : ''}</div></div>
        <div className="ui-actions">
          {x && <Link className="ui-btn" href={`/invoices/${x.creditNoteId}`} target="_blank">Credit note</Link>}
          <button className="ui-btn" type="button" onClick={() => print(paper)}>Print bill</button>
          <button ref={nextRef} className="ui-btn ui-btn--primary" type="button" onClick={onNext}>Next customer</button>
        </div>
      </div>
      {Number(sale.change) > 0 && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body"><strong>Give change: {money(sale.change)}</strong></div></div>}
      {x?.givenBack && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body"><strong>Give back {money(x.givenBack.amount)} by {PAY_METHOD[x.givenBack.method] ?? x.givenBack.method}</strong>: the old bill’s credit was {money(x.credit)} and the new bill used {money(x.used)}.</div></div>}
      <PaperPicker paper={paper} onChange={setPaper} />
      <div style={{ overflowX: 'auto' }}><TaxDocumentView doc={sale.invoice} paper={paper} /></div>
    </div>
  );
}

function Summary({ onClose, outletId }: { onClose: () => void; outletId: string }) {
  const [s, setS] = useState<DaySummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<DaySummary>(`/pos/summary?outletId=${outletId}`).then((r) => setS(r.data)).catch((e) => setError(errorText(e))); }, [outletId]);
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
                  <tr key={m.name}><td>{m.name}</td><td className="ui-money">{money(m.received)}</td><td className="ui-money">{money(m.refunded)}</td><td className="ui-money"><strong>{money(m.net)}</strong></td></tr>
                ))}</tbody>
              </table>
              <p className="ui-help">All tills at this outlet. For what the drawer should hold, open Register: it counts the opening cash, cash added or taken out, and expenses too.</p>
            </>
          )}
        </div>
        <div className="ui-dialog-foot"><button className="ui-btn" type="button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
