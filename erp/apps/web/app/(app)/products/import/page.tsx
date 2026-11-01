'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText } from '../../../../lib/catalog-api';

interface Job {
  id: string; status: 'validating' | 'validated' | 'importing' | 'done' | 'failed'; totalRows: number; validRows: number;
  errorRows: number; createdCount: number; failure: string | null; errors: { row: number; column: string; message: string }[];
  errorReportUrl: string | null; mapping: Record<string, string>; waitingForWorker: boolean;
}

const FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'product_name', label: 'Product name', required: true }, { key: 'sku', label: 'SKU', required: true },
  { key: 'price', label: 'Selling price', required: true }, { key: 'mrp', label: 'MRP' }, { key: 'cost', label: 'Cost' },
  { key: 'barcode', label: 'Barcode' }, { key: 'category', label: 'Category' }, { key: 'brand', label: 'Brand' },
  { key: 'unit', label: 'Unit' }, { key: 'hsn_code', label: 'HSN code' }, { key: 'gst_rate', label: 'GST rate' },
  { key: 'size', label: 'Size' }, { key: 'colour', label: 'Colour' }, { key: 'model', label: 'Model' }, { key: 'material', label: 'Material' },
  { key: 'reorder_level', label: 'Reorder level' }, { key: 'weight_g', label: 'Weight (g)' }, { key: 'status', label: 'Status' },
  { key: 'description', label: 'Description' },
];
const SYNONYMS: Record<string, string> = {
  name: 'product_name', product: 'product_name', item: 'product_name', item_name: 'product_name', selling_price: 'price', sale_price: 'price',
  rate: 'price', ean: 'barcode', upc: 'barcode', gtin: 'barcode', hsn: 'hsn_code', gst: 'gst_rate', tax_rate: 'gst_rate', color: 'colour',
  purchase_price: 'cost', cost_price: 'cost', uom: 'unit',
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');

/** First line of the CSV, split on commas outside quotes. Enough to offer the mapping; the server parses the whole file. */
function headerOf(text: string): string[] {
  const line = text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const out: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cell.trim()); cell = ''; } else cell += c;
  }
  out.push(cell.trim());
  return out.filter(Boolean);
}

export default function ImportPage() {
  const [step, setStep] = useState<'upload' | 'map' | 'job'>('upload');
  const [fileId, setFileId] = useState('');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > 10 * 1024 * 1024) { setError('The file is larger than 10 MB. Split it into smaller files.'); return; }
    if (!/\.csv$/i.test(file.name)) { setError('Upload a .csv file. In Excel use File → Save as → CSV UTF-8.'); return; }
    const hs = headerOf(await file.slice(0, 64 * 1024).text());
    if (!hs.length) { setError('The first row should hold column headings.'); return; }
    setBusy(true);
    try {
      const { data } = await api<{ fileId: string }>(`/files?kind=import&name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: new Blob([file], { type: 'text/csv' }) });
      const auto: Record<string, string> = {};
      for (const h of hs) { const k = FIELDS.some((f) => f.key === norm(h)) ? norm(h) : SYNONYMS[norm(h)]; if (k && !auto[k]) auto[k] = h; }
      setFileId(data.fileId); setFileName(file.name); setHeaders(hs); setMapping(auto); setStep('map');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true); setError('');
    try {
      const full = Object.fromEntries(FIELDS.map((f) => [f.key, mapping[f.key] ?? ''])); // '' = do not import this field
      const { data } = await api<Job>('/imports', { method: 'POST', body: { fileId, mapping: full } });
      setJob(data); setStep('job');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true); setError('');
    try { setJob((await api<Job>(`/imports/${job!.id}/commit`, { method: 'POST' })).data); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  // Poll while the worker validates or imports.
  useEffect(() => {
    if (!job || (job.status !== 'validating' && job.status !== 'importing')) return;
    const t = setTimeout(async () => { try { setJob((await api<Job>(`/imports/${job.id}`)).data); } catch { /* retry next tick */ } }, 1500);
    return () => clearTimeout(t);
  }, [job]);

  const missing = FIELDS.filter((f) => f.required && !mapping[f.key]);

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/products">Products /</Link><h1 className="ui-h1">Import products</h1></div></div>
      <ol className="ui-steps" aria-label="Import steps">
        {['Upload', 'Match columns', 'Check and import'].map((s, i) => (
          <li key={s} data-n={i + 1} data-done={['upload', 'map', 'job'].indexOf(step) > i ? '' : undefined} aria-current={['upload', 'map', 'job'][i] === step ? 'step' : undefined}>{s}</li>
        ))}
      </ol>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      {step === 'upload' && (
        <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p>Upload a CSV with one row per item. Rows with the same product name and a size or colour become variants of one product.</p>
          <p className="ui-muted">Nothing is saved until you review the check. <a href="/api/v1/imports/template.csv">Download the template</a>.</p>
          <label className="ui-btn ui-btn--primary" style={{ width: 'fit-content' }}>
            {busy ? 'Uploading…' : 'Choose CSV file'}
            <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <p className="ui-caption">Up to 20,000 rows and 10 MB. In Excel, format the barcode column as Text so long numbers are not rounded.</p>
        </div></div>
      )}

      {step === 'map' && (
        <div className="ui-panel">
          <div className="ui-panel-head"><span className="ui-h3">Match your columns</span><span className="ui-caption">{fileName}</span></div>
          <div className="ui-table-wrap"><table className="ui-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Column in your file</th></tr></thead>
            <tbody>
              {FIELDS.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}{f.required && <span className="ui-req" aria-hidden="true">*</span>}</td>
                  <td>
                    <select className="ui-select" aria-label={`Column for ${f.label}`} value={mapping[f.key] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                      <option value="">— Don’t import —</option>
                      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="ui-form-footer">
            <button className="ui-btn" type="button" onClick={() => setStep('upload')}>Back</button>
            <button className="ui-btn ui-btn--primary" type="button" disabled={busy || missing.length > 0} onClick={start}>
              {missing.length ? `Match ${missing.map((m) => m.label).join(', ')}` : 'Check file'}
            </button>
          </div>
        </div>
      )}

      {step === 'job' && job && (
        <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          {(job.status === 'validating' || job.status === 'importing') && (
            <p role="status">{job.status === 'validating' ? 'Checking every row…' : 'Importing…'} <span className="ui-muted">You can leave this page; it keeps running.</span></p>
          )}
          {job.waitingForWorker && (job.status === 'validating' || job.status === 'importing') && (
            <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
              The background worker hasn’t picked this up yet. It will start as soon as the worker is running; ask whoever runs the server to check it.
            </div></div>
          )}
          {job.status === 'failed' && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{job.failure ?? 'The import failed.'}</div></div>}
          {(job.status === 'validated' || job.status === 'done') && (
            <div style={{ display: 'flex', gap: 'var(--space-6)' }}>
              <div className="ui-kpi"><span className="ui-caption">Rows</span><span className="ui-kpi-value">{job.totalRows.toLocaleString('en-IN')}</span></div>
              <div className="ui-kpi"><span className="ui-caption">Ready</span><span className="ui-kpi-value" style={{ color: 'var(--success)' }}>{job.validRows.toLocaleString('en-IN')}</span></div>
              <div className="ui-kpi"><span className="ui-caption">With errors</span><span className="ui-kpi-value" style={{ color: job.errorRows ? 'var(--danger)' : undefined }}>{job.errorRows.toLocaleString('en-IN')}</span></div>
            </div>
          )}
          {job.status === 'done' && (
            <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">
              Imported {job.createdCount.toLocaleString('en-IN')} products. <Link href="/products">View products</Link>
            </div></div>
          )}
          {job.errors.length > 0 && (
            <>
              <div className="ui-table-wrap"><table className="ui-table">
                <thead><tr><th scope="col" className="ui-qty">Row</th><th scope="col">Column</th><th scope="col">Problem</th></tr></thead>
                <tbody>{job.errors.map((e, i) => <tr key={i}><td className="ui-qty">{e.row}</td><td className="ui-code">{e.column}</td><td>{e.message}</td></tr>)}</tbody>
              </table></div>
              {job.errorRows > job.errors.length && <p className="ui-caption">Showing the first {job.errors.length} problems.</p>}
            </>
          )}
          <div className="ui-form-footer">
            {job.errorReportUrl && <a className="ui-btn" href={job.errorReportUrl}>Download rows with errors</a>}
            {job.status === 'validated' && (
              <button className="ui-btn ui-btn--primary" type="button" disabled={busy || job.validRows === 0} onClick={commit}>
                {job.validRows === 0 ? 'Nothing to import' : `Import ${job.validRows.toLocaleString('en-IN')} rows`}
              </button>
            )}
            {(job.status === 'done' || job.status === 'failed' || job.status === 'validated') && (
              <button className="ui-btn" type="button" onClick={() => { setJob(null); setStep('upload'); }}>Upload another file</button>
            )}
          </div>
        </div></div>
      )}
    </div>
  );
}
