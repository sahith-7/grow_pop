'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MeProvider, type Me } from '@/lib/me';

// The counter screen runs full width, outside the app's side navigation, so the cart and the pay button always fit.
export default function PosLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();

  useEffect(() => {
    api<Me>('/auth/me').then(setMe).catch(() => router.replace('/login'));
  }, [router]);

  if (!me) return <div className="center muted">Loading…</div>;
  if (me.totp?.setupRequired) return <div className="center"><Link href="/dashboard">Finish protecting the owner account first</Link></div>;
  if (!me.permissions.includes('pos.sell')) {
    return <div className="ui-content"><div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">Your role cannot sell at the counter. <Link href="/dashboard">Back to the dashboard</Link></div></div></div>;
  }
  return <MeProvider value={me}>{children}</MeProvider>;
}
