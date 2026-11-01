'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { api, errorText, ApiError, type ReportColumn, type ReportInfo, type ReportResult } from '../../../lib/fulfil-api';
import type { Location } from '../../../lib/stock-api';

// Reports (PRD 8, B6). The screen shows the first 500 rows with totals over all of them; the CSV has every row.

const cellText = (c: ReportColumn, v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : c.type === 'money' ? money(String(v)) : String(v);
const numeric = (c: ReportColumn) => c.type !== 'text';

function ReportsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<{ items: ReportInfo[]; can: { export: boolean; cost: boolean } } | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  const key = params.get('r') ?? 'inventory-summary';
  const info = list?.items.find((r) => r.key === key) ?? list?.items[0];
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [locationId, setLocationId] = useState(params.get('locationId') ?? '');

  useEffect(() => {
    api<{ items: ReportInfo[]; can: { export: boolean; cost: boolean } }>('/reports').then((r) => setList(r.data)).catch((e) => setError(errorText(e)));
    api<{ items: Location[] }>('/locations').then((r) => setLocations(r.data.items)).catch(() => {});
  }, []);

  const query = () => {
    const qs = new URLSearchParams();
    if (info?.dated && params.get('from')) qs.set('from', params.get('from')!);
    if (info?.dated && params.get('to')) qs.set('to', params.get('to')!);
    if (info?.location && params.get('locationId')) qs.set('locationId', params.get('locationId')!);
    return qs;
  };

  useEffect(() => {
    if (!info) return;
    setLoading(true); setError(''); setFieldErrors({});
    api<ReportResult>(`/reports/${info.key}?${query()}`)
      .then((r) => { setResult(r.data); if (r.data.from) setFrom(r.data.from); if (r.data.to) setTo(r.data.to); })
      .catch((e) => { setError(errorText(e)); setResult(null); if (e instanceof ApiError) setFieldErrors(e.fieldErrors); })
      .finally(() => setLoading(false));
  }, [info?.key, params]);

  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/reports?${p}`);
  };

  const csv = () => { const qs = query(); qs.set('format', 'csv'); return `/api/v1/reports/${info!.key}?${qs}`; };

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div style={{ flex: 1 }}><h1 className="ui-h1">Reports</h1></div>
        {list?.can.export && info && <a className="ui-btn" href={csv()} download>Download CSV</a>}
      </div>
      {list && (
        <div className="ui-tabs" role="tablist">
          {list.items.map((r) => (
            <button key={r.key} className="ui-tab" role="tab" type="button" aria-selected={info?.key === r.key} onClick={() => go({ r: r.key })}>{r.title}</button>
          ))}
        </div>
      )}
      {info && (
        <form className="ui-toolbar" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}
          onSubmit={(e) => { e.preventDefault(); go({ from: info.dated ? from : '', to: info.dated ? to : '', locationId: info.location ? locationId : '' }); }}>
          {info.dated && <>
            <label className="ui-field"><span className="ui-label">From</span><input className="ui-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={!!fieldErrors.from} /></label>
            <label className="ui-field"><span className="ui-label">To</span><input className="ui-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>}
          {info.location && (
            <label className="ui-field"><span className="ui-label">Location</span>
              <select className="ui-select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">All locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></label>
          )}
          {(info.dated || info.location) && <button className="ui-btn ui-btn--primary" type="submit">Show</button>}
        </form>
      )}
      {info && <p className="ui-muted" style={{ margin: 0 }}>{info.description}{list && !list.can.cost ? ' Cost and value columns are hidden for your role.' : ''}</p>}
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}{Object.values(fieldErrors).flat().length ? `: ${Object.values(fieldErrors).flat().join(' · ')}` : ''}</div></div>}

      <div className="ui-panel" aria-busy={loading}>
        {!result ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 200 }} /></div>
          : !result.rows.length ? <div className="ui-empty"><p className="ui-h3">No rows</p><p className="ui-muted">Nothing matches these filters.</p></div>
          : (
            <div className="ui-table-wrap"><table className="ui-table">
              <thead><tr>{result.columns.map((c) => <th key={c.key} scope="col" className={numeric(c) ? 'ui-num' : undefined}>{c.label}</th>)}</tr></thead>
              <tbody>{result.rows.map((r, i) => (
                <tr key={i}>{result.columns.map((c) => <td key={c.key} className={numeric(c) ? 'ui-num' : undefined}>{cellText(c, r[c.key])}</td>)}</tr>
              ))}</tbody>
              {result.columns.some((c) => c.total) && (
                <tfoot><tr>{result.columns.map((c, i) => (
                  <th key={c.key} scope={i === 0 ? 'row' : undefined} className={numeric(c) ? 'ui-num' : undefined}>
                    {i === 0 ? 'Total' : c.total ? cellText(c, result.totals[c.key]) : ''}</th>
                ))}</tr></tfoot>
              )}
            </table></div>
          )}
        {result && (
          <div className="ui-pager">
            <span>{result.truncated ? `Showing the first ${result.rows.length} of ${result.rowCount} rows; totals cover all of them.${list?.can.export ? ' Download the CSV for every row.' : ''}` : `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`}</span>
            {result.from && <span className="ui-caption">{result.from} to {result.to}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><ReportsPage /></Suspense>;
}
