'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { MeProvider, type Me } from '@/lib/me';
import { SubscriptionBanner } from './_components/subscription-banner';
import { TotpSetup } from './_components/totp-setup';

// Items appear only for roles holding the permission. The API enforces the same rules; this is convenience, not security.
// `perm` may list several permissions; any one of them shows the item.
const NAV: { href: string; label: string; perm: string | string[] | null }[] = [
  { href: '/dashboard', label: 'Dashboard', perm: null },
  { href: '/pos', label: 'Counter (POS)', perm: 'pos.sell' },
  { href: '/invoices', label: 'Invoices', perm: 'invoice.read' },
  { href: '/returns', label: 'Returns', perm: 'return.manage' },
  { href: '/products', label: 'Products', perm: 'product.read' },
  { href: '/orders', label: 'Online orders', perm: 'order.read' },
  { href: '/fulfilment', label: 'Fulfilment', perm: 'order.fulfil' },
  { href: '/stock', label: 'Stock', perm: 'stock.read' },
  { href: '/stocktakes', label: 'Stocktakes', perm: 'stocktake.count' },
  { href: '/purchasing', label: 'Purchasing', perm: ['purchase.manage', 'purchase.receive'] },
  { href: '/suppliers', label: 'Suppliers', perm: 'purchase.manage' },
  { href: '/reports', label: 'Reports', perm: 'report.view' },
  { href: '/team', label: 'Team', perm: 'users.read' },
  { href: '/integrations/woocommerce', label: 'WooCommerce', perm: 'sync.manage' },
  { href: '/billing', label: 'Billing & GST', perm: 'settings.read' },
  { href: '/settings', label: 'Settings', perm: 'settings.read' },
  { href: '/audit', label: 'Audit log', perm: 'audit.read' },
  { href: '/account', label: 'Account', perm: 'account.manage' },
  { href: '/security', label: 'Password and sign-in', perm: null },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();
  const path = usePathname();

  const load = useCallback(() => api<Me>('/auth/me').then(setMe).catch(() => router.replace('/login')), [router]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setMenuOpen(false); }, [path]);

  if (!me) return <div className="center muted">Loading…</div>;

  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); router.replace('/login'); };

  // D83: an owner without an authenticator app sees only the setup until it is done (the API refuses everything else).
  if (me.totp.setupRequired) {
    return (
      <main className="auth">
        <div className="card stack" style={{ maxWidth: 520 }}>
          <TotpSetup required onDone={load} />
          <button className="btn" type="button" onClick={signOut}>Sign out</button>
        </div>
      </main>
    );
  }

  return (
    <MeProvider value={me}>
      <div className="shell">
        <aside className="side" data-open={menuOpen}>
          <div className="side-head">
            <div className="brand">{me.tenant.name}<small>{BRAND.name}</small></div>
            <button className="btn menu-toggle" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>Menu</button>
          </div>
          <nav className="nav" aria-label="Main">
            {NAV.filter((n) => !n.perm || [n.perm].flat().some((p) => me.permissions.includes(p))).map((n) => (
              <Link key={n.href} href={n.href} aria-current={path === n.href || path.startsWith(`${n.href}/`) ? 'page' : undefined}>{n.label}</Link>
            ))}
          </nav>
        </aside>
        <div>
          <header className="top">
            <span className="muted small">{me.user.name} · {me.user.role}</span>
            <button className="btn" onClick={signOut}>Sign out</button>
          </header>
          <main className="content"><SubscriptionBanner />{children}</main>
        </div>
      </div>
    </MeProvider>
  );
}
