'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { api, type Till } from '../../../../lib/cash-api';

// Shared pieces of the Cash control pages (v2 phase 3): the tabs, the tills, and short/over. The outlet in view is the
// switcher in the top bar (D115); the API applies it to /tills, /registers and /cash-book.

const TABS = [
  { href: '/cash', label: 'Registers' }, { href: '/cash/book', label: 'Cash book' }, { href: '/cash/tills', label: 'Tills' }, { href: '/cash/methods', label: 'Payment methods' },
];

export function CashTabs() {
  const path = usePathname();
  return (
    <nav className="ui-tabs" aria-label="Cash control">
      {TABS.map((t) => <Link key={t.href} href={t.href} className="ui-tab" aria-selected={path === t.href} aria-current={path === t.href ? 'page' : undefined}>{t.label}</Link>)}
    </nav>
  );
}

/** The tills at the outlet in view (or every outlet this person sees), and those outlets. */
export function useTills() {
  const [tills, setTills] = useState<Till[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api<{ items: Till[] }>('/tills').then((r) => { setTills(r.data.items); setError(''); }).catch((e) => setError(e instanceof Error ? e.message : 'Something went wrong'));
  useEffect(() => { load(); }, []);
  const outlets = tills ? [...new Map(tills.map((t) => [t.outletId, { id: t.outletId, name: t.outlet }])).values()] : undefined;
  return { tills, outlets, error, reload: load };
}

/** Short (less cash than there should be) or over. */
export function Diff({ value }: { value: string | null }) {
  if (value === null) return <span className="ui-muted">—</span>;
  const n = Number(value);
  if (n === 0) return <span className="ui-badge ui-badge--success">Matched</span>;
  return <span className={n < 0 ? 'gp-diff-short' : 'gp-diff-over'}>{n < 0 ? 'Short ' : 'Over '}{money(value.replace('-', ''))}</span>;
}
