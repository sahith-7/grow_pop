'use client';

import { money } from '../../../../lib/format';
import { PAY_METHOD, type DocLine, type Party, type TaxDocument } from '../../../../lib/sales-api';

// One invoice, bill of supply or credit note, laid out for A4 or an 80 mm receipt printer. Everything printed comes from the
// document's own snapshot (seller, buyer, lines, tax), never from today's settings, so a reprint is always identical.
// Printing uses the browser: only the [data-print-root] block is printed; the page sets @page size for the chosen paper.

export type Paper = 'a4' | 'receipt';

const n2 = (v: string | undefined | null) => (v === undefined || v === null ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (v: string) => (v.startsWith('-') ? `−${n2(v.slice(1))}` : n2(v));

function addressLines(p: Party) {
  return [p.address, [p.city, p.state, p.postalCode].filter(Boolean).join(' ')].filter((x) => x && x.trim());
}

/** Rate-wise tax summary (what GSTR-1's HSN/rate tables need, and what an accountant checks first). */
function byRate(lines: DocLine[]) {
  const m = new Map<string, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const e = m.get(l.gstRate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    // Paise as integers, so the summary adds up exactly like the document.
    e.taxable += Math.round(Number(l.taxableValue) * 100); e.cgst += Math.round(Number(l.cgst) * 100);
    e.sgst += Math.round(Number(l.sgst) * 100); e.igst += Math.round(Number(l.igst) * 100);
    m.set(l.gstRate, e);
  }
  return [...m.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([rate, e]) => ({ rate, ...e }));
}

export const PRINT_CSS = (paper: Paper) => `
@media print {
  @page { size: ${paper === 'receipt' ? '80mm auto' : 'A4'}; margin: ${paper === 'receipt' ? '3mm' : '12mm'}; }
  body * { visibility: hidden !important; }
  [data-print-root], [data-print-root] * { visibility: visible !important; }
  [data-print-root] { position: absolute; inset: 0 auto auto 0; width: 100%; box-shadow: none !important; border: 0 !important; margin: 0 !important; }
}
.td-doc { background: #fff; color: #111; font-size: 12px; line-height: 1.4; padding: 24px; border: 1px solid var(--border, #ddd); border-radius: 6px; }
.td-doc table { width: 100%; border-collapse: collapse; }
.td-doc th, .td-doc td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; text-align: left; }
.td-doc th { font-size: 11px; color: #444; font-weight: 600; background: #f5f5f5; }
.td-doc .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.td-doc .muted { color: #555; }
.td-doc .title { font-size: 16px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.td-doc .head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.td-doc .box { border: 1px solid #ddd; padding: 8px; border-radius: 4px; }
.td-doc .totals { margin-left: auto; width: min(320px, 100%); }
.td-doc .totals td { border: 0; padding: 2px 6px; }
.td-doc .grand td { font-size: 15px; font-weight: 700; border-top: 1px solid #111; }
.td-receipt { width: 72mm; max-width: 100%; padding: 8px; font-size: 11px; font-family: var(--font-mono, ui-monospace, monospace); }
.td-receipt .c { text-align: center; }
.td-receipt table td, .td-receipt table th { border: 0; padding: 1px 0; background: none; }
.td-receipt hr { border: 0; border-top: 1px dashed #333; margin: 6px 0; }
`;

export function TaxDocumentView({ doc, paper }: { doc: TaxDocument; paper: Paper }) {
  return paper === 'receipt' ? <Receipt doc={doc} /> : <A4 doc={doc} />;
}

function A4({ doc }: { doc: TaxDocument }) {
  const regular = doc.gstScheme === 'regular';
  const inter = doc.supplyType === 'inter';
  const s = doc.seller, b = doc.buyer;
  const label = doc.stateTaxLabel;
  return (
    <div className="td-doc" data-print-root>
      <div className="head">
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{s.legalName || s.name}</div>
          {s.name && s.legalName && s.name !== s.legalName && <div className="muted">Trading as {s.name}</div>}
          {addressLines(s).map((l, i) => <div key={i}>{l}</div>)}
          {s.gstin && <div>GSTIN <strong>{s.gstin}</strong></div>}
          {s.stateName && <div>State: {s.stateName} ({s.stateCode})</div>}
          {[s.phone, s.email].filter(Boolean).length > 0 && <div className="muted">{[s.phone, s.email].filter(Boolean).join(' · ')}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="title">{doc.title}</div>
          {doc.type === 'invoice' && <div className="muted">Original for recipient</div>}
          <div>No. <strong>{doc.number}</strong></div>
          <div>Date {fmtDate(doc.issuedDate)}</div>
          {doc.originalInvoice && <div>Against invoice <strong>{doc.originalInvoice.number}</strong> of {fmtDate(doc.originalInvoice.date)}</div>}
        </div>
      </div>
      {doc.gstScheme === 'composition' && <p style={{ fontWeight: 600 }}>Composition taxable person, not eligible to collect tax on supplies.</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, margin: '12px 0' }}>
        <div className="box">
          <div className="muted">{doc.type === 'credit_note' ? 'Customer' : 'Bill to'}</div>
          <div><strong>{b.name || 'Walk-in customer'}</strong></div>
          {b.address && <div>{b.address}</div>}
          {b.gstin && <div>GSTIN <strong>{b.gstin}</strong></div>}
          {b.stateCode && <div>State: {b.stateName ?? ''} ({b.stateCode})</div>}
          {b.phone && <div className="muted">{b.phone}</div>}
        </div>
        <div className="box">
          {doc.placeOfSupply && <div>Place of supply: <strong>{doc.placeOfSupply.name} ({doc.placeOfSupply.code})</strong></div>}
          {regular && <div>Reverse charge: No</div>}
          {doc.reason && <div>Reason: {doc.reason}</div>}
          {regular && doc.pricesIncludeTax !== undefined && <div className="muted">Prices {doc.pricesIncludeTax ? 'include' : 'exclude'} GST</div>}
        </div>
      </div>

      <table>
        <thead><tr>
          <th>#</th><th>Description</th><th>HSN/SAC</th><th className="r">Qty</th>
          {doc.type === 'invoice' && <><th className="r">Rate</th><th className="r">Discount</th></>}
          <th className="r">Taxable value</th>
          {regular && <><th className="r">GST %</th>{inter ? <th className="r">IGST</th> : <><th className="r">CGST</th><th className="r">{label}</th></>}</>}
          <th className="r">Amount</th>
        </tr></thead>
        <tbody>{doc.lines.map((l, i) => (
          <tr key={l.id}>
            <td>{i + 1}</td><td>{l.description}{l.sku && <div className="muted">{l.sku}</div>}</td><td>{l.hsnCode ?? ''}</td>
            <td className="r">{l.qty} {l.uqc}</td>
            {doc.type === 'invoice' && <><td className="r">{n2(l.unitPrice)}</td><td className="r">{Number(l.discount) ? n2(l.discount) : ''}</td></>}
            <td className="r">{n2(l.taxableValue)}</td>
            {regular && <><td className="r">{l.gstRate}</td>{inter ? <td className="r">{n2(l.igst)}</td> : <><td className="r">{n2(l.cgst)}</td><td className="r">{n2(l.sgst)}</td></>}</>}
            <td className="r">{n2(l.lineTotal)}</td>
          </tr>
        ))}</tbody>
      </table>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, alignItems: 'flex-start' }}>
        {regular && (
          <table style={{ width: 'auto', flex: '1 1 260px' }}>
            <thead><tr><th>GST %</th><th className="r">Taxable</th>{inter ? <th className="r">IGST</th> : <><th className="r">CGST</th><th className="r">{label}</th></>}</tr></thead>
            <tbody>{byRate(doc.lines).map((r) => (
              <tr key={r.rate}><td>{r.rate}%</td><td className="r">{n2(String(r.taxable / 100))}</td>
                {inter ? <td className="r">{n2(String(r.igst / 100))}</td> : <><td className="r">{n2(String(r.cgst / 100))}</td><td className="r">{n2(String(r.sgst / 100))}</td></>}</tr>
            ))}</tbody>
          </table>
        )}
        <table className="totals"><tbody>
          <tr><td>Taxable value</td><td className="r">{n2(doc.taxableTotal)}</td></tr>
          {regular && !inter && <><tr><td>CGST</td><td className="r">{n2(doc.cgst)}</td></tr><tr><td>{label}</td><td className="r">{n2(doc.sgst)}</td></tr></>}
          {regular && inter && <tr><td>IGST</td><td className="r">{n2(doc.igst)}</td></tr>}
          {Number(doc.roundOff) !== 0 && <tr><td>Round off</td><td className="r">{signed(doc.roundOff)}</td></tr>}
          <tr className="grand"><td>Total ₹</td><td className="r">{n2(doc.total)}</td></tr>
        </tbody></table>
      </div>
      <p><strong>{doc.totalInWords}</strong></p>

      <div className="head" style={{ marginTop: 24, alignItems: 'flex-end' }}>
        <div className="muted" style={{ maxWidth: 420 }}>{doc.receiptFooter}</div>
        <div style={{ textAlign: 'right' }}>
          <div>For {s.legalName || s.name}</div>
          <div style={{ height: 36 }} />
          <div className="muted">Authorised signatory</div>
        </div>
      </div>
    </div>
  );
}

function Receipt({ doc }: { doc: TaxDocument }) {
  const regular = doc.gstScheme === 'regular';
  const s = doc.seller, b = doc.buyer;
  const paid = (doc.payments ?? []).filter((p) => p.kind === 'payment');
  return (
    <div className="td-doc td-receipt" data-print-root>
      <div className="c"><strong>{s.legalName || s.name}</strong></div>
      {s.name && s.legalName && s.name !== s.legalName && <div className="c">{s.name}</div>}
      {addressLines(s).map((l, i) => <div className="c" key={i}>{l}</div>)}
      {s.gstin && <div className="c">GSTIN {s.gstin}</div>}
      {s.phone && <div className="c">{s.phone}</div>}
      <hr />
      <div className="c"><strong>{doc.title.toUpperCase()}</strong></div>
      {doc.gstScheme === 'composition' && <div className="c">Composition taxable person, not eligible to collect tax on supplies</div>}
      <div>No. {doc.number}</div>
      <div>Date {fmtDate(doc.issuedDate)} {new Date(doc.issuedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
      {doc.originalInvoice && <div>Against {doc.originalInvoice.number}</div>}
      {b.name && <div>To: {b.name}{b.gstin ? ` · GSTIN ${b.gstin}` : ''}</div>}
      {doc.placeOfSupply && regular && <div>Place of supply: {doc.placeOfSupply.name} ({doc.placeOfSupply.code})</div>}
      <hr />
      <table><tbody>{doc.lines.map((l) => (
        <tr key={l.id}><td colSpan={2}>
          <div>{l.description}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{l.qty} × {n2(l.unitPrice ?? String(Number(l.lineTotal) / Number(l.qty)))}{Number(l.discount) ? ` −${n2(l.discount)}` : ''}{regular ? ` @${l.gstRate}%` : ''}</span>
            <span>{n2(l.lineTotal)}</span>
          </div>
          {l.hsnCode && <div className="muted">HSN {l.hsnCode}</div>}
        </td></tr>
      ))}</tbody></table>
      <hr />
      <Row k="Taxable value" v={n2(doc.taxableTotal)} />
      {regular && doc.supplyType !== 'inter' && <><Row k="CGST" v={n2(doc.cgst)} /><Row k={doc.stateTaxLabel} v={n2(doc.sgst)} /></>}
      {regular && doc.supplyType === 'inter' && <Row k="IGST" v={n2(doc.igst)} />}
      {Number(doc.roundOff) !== 0 && <Row k="Round off" v={signed(doc.roundOff)} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, marginTop: 4 }}><span>TOTAL</span><span>{money(doc.total)}</span></div>
      {paid.length > 0 && <hr />}
      {paid.map((p, i) => <Row key={i} k={`${PAY_METHOD[p.method] ?? p.method}${p.reference ? ` (${p.reference})` : ''}`} v={n2(p.tendered ?? p.amount)} />)}
      {paid.filter((p) => p.change && Number(p.change) > 0).map((p, i) => <Row key={`c${i}`} k="Change" v={n2(p.change)} />)}
      <hr />
      {doc.receiptFooter && <div className="c">{doc.receiptFooter}</div>}
      <div className="c muted">Thank you</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{k}</span><span>{v}</span></div>;
}

export function fmtDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
