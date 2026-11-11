'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fieldError } from '../../../lib/stock-api';
import { ApiError, api, BILL_FORMATS, errorText, SCHEME, type BillingSettings, type Series } from '../../../lib/sales-api';
import { useCan } from '../../../lib/me';
import { useOutletInView } from '../../../lib/outlet-scope';

// Billing & GST (B5): how this store bills. The seller's legal name, GSTIN and address live in Settings (Phase 1) and are
// shown here read-only; every invoice copies them at the moment it is issued.

type Form = Omit<BillingSettings, 'ready' | 'problems' | 'seller' | 'timezone' | 'locations' | 'states' | 'can'>;
const PCT: [keyof Form, string, string][] = [
  ['cashierDiscountLimitPct', 'Cashier discount limit (%)', 'The most a cashier can take off a bill. The owner has no limit.'],
  ['managerDiscountLimitPct', 'Manager discount limit (%)', ''],
  ['discountReasonThresholdPct', 'Ask for a reason above (%)', 'Discounts above this need a reason, which goes in the audit log.'],
];

export default function BillingPage() {
  const [s, setS] = useState<BillingSettings | null>(null);
  const inView = useOutletInView();
  const canOutlets = useCan('account.manage');
  const [f, setF] = useState<Form | null>(null);
  const [series, setSeries] = useState<{ currentFinancialYear: string; items: Series[]; defaults: { invoice: string; creditNote: string } } | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const take = (d: BillingSettings) => {
    setS(d);
    const { ready, problems, seller, timezone, locations, states, can, ...form } = d;
    setF(form);
  };
  const loadSeries = () => api<NonNullable<typeof series>>('/billing/series').then((r) => setSeries(r.data)).catch(() => {});
  useEffect(() => { api<BillingSettings>('/billing/settings').then((r) => take(r.data)).catch((e) => setError(errorText(e))); loadSeries(); }, []);

  if (!s || !f) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 320 }} />}</div>;

  const readOnly = !s.can.manage;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF({ ...f, [k]: v }); setSaved(false); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({}); setSaved(false);
    const body: Record<string, unknown> = { ...f, receiptFooter: f.receiptFooter?.trim() || null };
    if (!f.gstScheme) delete body.gstScheme;
    if (f.gstScheme !== 'unregistered') delete body.stateCode;
    try { const { data } = await api<BillingSettings>('/billing/settings', { method: 'PATCH', body }); take(data); setSaved(true); loadSeries(); }
    catch (err) { setError(errorText(err)); if (err instanceof ApiError) setErrors(err.fieldErrors); } finally { setBusy(false); }
  };

  const seller = s.seller;
  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><h1 className="ui-h1">Billing &amp; GST</h1><div className="ui-caption">How this store’s invoices are worked out and numbered.</div></div></div>

      {inView && !inView.isMain && (
        // v2 (D115): this page is store-wide; an outlet's own address, GST state and bill numbers are on its outlet page.
        <div className="ui-alert ui-alert--info" role="note"><div className="ui-alert-body">
          These rules apply to every outlet, and the seller below is the main outlet. {inView.name}’s own address, GST state and bill numbers are on its outlet page.
          {canOutlets && <> <Link href={`/account/outlets/${inView.id}`}>Open {inView.name}</Link></>}
        </div></div>
      )}
      {!s.ready && (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          <strong>The counter cannot bill yet.</strong>
          <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.2em' }}>{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div></div>
      )}
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {saved && <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">Saved.</div></div>}

      <div className="ui-panel">
        <div className="ui-panel-head"><span className="ui-h3">Seller on the invoice</span>{s.can.manage && <Link className="ui-btn ui-btn--sm" href="/settings">Edit in Settings</Link>}</div>
        <div className="ui-panel-body">
          <div className="ui-cell-title">{seller.legalName || <span className="ui-muted">No legal name</span>}</div>
          {seller.name && seller.name !== seller.legalName && <div className="ui-muted">Trading as {seller.name}</div>}
          <div>{[seller.address, seller.city, seller.state, seller.postalCode].filter(Boolean).join(', ') || <span className="ui-muted">No address</span>}</div>
          <div>GSTIN: {seller.gstin ? <span className="ui-code">{seller.gstin}</span> : <span className="ui-muted">none</span>}{seller.stateName ? ` · ${seller.stateName}` : ''}</div>
        </div>
      </div>

      <form className="ui-panel" onSubmit={save}>
        <fieldset disabled={readOnly || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 640 }}>
            <label className="ui-field"><span className="ui-label">GST registration</span>
              <select className="ui-select" value={f.gstScheme ?? ''} onChange={(e) => set('gstScheme', (e.target.value || null) as Form['gstScheme'])} aria-invalid={!!fieldError(errors, 'gstScheme')}>
                {!f.gstScheme && <option value="">Choose…</option>}
                {Object.entries(SCHEME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <span className="ui-help">Regular: tax invoices with CGST/SGST or IGST. Composition: bills of supply with no tax shown. Not registered: plain bills. Confirm with your CA.</span>
              {fieldError(errors, 'gstScheme') && <span className="ui-error">{fieldError(errors, 'gstScheme')}</span>}</label>

            {f.gstScheme === 'unregistered' && (
              <label className="ui-field"><span className="ui-label">Shop’s state</span>
                <select className="ui-select" value={f.stateCode ?? ''} onChange={(e) => set('stateCode', e.target.value || null)} aria-invalid={!!fieldError(errors, 'stateCode')}>
                  <option value="">Choose…</option>
                  {s.states.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                </select>
                {fieldError(errors, 'stateCode') && <span className="ui-error">{fieldError(errors, 'stateCode')}</span>}</label>
            )}

            <label className="ui-check"><input type="checkbox" checked={f.pricesIncludeTax} onChange={(e) => set('pricesIncludeTax', e.target.checked)} /> Shelf prices include GST (usual for shops)</label>
            <label className="ui-check"><input type="checkbox" checked={f.roundOff} onChange={(e) => set('roundOff', e.target.checked)} /> Round counter bills to the nearest rupee</label>

            <label className="ui-field"><span className="ui-label">Counter sells from</span>
              <select className="ui-select" value={f.posLocationId ?? ''} onChange={(e) => set('posLocationId', e.target.value || null)} aria-invalid={!!fieldError(errors, 'posLocationId')}>
                <option value="">Shop floor (default)</option>
                {s.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {fieldError(errors, 'posLocationId') && <span className="ui-error">{fieldError(errors, 'posLocationId')}</span>}</label>

            <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {PCT.map(([k, label, help]) => (
                <label className="ui-field" key={k}><span className="ui-label">{label}</span>
                  <input className="ui-input ui-input--num" inputMode="decimal" value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} aria-invalid={!!fieldError(errors, k)} />
                  {help && <span className="ui-help">{help}</span>}
                  {fieldError(errors, k) && <span className="ui-error">{fieldError(errors, k)}</span>}</label>
              ))}
            </div>

            <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {(['invoicePrefix', 'creditNotePrefix'] as const).map((k) => (
                <label className="ui-field" key={k}><span className="ui-label">{k === 'invoicePrefix' ? 'Invoice prefix' : 'Credit note prefix'}</span>
                  <input className="ui-input" value={f[k]} maxLength={6} onChange={(e) => set(k, e.target.value)} aria-invalid={!!fieldError(errors, k)} />
                  <span className="ui-help">Numbers look like {f[k] || 'INV'}/{series?.currentFinancialYear.slice(2) ?? '26-27'}/1. Applies from the next financial year if this year already has documents.</span>
                  {fieldError(errors, k) && <span className="ui-error">{fieldError(errors, k)}</span>}</label>
              ))}
            </div>

            <label className="ui-check"><input type="checkbox" checked={f.requireCustomer} onChange={(e) => set('requireCustomer', e.target.checked)} /> Every counter bill needs the customer’s name and mobile number, or Walk-in</label>
            <span className="ui-help" style={{ marginTop: 'calc(-1 * var(--space-3))' }}>Made-up numbers (9999999999, 1234567890) and the shop’s own number are refused. A customer who won’t give a number is billed as Walk-in, so you can see how often that happens.</span>

            <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
              <legend className="ui-h3" style={{ marginBottom: 'var(--space-2)' }}>Cash at the counter</legend>
              <label className="ui-check"><input type="checkbox" checked={f.requireRegister} onChange={(e) => set('requireRegister', e.target.checked)} /> Open the register (count the drawer) before the first bill at a till</label>
              <span className="ui-help" style={{ marginTop: 'calc(-1 * var(--space-2))' }}>Every sale, refund and expense at the till is then added to its drawer, and closing shows if the cash is short or over. Turn this off only if you don’t count the cash.</span>
              <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {([['expenseLimitEach', 'Expense limit, one entry', 'A cashier’s till expense above this waits for an owner or manager.'],
                  ['expenseLimitDay', 'Expense limit, per day', 'A cashier’s expenses in one day above this wait too.']] as const).map(([k, label, help]) => (
                  <label className="ui-field" key={k}><span className="ui-label">{label}</span>
                    <input className="ui-input ui-input--num" inputMode="decimal" value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!fieldError(errors, k)} />
                    <span className="ui-help">{help}</span>
                    {fieldError(errors, k) && <span className="ui-error">{fieldError(errors, k)}</span>}</label>
                ))}
              </div>
            </fieldset>

            <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
              <legend className="ui-h3" style={{ marginBottom: 'var(--space-2)' }}>Returns and exchanges</legend>
              <label className="ui-field" style={{ maxWidth: 280 }}><span className="ui-label">Take items back within (days of the bill)</span>
                <input className="ui-input ui-input--num" inputMode="numeric" placeholder="No limit" value={f.returnDays === null ? '' : String(f.returnDays)}
                  onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); set('returnDays', v === '' ? null : Number(v)); }} aria-invalid={!!fieldError(errors, 'returnDays')} />
                {fieldError(errors, 'returnDays') && <span className="ui-error">{fieldError(errors, 'returnDays')}</span>}</label>
              <label className="ui-check"><input type="checkbox" checked={f.returnMoneyBack} onChange={(e) => set('returnMoneyBack', e.target.checked)} /> Give money back on returns (off: exchange only)</label>
              <span className="ui-help" style={{ marginTop: 'calc(-1 * var(--space-2))' }}>Categories that can’t be returned (innerwear, cosmetics) are marked on <Link href="/products/categories">Categories &amp; brands</Link>. These rules hold for cashiers and managers; the owner can still take an item back. Voiding a wrong bill isn’t a return and isn’t affected.</span>
            </fieldset>

            <label className="ui-check"><input type="checkbox" checked={f.invoiceWebOrders} onChange={(e) => set('invoiceWebOrders', e.target.checked)} /> Issue GST invoices for WooCommerce orders when they are completed</label>
            <span className="ui-help" style={{ marginTop: 'calc(-1 * var(--space-3))' }}>Turn this off only if a WooCommerce plugin already makes your web invoices; two invoices for one sale is a GST error.</span>

            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="ui-label" style={{ marginBottom: 'var(--space-2)' }}>Bill format</legend>
              <div style={{ display: 'grid', gap: 'var(--space-2)', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                {BILL_FORMATS.map((b) => (
                  <label key={b.value} className="ui-check" style={{ alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-2) var(--space-3)',
                    background: f.billFormat === b.value ? 'var(--brand-ink-soft)' : undefined }}>
                    <input type="radio" name="billFormat" value={b.value} checked={f.billFormat === b.value} onChange={() => set('billFormat', b.value)} style={{ marginTop: 3 }} />
                    <span><b>{b.label}</b><br /><span className="ui-help">{b.help}</span></span>
                  </label>
                ))}
              </div>
              <span className="ui-help">What the counter prints after each sale and what invoice pages open with. Any bill can still be printed on the other papers.</span>
            </fieldset>

            <label className="ui-field"><span className="ui-label">Receipt footer</span>
              <textarea className="ui-textarea" maxLength={300} value={f.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} placeholder="e.g. Exchange within 7 days with the bill." /></label>
          </div>
          {s.can.manage && <div className="ui-panel-body"><button className="ui-btn ui-btn--primary" type="submit" aria-busy={busy}>Save</button></div>}
        </fieldset>
      </form>

      {series && <SeriesPanel series={series} manage={s.can.manage} onChange={setSeries} />}
    </div>
  );
}

function SeriesPanel({ series, manage, onChange }: { series: { currentFinancialYear: string; items: Series[]; defaults: { invoice: string; creditNote: string } }; manage: boolean; onChange: (s: any) => void }) {
  const cur = series.currentFinancialYear;
  const next = `${Number(cur.slice(0, 4)) + 1}-${String((Number(cur.slice(0, 4)) + 2) % 100).padStart(2, '0')}`;
  const [form, setForm] = useState<{ docType: 'invoice' | 'credit_note'; financialYear: string; prefix: string; startAt: string } | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const save = async () => {
    if (!form) return;
    setError(''); setErrors({});
    try { const { data } = await api('/billing/series', { method: 'POST', body: { ...form, startAt: Number(form.startAt) } }); onChange(data); setForm(null); }
    catch (e) { setError(errorText(e)); if (e instanceof ApiError) setErrors(e.fieldErrors); }
  };

  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Number series</span>
        {manage && !form && <button className="ui-btn ui-btn--sm" type="button" onClick={() => setForm({ docType: 'invoice', financialYear: cur, prefix: series.defaults.invoice, startAt: '1' })}>Set a starting number</button>}</div>
      <div className="ui-panel-body ui-muted">Each financial year (April to March) starts a new series. Numbers never skip or repeat. If you are moving from other billing software mid-year, set the next number here before the first sale.</div>
      {series.items.length > 0 && (
        <div className="ui-table-wrap"><table className="ui-table" data-collapse>
          <thead><tr><th scope="col">Series</th><th scope="col">Year</th><th scope="col">Next document</th><th scope="col">In use</th></tr></thead>
          <tbody>{series.items.map((x) => (
            <tr key={x.id}><td data-primary>{x.docType === 'invoice' ? 'Invoices' : 'Credit notes'}</td><td data-label="Year">{x.financialYear}</td>
              <td data-label="Next document"><span className="ui-code">{x.nextDocument}</span></td><td data-label="In use">{x.used ? 'Yes' : 'Not yet'}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {form && (
        <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 640 }}>
          {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
          <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <label className="ui-field"><span className="ui-label">Series</span>
              <select className="ui-select" value={form.docType} onChange={(e) => { const d = e.target.value as 'invoice' | 'credit_note'; setForm({ ...form, docType: d, prefix: d === 'invoice' ? series.defaults.invoice : series.defaults.creditNote }); }}>
                <option value="invoice">Invoices</option><option value="credit_note">Credit notes</option></select></label>
            <label className="ui-field"><span className="ui-label">Year</span>
              <select className="ui-select" value={form.financialYear} onChange={(e) => setForm({ ...form, financialYear: e.target.value })}>
                <option value={cur}>{cur}</option><option value={next}>{next}</option></select></label>
            <label className="ui-field"><span className="ui-label">Prefix</span>
              <input className="ui-input" value={form.prefix} maxLength={12} onChange={(e) => setForm({ ...form, prefix: e.target.value })} aria-invalid={!!fieldError(errors, 'prefix')} />
              {fieldError(errors, 'prefix') && <span className="ui-error">{fieldError(errors, 'prefix')}</span>}</label>
            <label className="ui-field"><span className="ui-label">Next number</span>
              <input className="ui-input ui-input--num" inputMode="numeric" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value.replace(/\D/g, '') })} aria-invalid={!!fieldError(errors, 'startAt')} />
              {fieldError(errors, 'startAt') && <span className="ui-error">{fieldError(errors, 'startAt')}</span>}</label>
          </div>
          <span className="ui-help">The first document will be {form.prefix}{form.startAt || '1'}. At most 16 characters (GST rule). This cannot be changed once the series is used.</span>
          <div className="ui-actions"><button className="ui-btn" type="button" onClick={() => setForm(null)}>Cancel</button><button className="ui-btn ui-btn--primary" type="button" onClick={save}>Save series</button></div>
        </div>
      )}
    </div>
  );
}
