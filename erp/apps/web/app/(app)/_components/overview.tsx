'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '@/lib/catalog-api';
import { addDays, fmtDay, fmtStamp, todayIST } from '@/lib/datetime';
import { money } from '@/lib/format';
import { Icon } from '@/lib/icons';
import { PAY_METHOD } from '@/lib/sales-api';
import { useOutletInView } from '@/lib/outlet-scope';

// v2 (D90): the dashboard Overview. Filters in one row above everything they change: date range, location, channel,
// and when the numbers were fetched ("Last synced") with a refresh. Then KPI tiles, the sales/purchase trend and payment modes.

interface Tile { key: string; label: string; value: string; kind: 'money' | 'count' | 'qty' | 'percent'; delta: number | null; href?: string }
interface Overview {
  from: string; to: string; today: string; lastSyncedAt: string; previous: { from: string; to: string };
  locations: { id: string; name: string }[]; tiles: Tile[]; marginNote?: string | null;
  paymentModes?: { method: string; amount: string }[];
  trend?: { day: string; sales?: string; purchases?: string }[];
}

// Tile families: one soft fill per kind of figure (tokens --tile-*). Text stays in text colours; the fill carries the family.
const FAMILY: Record<string, string> = {
  sales: 'green', invoices: 'violet', soldQty: 'amber', customers: 'rose', salesReturns: 'blue', avgCart: 'amber', cash: 'green',
  margin: 'green', marginPct: 'violet', purchases: 'green', bills: 'violet', purchaseReturns: 'rose', suppliers: 'amber',
  products: 'violet', stockQty: 'amber', stockValue: 'rose',
};

type Preset = { key: string; label: string; range: (today: string) => [string, string] };
const fyStart = (today: string) => { const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7)); return `${m >= 4 ? y : y - 1}-04-01`; };
const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const PRESETS: Preset[] = [
  { key: 'today', label: 'Today', range: (t) => [t, t] },
  { key: 'yesterday', label: 'Yesterday', range: (t) => [addDays(t, -1), addDays(t, -1)] },
  { key: '7', label: 'Last 7 days', range: (t) => [addDays(t, -6), t] },
  { key: '30', label: 'Last 30 days', range: (t) => [addDays(t, -29), t] },
  { key: 'month', label: 'This month', range: (t) => [monthStart(t), t] },
  { key: 'lastMonth', label: 'Last month', range: (t) => { const end = addDays(monthStart(t), -1); return [monthStart(end), end]; } },
  { key: 'fy', label: 'This financial year', range: (t) => [fyStart(t), t] },
];

function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const ref = useRef<HTMLDivElement>(null);
  const today = todayIST();
  useEffect(() => { setF(from); setT(to); }, [from, to]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (a: string, b: string) => { onChange(a, b); setOpen(false); };
  return (
    <div className="gp-pop" ref={ref}>
      <button type="button" className="gp-filter" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="calendar" size={16} /><span>{fmtDay(from)} – {fmtDay(to)}</span>
      </button>
      {open && (
        <div className="ui-menu gp-menu gp-range" role="dialog" aria-label="Choose dates">
          <div className="gp-range-presets">
            {PRESETS.map((p) => { const [a, b] = p.range(today); return (
              <button key={p.key} type="button" aria-pressed={a === from && b === to} onClick={() => pick(a, b)}>{p.label}</button>
            ); })}
          </div>
          <div className="gp-range-custom">
            <label className="ui-label">From<input className="ui-input" type="date" value={f} max={t} onChange={(e) => setF(e.target.value)} /></label>
            <label className="ui-label">To<input className="ui-input" type="date" value={t} min={f} max={today} onChange={(e) => setT(e.target.value)} /></label>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!f || !t || f > t} onClick={() => pick(f, t)}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Whether a rise is good news. Green/red only where that is clear; purchases and stock just show the direction.
const UP_IS_GOOD = new Set(['sales', 'invoices', 'soldQty', 'customers', 'avgCart', 'margin', 'marginPct', 'cash']);
const UP_IS_BAD = new Set(['salesReturns']);

function Delta({ v, k }: { v: number | null; k: string }) {
  if (v === null) return <span className="gp-delta" title="No figure for the days just before to compare with">—</span>;
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : undefined;
  const tone = !dir ? undefined : UP_IS_GOOD.has(k) ? (dir === 'up' ? 'good' : 'bad') : UP_IS_BAD.has(k) ? (dir === 'up' ? 'bad' : 'good') : undefined;
  return (
    <span className="gp-delta" data-tone={tone} title="Compared with the same number of days just before">
      {dir && <Icon name={dir === 'up' ? 'arrowUp' : 'arrowDown'} size={12} />}
      {v === 0 ? '0%' : `${Math.abs(v).toFixed(Math.abs(v) < 10 ? 2 : 1)}%`}
      <span className="ui-sr-only">{dir === 'up' ? ' higher' : dir === 'down' ? ' lower' : ''} than the days before</span>
    </span>
  );
}

const compact = (n: number) => (Math.abs(n) >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : Math.abs(n) >= 1e3 ? `₹${(n / 1e3).toFixed(1)} K` : `₹${n.toFixed(0)}`);
const tileValue = (t: Tile) => (t.kind === 'money' ? compact(Number(t.value)) : t.kind === 'percent' ? `${t.value}%` : Number(t.value).toLocaleString('en-IN'));

function KpiTile({ t }: { t: Tile }) {
  const body = (
    <>
      <span className="gp-kpi-top"><span className="gp-kpi-value" title={t.kind === 'money' ? money(t.value) : undefined}>{tileValue(t)}</span><Delta v={t.delta} k={t.key} /></span>
      <span className="gp-kpi-label">{t.label}</span>
    </>
  );
  return t.href
    ? <Link className="gp-kpi" data-family={FAMILY[t.key] ?? 'blue'} href={t.href}>{body}</Link>
    : <div className="gp-kpi" data-family={FAMILY[t.key] ?? 'blue'}>{body}</div>;
}

/** Sales (and purchases, for roles that see cost) per day on one rupee axis, with a crosshair tooltip. */
function TrendChart({ trend }: { trend: NonNullable<Overview['trend']> }) {
  const series = (['sales', 'purchases'] as const).filter((k) => trend.some((d) => d[k] !== undefined));
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width) || 640));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const W = Math.max(280, width), H = W < 520 ? 210 : 240, L = 52, R = 12, T = 12, B = 28;
  const max = Math.max(1, ...trend.flatMap((d) => series.map((k) => Number(d[k] ?? 0))));
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
  const x = (i: number) => L + (trend.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (trend.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * nice);
  const step = Math.max(1, Math.ceil(trend.length / Math.max(2, Math.floor((W - L - R) / 80))));
  const COLORS: Record<string, string> = { sales: 'var(--viz-1)', purchases: 'var(--viz-2)' };
  const LABEL: Record<string, string> = { sales: 'Sales', purchases: 'Purchase' };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (W - L - R);
    setHover(Math.max(0, Math.min(trend.length - 1, Math.round((px / (W - L - R)) * (trend.length - 1)))));
  };
  const h = hover === null ? null : trend[hover];
  return (
    <div className="gp-chart">
      <div className="gp-legend">{series.map((k) => <span key={k}><i style={{ background: COLORS[k] }} />{LABEL[k]}</span>)}</div>
      <div className="gp-chart-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.map((k) => LABEL[k]).join(' and ')} per day, ${fmtDay(trend[0]?.day)} to ${fmtDay(trend.at(-1)?.day)}`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gp-grid" />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="gp-axis">{compact(v)}</text>
            </g>
          ))}
          {trend.map((d, i) => ((i % step === 0 && trend.length - 1 - i >= step / 2) || i === trend.length - 1) && (
            <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" className="gp-axis">{fmtDay(d.day).slice(0, 6)}</text>
          ))}
          {series.map((k) => (
            <polyline key={k} fill="none" stroke={COLORS[k]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={trend.map((d, i) => `${x(i)},${y(Number(d[k] ?? 0))}`).join(' ')} />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="gp-crosshair" />
              {series.map((k) => <circle key={k} cx={x(hover)} cy={y(Number(trend[hover][k] ?? 0))} r={4.5} fill={COLORS[k]} stroke="var(--surface)" strokeWidth={2} />)}
            </g>
          )}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {h && hover !== null && (
          <div className="gp-tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <div className="gp-tip-day">{fmtDay(h.day)}</div>
            {series.map((k) => <div key={k}><i style={{ background: COLORS[k] }} /><strong>{money(h[k] ?? '0')}</strong> <span>{LABEL[k]}</span></div>)}
          </div>
        )}
      </div>
      <details className="gp-table-view">
        <summary>Show as a table</summary>
        <div className="ui-table-wrap"><table className="ui-table"><thead><tr><th>Day</th>{series.map((k) => <th key={k} className="ui-money">{LABEL[k]}</th>)}</tr></thead>
          <tbody>{trend.filter((d) => series.some((k) => Number(d[k] ?? 0) !== 0)).map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td>{series.map((k) => <td key={k} className="ui-money">{money(d[k] ?? '0')}</td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}

/** Payment modes as one segmented bar (part of a whole), every part named with its amount and share beside it. */
function PaymentModes({ modes }: { modes: NonNullable<Overview['paymentModes']> }) {
  const parts = modes.filter((m) => Number(m.amount) > 0).sort((a, b) => Number(b.amount) - Number(a.amount));
  const total = parts.reduce((s, m) => s + Number(m.amount), 0);
  const ORDER = ['cash', 'upi', 'card', 'other', 'original'];
  const color = (m: string) => `var(--viz-${(ORDER.indexOf(m) + 1) || 5})`;
  if (!total) return <div className="gp-empty-chart">No payments in these dates.</div>;
  return (
    <div className="gp-modes">
      <div className="gp-modes-total"><span className="gp-kpi-label">Collected</span><span className="gp-modes-sum">{money(String(total))}</span></div>
      <div className="gp-seg" role="img" aria-label={parts.map((m) => `${PAY_METHOD[m.method] ?? m.method} ${Math.round((Number(m.amount) / total) * 100)}%`).join(', ')}>
        {parts.map((m) => <span key={m.method} style={{ flexGrow: Number(m.amount), background: color(m.method) }} title={`${PAY_METHOD[m.method] ?? m.method}: ${money(m.amount)}`} />)}
      </div>
      <ul className="gp-modes-list">
        {parts.map((m) => (
          <li key={m.method}><i style={{ background: color(m.method) }} /><span>{PAY_METHOD[m.method] ?? m.method}</span>
            <strong className="ui-money">{money(m.amount)}</strong><span className="gp-share">{((Number(m.amount) / total) * 100).toFixed(1)}%</span></li>
        ))}
      </ul>
    </div>
  );
}

export function Overview() {
  const today = todayIST();
  const [range, setRange] = useState<[string, string]>([`${today.slice(0, 8)}01`, today]);
  const [locationId, setLocationId] = useState('');
  const [channel, setChannel] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const inView = useOutletInView();   // v2 (D115): the API already counts only this outlet
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true); setError('');
    const qs = new URLSearchParams({ from: range[0], to: range[1], ...(locationId ? { locationId } : {}), ...(channel ? { channel } : {}) });
    api<Overview>(`/dashboard/overview?${qs}`).then((r) => setData(r.data)).catch((e) => setError(errorText(e))).finally(() => setBusy(false));
  }, [range, locationId, channel]);
  useEffect(() => { load(); }, [load]);

  const hasSales = useMemo(() => data?.tiles.some((t) => t.key === 'sales'), [data]);

  return (
    <div className="gp-overview">
      <section className="ui-panel gp-overview-panel" aria-labelledby="ov-title">
        <div className="gp-filters">
          <h2 className="ui-h2" id="ov-title">Overview</h2>
          <DateRange from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
          <label className="gp-filter gp-select">
            <Icon name="pin" size={16} />
            <span className="ui-sr-only">Location</span>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">{inView ? `All at ${inView.name}` : 'All locations'}</option>
              {data?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {locationId && <button type="button" className="gp-clear" onClick={() => setLocationId('')} aria-label="Clear location"><Icon name="close" size={14} /></button>}
          </label>
          {hasSales && (
            <label className="gp-filter gp-select">
              <Icon name="sales" size={16} />
              <span className="ui-sr-only">Channel</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">All channels</option>
                <option value="pos">Counter (POS)</option>
                <option value="woocommerce">Online shop</option>
              </select>
              {channel && <button type="button" className="gp-clear" onClick={() => setChannel('')} aria-label="Clear channel"><Icon name="close" size={14} /></button>}
            </label>
          )}
          <div className="gp-synced">
            <span><span className="gp-synced-label">Last synced</span><span className="gp-synced-at">{data ? fmtStamp(data.lastSyncedAt) : '—'}</span></span>
            <button type="button" className="gp-refresh" onClick={load} disabled={busy} aria-label="Refresh the numbers" aria-busy={busy}><Icon name="refresh" size={17} /></button>
          </div>
        </div>
        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        {!data && !error && <div className="gp-kpis">{Array.from({ length: 10 }, (_, i) => <div key={i} className="gp-kpi"><span className="ui-skeleton" style={{ height: 40 }} /></div>)}</div>}
        {data && (
          <>
            <div className="gp-kpis" aria-busy={busy}>{data.tiles.map((t) => <KpiTile key={t.key} t={t} />)}</div>
            <p className="ui-caption gp-footnote">
              Changes compare {fmtDay(data.from)} – {fmtDay(data.to)} with {fmtDay(data.previous.from)} – {fmtDay(data.previous.to)}.
              Stock figures are as of now. {data.marginNote ?? ''}
            </p>
          </>
        )}
      </section>

      {data && (data.trend || data.paymentModes) && (
        <div className="gp-charts">
          {data.trend && (
            <section className="ui-panel" aria-labelledby="trend-title">
              <div className="ui-panel-head"><h2 className="ui-h3" id="trend-title">Sales &amp; purchase trend</h2><span className="ui-caption" style={{ marginLeft: 'auto' }}>{fmtDay(data.from)} – {fmtDay(data.to)}</span></div>
              <div className="ui-panel-body"><TrendChart trend={data.trend} /></div>
            </section>
          )}
          {data.paymentModes && (
            <section className="ui-panel" aria-labelledby="modes-title">
              <div className="ui-panel-head"><h2 className="ui-h3" id="modes-title">Payment modes</h2><span className="ui-caption" style={{ marginLeft: 'auto' }}>net of refunds</span></div>
              <div className="ui-panel-body"><PaymentModes modes={data.paymentModes} /></div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
