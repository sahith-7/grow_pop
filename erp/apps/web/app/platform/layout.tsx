'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BRAND } from '@/lib/brand';
import { papi } from '@/lib/platform-api';

// The platform console's frame (B7). Not part of any store: its own sign-in, no store menu.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ email: string; name: string } | null>(null);
  const isLogin = path === '/platform/login';
  useEffect(() => { if (!isLogin) papi<{ email: string; name: string }>('/me').then(setMe).catch(() => {}); }, [isLogin]);

  if (isLogin) return <main className="ui-content" style={{ maxWidth: 420, margin: '10vh auto' }}>{children}</main>;
  if (!me) return <div className="center muted">Loading…</div>;
  return (
    <div>
      <header className="ui-topbar" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', flexWrap: 'wrap' }}>
        <strong>{BRAND.name} console</strong>
        <nav aria-label="Console" style={{ display: 'flex', gap: 'var(--space-3)', flex: 1 }}>
          <Link href="/platform" aria-current={path === '/platform' ? 'page' : undefined}>Stores</Link>
          <Link href="/platform/audit" aria-current={path === '/platform/audit' ? 'page' : undefined}>Console log</Link>
        </nav>
        <span className="ui-muted">{me.email}</span>
        <button className="ui-btn ui-btn--sm" type="button" onClick={async () => { await papi('/logout', { method: 'POST' }).catch(() => {}); router.replace('/platform/login'); }}>Sign out</button>
      </header>
      <main className="ui-content">{children}</main>
    </div>
  );
}
