'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { perMonth } from '../../../../../lib/outlets-api';
import { api, errorText, type OutletDetail, type OutletList } from '../../../../../lib/outlets-api';
import { EMPTY, OutletForm, toBody } from '../_components/outlet-form';

// Create outlet (v2, D101): a new shop with its own address, bill numbers and stock rooms.

export default function NewOutletPage() {
  const router = useRouter();
  const [list, setList] = useState<OutletList | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<OutletList>('/outlets').then((r) => setList(r.data)).catch((e) => setError(errorText(e))); }, []);
  const l = list?.limit;
  const full = !!l && l.open >= l.allowed;
  return (
    <div className="ui-content" style={{ maxWidth: 860 }}>
      <div className="ui-page-header">
        <div><Link className="ui-caption" href="/account">Account /</Link><h1 className="ui-h1">Create outlet</h1>
          <div className="ui-caption">A new shop under the same business: its own address, bill numbers, stock rooms and counter.</div></div>
      </div>
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {!list ? <div className="ui-skeleton" style={{ height: 320 }} /> : !list.can.manage ? (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">Only the owner can create outlets.</div></div>
      ) : full ? (
        <div className="ui-alert ui-alert--warning" role="alert"><div className="ui-alert-body">
          Your plan allows {l!.allowed} outlet{l!.allowed === 1 ? '' : 's'} and {l!.open} {l!.open === 1 ? 'is' : 'are'} open. Pay for an extra outlet{perMonth(l!.pricePerOutletMonthPaise) ? ` (${perMonth(l!.pricePerOutletMonthPaise)})` : ''} the same way as your plan and tell us; we switch it on the same working day.
        </div></div>
      ) : (
        <section className="ui-panel"><div className="ui-panel-body">
          <OutletForm initial={EMPTY} states={list.states} mainState={list.mainStateCode} isNew submitLabel="Create outlet"
            onCancel={() => router.push('/account')}
            onSubmit={async (v) => {
              const { data } = await api<OutletDetail>('/outlets', { method: 'POST', body: toBody(v, true) });
              router.push(`/account/outlets/${data.outlet.id}?created=1`);
            }} />
        </div></section>
      )}
    </div>
  );
}
