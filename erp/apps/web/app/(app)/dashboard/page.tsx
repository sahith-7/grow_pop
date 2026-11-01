'use client';
import { useMe } from '@/lib/me';
import { DashboardTiles } from '../_components/dashboard-tiles';

export default function Dashboard() {
  const me = useMe();
  return (
    <div className="ui-content" style={{ padding: 0 }}>
      <div className="ui-page-header"><h1 className="ui-h1">Hello, {me.user.name.split(' ')[0]}</h1></div>
      <DashboardTiles />
    </div>
  );
}
