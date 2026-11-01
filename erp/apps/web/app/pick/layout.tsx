'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MeProvider, type Me } from '@/lib/me';

// The pick screen runs full width, outside the side navigation, so it works on a phone held in one hand (AC-19).
export default function PickLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const router = useRouter();

  useEffect(() => {
    api<Me>('/auth/me').then(setMe).catch(() => router.replace('/login'));
  }, [router]);

  if (!me) return <div className="center muted">Loading…</div>;
  if (me.totp?.setupRequired) return <div className="center"><Link href="/dashboard">Finish protecting the owner account first</Link></div>;
  if (!me.permissions.includes('order.fulfil')) {
    return <div className="ui-content"><div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">Your role cannot pick orders. <Link href="/dashboard">Back to the dashboard</Link></div></div></div>;
  }
  return <MeProvider value={me}>{children}</MeProvider>;
}
