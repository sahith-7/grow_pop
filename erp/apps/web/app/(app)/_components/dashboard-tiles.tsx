'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { api, errorText, type Dashboard } from '../../../lib/fulfil-api';
import { dateTime } from '../../../lib/stock-api';
import { ORDER_STATUS } from '../../../lib/woo-api';
import { GettingStarted } from './getting-started';

// Dashboard tiles (B6). The API leaves out every tile the user's role may not see, so this shows only what comes back.
// Add <DashboardTiles /> to Phase 1's dashboard page (see INSTALL-B6.md).

const ATTENTION: { key: keyof NonNullable<Dashboard['attention']>; label: string; href: string }[] = [
  { key: 'ordersNeedingAttention', label: 'Web orders need attention', href: '/orders?status=attention' },
  { key: 'readyToPick', label: 'Ready to pick', href: '/fulfilment?stage=ready_to_pick' },
  { key: 'beingPicked', label: 'Being picked or packed', href: '/fulfilment?stage=picking' },
  { key: 'dispatchUpdatesStuck', label: 'Dispatches the shop has not heard about', href: '/fulfilment?stage=dispatched_pending_web' },
  { key: 'failedSyncJobs', label: 'Failed sync jobs (7 days)', href: '/integrations/woocommerce' },
  { key: 'stocktakesInReview', label: 'Stocktakes to approve', href: '/stocktakes' },
];

export function DashboardTiles() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Dashboard>('/dashboard').then((r) => setD(r.data)).catch((e) => setError(errorText(e))); }, []);

  if (error) return <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>;
  if (!d) return <div className="ui-skeleton" style={{ height: 120 }} />;

  const flags = ATTENTION.filter((a) => d.attention?.[a.key] !== undefined);
  const delta = d.sales ? Number(d.sales.today) - Number(d.sales.yesterday) : 0;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <GettingStarted />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        {d.sales && (
          <Link className="ui-panel ui-kpi" href="/reports?r=sales" style={{ color: 'inherit', textDecoration: 'none' }}>
            <span className="ui-label">Net sales today</span>
            <span className="ui-kpi-value">{money(d.sales.today)}</span>
            <span className="ui-kpi-delta" data-dir={delta > 0 ? 'up' : delta < 0 ? 'down' : undefined}>
              {d.sales.invoicesToday} invoice{d.sales.invoicesToday === 1 ? '' : 's'} · yesterday {money(d.sales.yesterday)}</span>
          </Link>
        )}
        {d.stock && (
          <Link className="ui-panel ui-kpi" href="/reports?r=low-stock" style={{ color: 'inherit', textDecoration: 'none' }}>
            <span className="ui-label">Low stock</span>
            <span className="ui-kpi-value">{d.stock.lowStockCount}</span>
            <span className="ui-kpi-delta">of {d.stock.itemCount} items{d.stock.value !== undefined ? ` · stock value ${money(d.stock.value)}` : ''}</span>
          </Link>
        )}
        {flags.map((a) => (
          <Link key={a.key} className="ui-panel ui-kpi" href={a.href} style={{ color: 'inherit', textDecoration: 'none' }}>
            <span className="ui-label">{a.label}</span>
            <span className="ui-kpi-value" style={d.attention![a.key] && a.key !== 'readyToPick' && a.key !== 'beingPicked' ? { color: 'var(--danger)' } : undefined}>{d.attention![a.key]}</span>
          </Link>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {d.recentSales && (
          <div className="ui-panel">
            <div className="ui-panel-head"><span className="ui-h3">Recent orders</span></div>
            {d.recentSales.length ? d.recentSales.map((o) => {
              const [tone, label] = ORDER_STATUS[o.status] ?? ['', o.status];
              return (
                <div className="ui-list-row" key={o.id}>
                  <span>{o.channel === 'woocommerce' ? <Link href={`/orders/${o.id}`}>#{o.number}</Link> : <>{o.number}</>} <span className="ui-caption">{o.channel === 'pos' ? 'Counter' : 'Web'} · {dateTime(o.placedAt)}</span>
                    {' '}<span className={`ui-badge${tone ? ` ui-badge--${tone}` : ''}`}>{label}</span></span>
                  <span className="ui-money">{money(o.total)}</span>
                </div>
              );
            }) : <div className="ui-panel-body ui-muted">No sales yet.</div>}
          </div>
        )}
        {d.bestSellers && (
          <div className="ui-panel">
            <div className="ui-panel-head"><span className="ui-h3">Best sellers, last 30 days</span></div>
            {d.bestSellers.length ? d.bestSellers.map((b, i) => (
              <div className="ui-list-row" key={i}><span>{b.name}{b.sku && <span className="ui-caption ui-code"> {b.sku}</span>}</span><span className="ui-num">{b.qty}</span></div>
            )) : <div className="ui-panel-body ui-muted">No invoiced sales yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
