'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorText, idemKey, type StockMeta } from '../../../../lib/stock-api';
import { useMe } from '../../../../lib/me';
import { metaInView } from '../../../../lib/outlet-scope';

interface Check {
  totalRows: number; validRows: number; errorCount: number;
  errors: { row: number; column: string; message: string }[];
  posted: { id: string; number: string; location: string }[];
}

/** Opening stock from a CSV: upload, check every row, then post it all or nothing. */
export default function OpeningStockPage() {
  const view = useMe().outlets;
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [locationId, setLocationId] = useState('');
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idemKey);

  useEffect(() => {
    api<StockMeta>('/stock/meta').then(({ data: all }) => {
      const data = metaInView(view, all);   // v2 (D115): rooms at the outlet in view
      setMeta(data);
      const active = data.locations.filter((l) => l.active);
      setLocationId(active.find((l) => l.type === 'shop_floor')?.id ?? active[0]?.id ?? '');
    }).catch((e) => setError(errorText(e)));
  }, []);

  const run = async (fileId: string, commit: boolean) => {
    const { data } = await api<Check>('/stock/opening-import', { method: 'POST', body: { fileId, locationId, commit }, headers: commit ? key : undefined });
    setCheck(data);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(''); setCheck(null);
    if (f.size > 10 * 1024 * 1024) { setError('The file is larger than 10 MB. Split it into smaller files.'); return; }
    if (!/\.csv$/i.test(f.name)) { setError('Upload a .csv file. In Excel use File → Save as → CSV UTF-8.'); return; }
    setBusy(true);
    try {
      const { data } = await api<{ fileId: string }>(`/files?kind=import&name=${encodeURIComponent(f.name)}`, { method: 'POST', raw: new Blob([f], { type: 'text/csv' }) });
      setFile({ id: data.fileId, name: f.name });
      setKey(idemKey());
      await run(data.fileId, false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true); setError('');
    try { await run(file!.id, true); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const reset = () => { setFile(null); setCheck(null); setError(''); };

  const active = meta?.locations.filter((l) => l.active) ?? [];
  const done = !!check?.posted.length;

  return (
    <div className="ui-content">
      <div className="ui-page-header"><div><Link className="ui-caption" href="/stock">Stock /</Link><h1 className="ui-h1">Opening stock</h1></div></div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      {!check && (
        <div className="ui-panel"><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p>Upload a CSV with one row per item and location: <span className="ui-code">sku</span>, <span className="ui-code">qty</span>, optionally <span className="ui-code">location</span>{meta?.can.seeCost && <> and <span className="ui-code">unit_cost</span></>}.</p>
          <p className="ui-muted">Nothing is posted until you review the check. Use this once per item; after that, change stock with an adjustment. <a href="/api/v1/stock/opening-import/template.csv">Download the template</a>.</p>
          <label className="ui-field" style={{ maxWidth: 320 }}><span className="ui-label">Location for rows with no location</span>
            <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </label>
          <label className="ui-btn ui-btn--primary" style={{ width: 'fit-content' }}>
            {busy ? 'Checking…' : 'Choose CSV file'}
            <input type="file" accept=".csv,text/csv" hidden disabled={busy || !locationId} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <p className="ui-caption">Up to 5,000 rows. SKU or barcode both work in the sku column.</p>
        </div></div>
      )}

      {check && (
        <div className="ui-panel">
          <div className="ui-panel-head"><span className="ui-h3">{done ? 'Posted' : 'Check'}</span><span className="ui-caption">{file?.name}</span></div>
          <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-6)' }}>
              <div className="ui-kpi"><span className="ui-caption">Rows</span><span className="ui-kpi-value">{check.totalRows.toLocaleString('en-IN')}</span></div>
              <div className="ui-kpi"><span className="ui-caption">Ready</span><span className="ui-kpi-value" style={{ color: 'var(--success)' }}>{check.validRows.toLocaleString('en-IN')}</span></div>
              <div className="ui-kpi"><span className="ui-caption">Problems</span><span className="ui-kpi-value" style={{ color: check.errorCount ? 'var(--danger)' : undefined }}>{check.errorCount.toLocaleString('en-IN')}</span></div>
            </div>
            {done && (
              <div className="ui-alert ui-alert--success" role="status"><div className="ui-alert-body">
                Posted {check.posted.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link href={`/stock/movements?sourceId=${p.id}`}>{p.number}</Link> ({p.location})</span>)}.
              </div></div>
            )}
            {check.errorCount > 0 && <p>Fix these rows in your file and upload it again. Nothing has been posted: the file goes in all at once or not at all.</p>}
          </div>
          {check.errors.length > 0 && (
            <div className="ui-table-wrap"><table className="ui-table">
              <thead><tr><th scope="col" className="ui-num">Row</th><th scope="col">Column</th><th scope="col">Problem</th></tr></thead>
              <tbody>{check.errors.map((e, i) => <tr key={i}><td className="ui-num">{e.row}</td><td className="ui-code">{e.column}</td><td>{e.message}</td></tr>)}</tbody>
            </table></div>
          )}
          {check.errorCount > check.errors.length && <div className="ui-panel-body ui-caption">Showing the first {check.errors.length} problems.</div>}
          <div className="ui-form-footer">
            <button className="ui-btn" type="button" onClick={reset}>{done ? 'Upload another file' : 'Choose a different file'}</button>
            {!done && check.errorCount === 0 && check.validRows > 0 && (
              <button className="ui-btn ui-btn--primary" type="button" aria-busy={busy} disabled={busy} onClick={commit}>Post {check.validRows.toLocaleString('en-IN')} rows</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
