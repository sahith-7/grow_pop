'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { fmtDate } from '../../../lib/datetime';
import { money } from '../../../lib/format';
import { HitRow, searchHits, Suggestions, useSuggest, type SearchHit } from '../../../lib/suggest';
import { useCan } from '../../../lib/me';
import { api, errorText, type Contact, type ContactType, type State } from '../../../lib/contacts-api';
import { ContactForm } from './_components/contact-form';

// Contacts (v2, D96): customers and suppliers, each with a total and the date they last bought or supplied.
// Owners and managers see this page; a cashier finds a customer at the till instead.

function ContactsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const type: ContactType = params.get('type') === 'supplier' ? 'supplier' : 'customer';
  const [q, setQ] = useState(params.get('q') ?? '');
  const sg = useSuggest<SearchHit>({ q, load: (t) => searchHits(t, [type === 'supplier' ? 'supplier' : 'customer']) });
  const openHit = (h: SearchHit) => router.push(h.href);
  const [items, setItems] = useState<Contact[] | null>(null);
  const [states, setStates] = useState<State[]>([]);
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const canAdd = useCan(type === 'customer' ? 'pos.sell' : 'purchase.manage');
  const canExport = useCan('report.export');
  const archived = params.get('archived') === 'true';

  const load = async (cursor?: string) => {
    setError('');
    const qs = new URLSearchParams({ type, limit: '50' });
    if (params.get('q')) qs.set('q', params.get('q')!);
    if (archived) qs.set('includeArchived', 'true');
    if (cursor) qs.set('cursor', cursor);
    try {
      const { data } = await api<{ items: Contact[]; nextCursor: string | null; states: State[] }>(`/contacts?${qs}`);
      setItems(data.items); setNext(data.nextCursor); setStates(data.states);
    } catch (e) { setError(errorText(e)); setItems([]); }
  };
  useEffect(() => { setItems(null); setCursors([]); setQ(params.get('q') ?? ''); load(); }, [params]);

  const apply = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`/contacts?${p}`);
  };
  const filtered = !!params.get('q');

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Contacts</h1>
          <div className="ui-caption">Everyone you sell to and buy from, with what they bought or supplied.</div></div>
        <div className="ui-actions">
          {canExport && <a className="ui-btn" href={`/api/v1/exports/contacts.csv?type=${type}`} download>Export CSV</a>}
          {canAdd && <button className="ui-btn ui-btn--primary" type="button" onClick={() => setAdding(true)}>Add {type}</button>}
        </div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}

      <div className="ui-tabs" role="tablist">
        <button className="ui-tab" role="tab" type="button" aria-selected={type === 'customer'} onClick={() => apply({ type: '', q: '', archived: '' })}>Customers</button>
        <button className="ui-tab" role="tab" type="button" aria-selected={type === 'supplier'} onClick={() => apply({ type: 'supplier', q: '', archived: '' })}>Suppliers</button>
      </div>

      <div className="ui-panel">
        <form className="ui-toolbar" role="search" onSubmit={(e) => { e.preventDefault(); apply({ q: q.trim() }); }}>
          <div className="gp-suggest">
            <input className="ui-input ui-search" placeholder="Name, phone, email or GSTIN" aria-label={`Search ${type}s`} value={q} onChange={(e) => setQ(e.target.value)}
              {...sg.inputProps} onKeyDown={(e) => sg.onKeyDown(e, openHit)} />
            <Suggestions s={sg} onPick={openHit} render={(h) => <HitRow hit={h} />} label={`Matching ${type}s`} />
          </div>
          <button className="ui-btn" type="submit">Search</button>
          {type === 'supplier' && <button className="ui-chip" type="button" aria-pressed={archived} onClick={() => apply({ archived: archived ? '' : 'true' })}>Show archived</button>}
        </form>
        {items === null ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div>
          : items.length === 0 ? (
            <div className="ui-empty">
              <p className="ui-h3">{filtered ? 'Nothing matches' : type === 'customer' ? 'No customers yet' : 'No suppliers yet'}</p>
              {!filtered && <p className="ui-muted">{type === 'customer'
                ? 'Customers are added at the till when a bill needs a name, and from web orders.'
                : 'Add the people you buy stock from, then raise purchase orders to them.'}</p>}
            </div>
          ) : (
            <div className="ui-table-wrap"><table className="ui-table" data-collapse>
              <thead>{type === 'customer'
                ? <tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col" className="ui-num">Bills</th><th scope="col" className="ui-money">Bought</th><th scope="col">Last bill</th></tr>
                : <tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col" className="ui-num">Receipts</th><th scope="col" className="ui-money">Received</th><th scope="col">Last receipt</th></tr>}
              </thead>
              <tbody>{items.map((c) => (
                <tr key={c.id}>
                  <td data-primary>
                    <Link className="ui-cell-title" href={`/contacts/${type}s/${c.id}`}>{c.name}</Link>
                    {c.archived && <span className="ui-badge" style={{ marginLeft: 6 }}>archived</span>}
                    {c.type === 'customer' && c.fromWooCommerce && <span className="ui-badge ui-badge--info" style={{ marginLeft: 6 }}>web</span>}
                    {(c.gstin || c.email) && <div className="ui-cell-sub">{c.gstin ?? c.email}</div>}
                  </td>
                  <td data-label="Phone">{c.phone ?? <span className="ui-muted">—</span>}</td>
                  {c.type === 'customer' ? <>
                    <td className="ui-num" data-label="Bills">{c.stats.orders}</td>
                    <td className="ui-money" data-label="Bought">{money(c.stats.net)}
                      {Number(c.stats.returned) > 0 && <div className="ui-cell-sub">after {money(c.stats.returned)} returned</div>}</td>
                  </> : <>
                    <td className="ui-num" data-label="Receipts">{c.stats.receipts}
                      {c.stats.openPurchaseOrders > 0 && <div className="ui-cell-sub">{c.stats.openPurchaseOrders} open PO{c.stats.openPurchaseOrders > 1 ? 's' : ''}</div>}</td>
                    <td className="ui-money" data-label="Received">{c.stats.purchased === null ? <span className="ui-muted">—</span> : money(c.stats.purchased)}</td>
                  </>}
                  <td data-label={type === 'customer' ? 'Last bill' : 'Last receipt'}>{c.stats.lastAt ? fmtDate(c.stats.lastAt) : <span className="ui-muted">Never</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        <div className="ui-pager">
          <span>{items?.length ? `${items.length} shown` : ''}</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!cursors.length}
              onClick={() => { const prev = cursors.slice(0, -1); setCursors(prev); load(prev.at(-1)); }}>Previous</button>
            <button className="ui-btn ui-btn--sm" type="button" disabled={!next}
              onClick={() => { setCursors([...cursors, next!]); load(next!); }}>Next</button>
          </div>
        </div>
      </div>

      {adding && <ContactForm type={type} contact={null} states={states} onClose={() => setAdding(false)}
        onSaved={(id) => { setAdding(false); router.push(`/contacts/${type}s/${id}`); }} />}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="ui-content"><div className="ui-skeleton" style={{ height: 240 }} /></div>}><ContactsPage /></Suspense>;
}
