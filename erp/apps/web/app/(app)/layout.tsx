'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MeProvider, type Me } from '@/lib/me';
import { readOutletCookie, writeOutletCookie } from '@/lib/outlet-scope';
import { OutletSwitcher, Sidebar, TopBar } from './_components/shell';
import { SubscriptionBanner } from './_components/subscription-banner';
import { TotpSetup } from './_components/totp-setup';

// The signed-in frame (v2, D92): top bar and grouped side menu in _components/shell.tsx. The menu itself is lib/nav.ts.
// v2 (D115): switching the outlet in view saves it (lib/outlet-scope), reloads who-am-I, and remounts the page so every
// list and tile loads again for the new outlet.

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState(0);
  const router = useRouter();
  const path = usePathname();

  const load = useCallback(() => api<Me>('/auth/me').then(setMe).catch(() => router.replace('/login')), [router]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setMenuOpen(false); }, [path]);
  const switchOutlet = useCallback(async (id: string) => { writeOutletCookie(id); await load(); setView((v) => v + 1); }, [load]);
  // The choice is per browser, so another tab may have changed it. Coming back to this tab, follow it, so the switcher and
  // the figures on screen always agree.
  useEffect(() => {
    if (!me || me.outlets.items.length < 2) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const c = readOutletCookie();
      const now = me.outlets.items.some((o) => o.id === c) ? c : '';
      if (now !== (me.outlets.current ?? '')) load().then(() => setView((v) => v + 1));
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [me, load]);

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
      <div className="gp-app">
        <TopBar me={me} onMenu={() => setMenuOpen(true)} onSignOut={signOut} onOutlet={switchOutlet} />
        <div className="gp-body">
          <Sidebar me={me} open={menuOpen} onClose={() => setMenuOpen(false)} />
          <main className="content gp-content" key={view}><OutletSwitcher me={me} onSwitch={switchOutlet} variant="strip" /><SubscriptionBanner />{children}</main>
        </div>
      </div>
    </MeProvider>
  );
}
