'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { Icon } from '@/lib/icons';
import type { Me } from '@/lib/me';
import { allowed, CREATE, NAV, screens } from '@/lib/nav';

// The v2 app frame (D92): a full-width top bar (brand, search, outlet in view, + New, POS, account menu) over a grouped
// side menu.

/** The menu entry for a page: the longest menu link the path starts with (/products/123 → Products, /products/labels → Barcode labels). */
const ALL_HREFS = NAV.flatMap((g) => (g.items ? g.items.map((i) => i.href) : [g.href!])).sort((a, b) => b.length - a.length);
const bestMatch = (path: string) => ALL_HREFS.find((h) => path === h || path.startsWith(`${h}/`));

export function Wordmark() {
  return (
    <Link href="/dashboard" className="gp-wordmark" aria-label={`${BRAND.name} home`}>
      <img src="/icon.svg" alt="" width={28} height={28} />
      <span>{BRAND.name}</span>
    </Link>
  );
}

export function Sidebar({ me, open, onClose }: { me: Me; open: boolean; onClose: () => void }) {
  const path = usePathname();
  const best = bestMatch(path);
  const isCurrent = (_: string, href: string) => href === best;
  const groups = NAV.map((g) => ({ ...g, items: g.items?.filter((i) => allowed(i.perm, me.permissions)) }))
    .filter((g) => (g.items ? g.items.length > 0 : allowed(g.perm, me.permissions)));
  const activeGroup = groups.find((g) => g.items?.some((i) => isCurrent(path, i.href)))?.key;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (k: string) => expanded[k] ?? k === activeGroup;

  return (
    <>
      {open && <div className="gp-scrim" onClick={onClose} aria-hidden="true" />}
      <aside className="gp-side" data-open={open || undefined} aria-label="Main menu">
        <div className="gp-side-store">
          <span className="gp-store-dot" aria-hidden="true">{me.tenant.name.slice(0, 1).toUpperCase()}</span>
          <span className="gp-store-name">{me.tenant.name}</span>
        </div>
        <div className="gp-eyebrow">Navigate</div>
        <nav className="gp-nav">
          {groups.map((g) => g.items ? (
            <div key={g.key} className="gp-group">
              <button type="button" className="gp-nav-item" aria-expanded={isOpen(g.key)} data-active={g.key === activeGroup || undefined}
                onClick={() => setExpanded({ ...expanded, [g.key]: !isOpen(g.key) })}>
                <Icon name={g.icon} /><span>{g.label}</span><Icon name="chevronRight" size={16} className="gp-chev" />
              </button>
              {isOpen(g.key) && (
                <div className="gp-sub">
                  {g.items.map((i) => (
                    <Link key={i.href} href={i.href} aria-current={isCurrent(path, i.href) ? 'page' : undefined}>{i.label}</Link>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Link key={g.key} href={g.href!} className="gp-nav-item" aria-current={isCurrent(path, g.href!) ? 'page' : undefined}>
              <Icon name={g.icon} /><span>{g.label}</span>
            </Link>
          ))}
        </nav>
      </aside>
    </>
  );
}

/**
 * The outlet switcher (v2, D115): which outlet the back office shows, "All outlets" or one. Shown when this person can see
 * more than one outlet: in the top bar on a computer, as a strip above the page on a phone. A single outlet chosen is
 * tinted, so a filtered dashboard is never mistaken for the whole store.
 */
export function OutletSwitcher({ me, onSwitch, variant }: { me: Me; onSwitch: (id: string) => void; variant: 'top' | 'strip' }) {
  const o = me.outlets;
  // Staff tied to one outlet: nothing to switch, but say where they are.
  if (!o.all && o.items.length === 1) {
    return (
      <div className={variant === 'top' ? 'gp-outlet' : 'gp-outlet-strip'} data-scoped="" title="The outlet you work at">
        {variant === 'strip' && <span className="gp-outlet-label">Showing</span>}
        <span className="gp-outlet-box gp-outlet-fixed"><Icon name="store" size={16} className="gp-outlet-icon" /><span>{o.items[0].name}</span></span>
      </div>
    );
  }
  if (o.items.length < 2) return null;
  const select = (
    <select value={o.current ?? ''} onChange={(e) => onSwitch(e.target.value)} aria-label="Outlet in view">
      <option value="">{o.all ? 'All outlets' : 'All my outlets'}</option>
      {o.items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.isMain ? ' (main)' : ''}{x.active ? '' : ' (closed)'}</option>)}
    </select>
  );
  return (
    <div className={variant === 'top' ? 'gp-outlet' : 'gp-outlet-strip'} data-scoped={o.current ? '' : undefined}
      title={variant === 'top' ? 'Which outlet the dashboard, bills, stock, reports and cash show' : undefined}>
      {variant === 'strip' && <span className="gp-outlet-label">Showing</span>}
      <span className="gp-outlet-box"><Icon name="store" size={16} className="gp-outlet-icon" />{select}<Icon name="chevronDown" size={15} className="gp-outlet-chev" /></span>
    </div>
  );
}

interface Hit { kind: string; id: string; title: string; subtitle: string | null; href: string }

/** "Jump to anywhere": screens the user may open, plus products, invoices, orders and suppliers from the API. Ctrl+K / ⌘K. */
export function SearchPalette({ me, onClose }: { me: Me; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => screens(me.permissions), [me.permissions]);
  const needle = q.trim().toLowerCase();
  const pages = (needle ? all.filter((s) => `${s.label} ${s.group} ${s.keywords ?? ''}`.toLowerCase().includes(needle)) : all).slice(0, needle ? 6 : 8);
  const results = [...pages.map((p) => ({ kind: p.group || 'Page', id: p.href, title: p.label, subtitle: null, href: p.href })), ...hits];

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    setSel(0);
    if (needle.length < 2) { setHits([]); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api<{ items: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.items)).catch(() => setHits([])).finally(() => setBusy(false));
    }, 220);
    return () => clearTimeout(t);
  }, [q, needle]);

  const go = (href: string) => { onClose(); router.push(href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); go(results[sel].href); }
  };

  return (
    <div className="ui-backdrop gp-palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gp-palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="gp-palette-input">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Jump to a screen, or search products, customers, invoices…"
            aria-label="Search" role="combobox" aria-expanded="true" aria-controls="gp-results" aria-activedescendant={results[sel] ? `gp-r-${sel}` : undefined} autoComplete="off" />
          <kbd className="ui-kbd">Esc</kbd>
        </div>
        <ul className="gp-results" id="gp-results" role="listbox">
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.id}`} id={`gp-r-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(r.href)}>
              <span className="gp-r-kind">{r.kind}</span><span className="gp-r-title">{r.title}</span>
              {r.subtitle && <span className="gp-r-sub">{r.subtitle}</span>}
            </li>
          ))}
          {!results.length && <li className="gp-r-empty">{busy ? 'Searching…' : 'Nothing found'}</li>}
        </ul>
      </div>
    </div>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

interface Note { id: string; kind: string; title: string; body: string; link: string | null; createdAt: string; read: boolean }

/**
 * The bell (v2 phase 3, D112): what the store tells the owner, such as a register closed with its cash short or over. The
 * count is checked every minute while the app is open; the list loads when the bell is opened.
 */
function Bell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Note[] | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') api<{ unread: number }>('/notifications/count').then((r) => setUnread(r.unread)).catch(() => {}); };
    check();
    const t = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, []);
  const load = () => api<{ unread: number; items: Note[] }>('/notifications').then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => setItems([]));
  const toggle = () => { setOpen((o) => !o); if (!open) load(); };
  const read = (ids?: string[]) => api<{ unread: number }>('/notifications/read', { method: 'POST', body: ids ? { ids } : {} })
    .then((r) => { setUnread(r.unread); setItems((xs) => xs?.map((x) => (!ids || ids.includes(x.id) ? { ...x, read: true } : x)) ?? null); }).catch(() => {});
  const go = (n: Note) => { if (!n.read) read([n.id]); setOpen(false); if (n.link) router.push(n.link); };
  const when = (v: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(v));
  return (
    <div className="gp-pop" ref={ref}>
      <button className="gp-icon-btn gp-bell" type="button" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}
        aria-label={unread ? `Notifications: ${unread} unread` : 'Notifications'} title="Notifications">
        <Icon name="bell" size={18} />{unread > 0 && <span className="gp-badge-dot" aria-hidden>{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="ui-menu gp-menu gp-menu--right gp-notes" role="dialog" aria-label="Notifications">
          <div className="gp-notes-head"><strong>Notifications</strong>
            {unread > 0 && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => read()}>Mark all read</button>}</div>
          {items === null ? <div style={{ padding: 'var(--space-3)' }}><span className="ui-skeleton" style={{ height: 48, display: 'block' }} /></div>
            : items.length === 0 ? <div className="ui-muted" style={{ padding: 'var(--space-3)' }}>Nothing yet. When a register closes, its totals show here.</div>
            : items.map((n) => (
              <button key={n.id} type="button" className="gp-note" data-unread={!n.read || undefined} onClick={() => go(n)}>
                <span className="gp-note-title">{n.title}</span><span className="gp-note-body">{n.body}</span><span className="gp-note-when">{when(n.createdAt)}{n.read ? '' : ' · new'}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Discount requests waiting for this owner or manager (v2, D107), checked every 20 seconds while the app is open. */
function useWaitingApprovals(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const check = () => { if (document.visibilityState === 'visible') api<{ waiting: number }>('/approvals/count').then((r) => setN(r.waiting)).catch(() => {}); };
    check();
    const t = setInterval(check, 20_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); };
  }, [on]);
  return n;
}

export function TopBar({ me, onMenu, onSignOut, onOutlet }: { me: Me; onMenu: () => void; onSignOut: () => void; onOutlet: (id: string) => void }) {
  const [search, setSearch] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const path = usePathname();
  const closeNew = useCallback(() => setNewOpen(false), []);
  const closeUser = useCallback(() => setUserOpen(false), []);
  const newRef = useDismiss(newOpen, closeNew);
  const userRef = useDismiss(userOpen, closeUser);
  const creatable = CREATE.filter((c) => allowed(c.perm, me.permissions));
  const canSell = me.permissions.includes('pos.sell');
  const waiting = useWaitingApprovals(me.permissions.includes('pos.discount_approve'));
  // Letters only: "Kiran (KPHB stock)" is KK, not K(.
  const initials = (me.user.name.match(/\p{L}+/gu) ?? ['?']).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  useEffect(() => { setNewOpen(false); setUserOpen(false); setSearch(false); }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="gp-top">
      <button className="gp-icon-btn gp-menu-btn" type="button" onClick={onMenu} aria-label="Open menu"><Icon name="menu" /></button>
      <Wordmark />
      <button className="gp-search" type="button" onClick={() => setSearch(true)} aria-label="Search (Ctrl+K)">
        <Icon name="search" size={17} /><span className="gp-search-text">Jump to anywhere or search</span><kbd className="ui-kbd">Ctrl+K</kbd>
      </button>
      <OutletSwitcher me={me} onSwitch={onOutlet} variant="top" />
      <div className="gp-top-actions">
        {creatable.length > 0 && (
          <div className="gp-pop" ref={newRef}>
            <button className="ui-btn ui-btn--primary gp-new" type="button" aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen((o) => !o)}>
              <Icon name="plus" size={16} /><span>New</span>
            </button>
            {newOpen && (
              <div className="ui-menu gp-menu" role="menu">
                {creatable.map((c) => <Link key={c.href + c.label} role="menuitem" href={c.href}>{c.label}</Link>)}
              </div>
            )}
          </div>
        )}
        {me.permissions.includes('pos.discount_approve') && (
          <Link className="gp-icon-btn gp-approvals-btn" href="/approvals" title={waiting ? `${waiting} request${waiting === 1 ? '' : 's'} waiting (discounts, expenses)` : 'Approvals'}
            aria-label={waiting ? `Approvals: ${waiting} waiting` : 'Approvals'}>
            <Icon name="approve" size={18} />{waiting > 0 && <span className="gp-badge-dot" aria-hidden>{waiting > 9 ? '9+' : waiting}</span>}
          </Link>
        )}
        {me.user.role === 'owner' && <Bell />}
        {canSell && <Link className="gp-pos-btn" href="/pos" title="Open the counter (POS)"><Icon name="pos" size={17} /><span>POS</span></Link>}
        <div className="gp-pop" ref={userRef}>
          <button className="gp-avatar" type="button" aria-haspopup="menu" aria-expanded={userOpen} onClick={() => setUserOpen((o) => !o)} aria-label={`Account menu for ${me.user.name}`}>{initials}</button>
          {userOpen && (
            <div className="ui-menu gp-menu gp-menu--right" role="menu">
              <div className="gp-menu-head"><strong>{me.user.name}</strong><span>{me.user.email}</span><span className="gp-role">{me.user.role} · {me.tenant.name}</span></div>
              <Link role="menuitem" href="/security">Password & sign-in</Link>
              {me.permissions.includes('account.manage') && <Link role="menuitem" href="/account">Account & plan</Link>}
              {me.permissions.includes('settings.read') && <Link role="menuitem" href="/settings">Store settings</Link>}
              <button role="menuitem" type="button" onClick={onSignOut}><Icon name="signOut" size={16} /> Sign out</button>
            </div>
          )}
        </div>
      </div>
      {search && <SearchPalette me={me} onClose={() => setSearch(false)} />}
    </header>
  );
}
