'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from '../../../lib/format';
import { fmtDateTime } from '../../../lib/datetime';
import { api, errorText, type RegisterRow } from '../../../lib/cash-api';
import { useOutletScope } from '../../../lib/outlet-scope';
import { CashTabs, Diff, useTills } from './_components/cash-ui';

// Registers (v2 phase 3, D110): every till's drawer, open now or closed in the last days, with what should have been in it
// and what was counted. For the owner and managers; the outlet in view (the switcher in the top bar, D115), or all of them.

export default function RegistersPage() {
  const router = useRouter();
  const { outlets } = useTills();
  const scope = useOutletScope();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<RegisterRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setRows(null);
    api<{ items: RegisterRow[] }>(`/registers?days=${days}${scope ? `&outletId=${scope}` : ''}`).then((r) => { setRows(r.data.items); setError(''); }).catch((e) => setError(errorText(e)));
  }, [days, scope]);
  const many = (outlets?.length ?? 0) > 1;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Cash control</h1><div className="ui-caption">Each till’s drawer: counted when it opens and when it closes. A difference needs a reason, and you get the totals when a register closes.</div></div>
      </div>
      <CashTabs />
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      <div className="ui-panel">
        <div className="ui-toolbar">
          <span className="ui-label">Closed in the last</span>
          <div className="ui-segmented" role="group" aria-label="Closed in the last">
            {[1, 7, 30, 90].map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{d === 1 ? 'day' : `${d} days`}</button>)}
          </div>
        </div>
        {!rows ? <div className="ui-panel-body"><div className="ui-skeleton" style={{ height: 160 }} /></div> : rows.length === 0 ? (
          <div className="ui-empty"><p className="ui-h3">No registers yet</p><p className="ui-muted">A cashier opens one at the counter by counting the drawer before the first bill.</p></div>
        ) : (
          <div className="ui-table-wrap"><table className="ui-table" data-collapse>
            <thead><tr><th scope="col">Till</th><th scope="col">Opened</th><th scope="col">Closed</th><th scope="col" className="ui-money">Sales</th>
              <th scope="col" className="ui-money">Should be</th><th scope="col" className="ui-money">Counted</th><th scope="col">Difference</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/cash/registers/${r.id}`)}>
                <td data-primary><Link href={`/cash/registers/${r.id}`} className="ui-cell-title" onClick={(e) => e.stopPropagation()}>{r.till}</Link>{many && <div className="ui-cell-sub">{r.outlet}</div>}</td>
                <td data-label="Opened">{fmtDateTime(r.openedAt)}<div className="ui-cell-sub">{r.openedBy}</div></td>
                <td data-label="Closed">{r.status === 'open' ? <span className="ui-badge ui-badge--info">Open now</span> : <>{fmtDateTime(r.closedAt)}<div className="ui-cell-sub">{r.closedBy}</div></>}</td>
                <td className="ui-money" data-label="Sales">{money(r.sales)}<div className="ui-cell-sub">{r.bills} bill{r.bills === 1 ? '' : 's'}</div></td>
                <td className="ui-money" data-label="Should be">{money(r.expected)}</td>
                <td className="ui-money" data-label="Counted">{money(r.counted)}</td>
                <td data-label="Difference"><Diff value={r.difference} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <p className="ui-help" style={{ marginTop: 'var(--space-4)' }}>Should be = cash at opening + cash sales − cash given back + cash added − cash taken out − expenses paid. Rules for billing without a register and expense limits are in <Link href="/billing">Billing &amp; GST</Link>.</p>
    </div>
  );
}
