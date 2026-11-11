'use client';
import { useMe } from '@/lib/me';
import { useOutletInView } from '@/lib/outlet-scope';
import { DashboardTiles } from '../_components/dashboard-tiles';
import { Overview } from '../_components/overview';

// v2 (D90): Overview (date range, location, channel, last synced, tiles, trend, payment modes) on top; the B6 "today and
// needs attention" tiles, recent orders and best sellers below it.
export default function Dashboard() {
  const me = useMe();
  const inView = useOutletInView();
  return (
    <div className="ui-content" style={{ padding: 0 }}>
      <div className="ui-page-header">
        <div>
          <h1 className="ui-h1">Dashboard</h1>
          <p className="ui-caption" style={{ margin: 0 }}>Hello, {me.user.name.split(' ')[0]}. Here is how {inView ? <strong>{inView.name}</strong> : me.tenant.name} is doing{inView ? '' : me.outlets.items.length > 1 ? (me.outlets.all ? ', all outlets together' : ', your outlets together') : ''}.</p>
        </div>
      </div>
      <Overview />
      <h2 className="ui-h2" style={{ marginTop: 'var(--space-2)' }}>Today and needs attention</h2>
      <DashboardTiles />
    </div>
  );
}
