'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { money } from '../../../../../lib/format';
import { fmtDateTime, fmtTime } from '../../../../../lib/datetime';
import { api, DENOMINATIONS, errorText, MOVEMENT_LABEL, MOVEMENT_STATUS, type Counts, type Register } from '../../../../../lib/cash-api';
import { Diff } from '../../_components/cash-ui';

// One register (v2 phase 3, D110, D112): the day at one till, from the opening count to the closing count. The owner's
// notification and e-mail link here.

function CountTable({ counts, title }: { counts: Counts | null; title: string }) {
  if (!counts) return null;
  const rows = DENOMINATIONS.filter((d) => (counts[d] ?? 0) > 0);
  return (
    <div>
      <div className="ui-label" style={{ marginBottom: 'var(--space-1)' }}>{title}</div>
      {rows.map((d) => <div key={d} className="gp-reg-line"><span>₹{d} × {counts[d]}</span><span className="ui-money">{money(String((counts[d] ?? 0) * Number(d)))}</span></div>)}
      {counts.other && Number(counts.other) > 0 && <div className="gp-reg-line"><span>Other</span><span className="ui-money">{money(counts.other)}</span></div>}
    </div>
  );
}

export default function RegisterPage() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Register | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Register>(`/registers/${id}`).then((x) => setR(x.data)).catch((e) => setError(errorText(e))); }, [id]);
  if (!r) return <div className="ui-content">{error ? <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div> : <div className="ui-skeleton" style={{ height: 320 }} />}</div>;
  const t = r.totals;
  const line = (label: string, v: string, sign = '') => <div className="gp-reg-line"><span>{label}</span><span className="ui-money">{sign}{money(v)}</span></div>;

  return (
    <div className="ui-content">
      <div className="gp-crumbs"><Link href="/cash">Cash control</Link> / {r.till.name}</div>
      <div className="ui-page-header">
        <div><h1 className="ui-h1">{r.till.name} · {r.outlet.name}</h1>
          <div className="ui-caption">Opened {fmtDateTime(r.openedAt)} by {r.openedBy}{r.closedAt ? ` · closed ${fmtDateTime(r.closedAt)} by ${r.closedBy}` : ''}</div></div>
        <div className="ui-actions">{r.status === 'open' ? <span className="ui-badge ui-badge--info">Open now</span> : <Diff value={r.difference} />}</div>
      </div>

      <div className="gp-kpis" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="gp-kpi"><span className="gp-kpi-label">Sales</span><span className="gp-kpi-value">{money(t.sales)}</span><span className="ui-cell-sub">{t.bills} bill{t.bills === 1 ? '' : 's'}</span></div>
        <div className="gp-kpi" data-family="green"><span className="gp-kpi-label">Should be in the drawer</span><span className="gp-kpi-value">{money(r.status === 'open' ? t.expected : r.expectedCash)}</span></div>
        {r.status === 'closed' && <div className="gp-kpi" data-family={Number(r.difference) === 0 ? 'green' : 'amber'}><span className="gp-kpi-label">Counted</span><span className="gp-kpi-value">{money(r.countedCash)}</span><span className="ui-cell-sub"><Diff value={r.difference} /></span></div>}
        {r.status === 'closed' && <div className="gp-kpi" data-family="violet"><span className="gp-kpi-label">Left for the next shift</span><span className="gp-kpi-value">{money(r.keptCash)}</span></div>}
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <div className="ui-panel"><div className="ui-panel-head"><h2 className="ui-h3">Cash</h2></div><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div className="gp-reg-sum">
            {line('Cash at opening', t.opening)}{line('Cash sales', t.cashSales, '+ ')}{line('Cash given back', t.cashRefunds, '− ')}
            {line('Cash added', t.cashIn, '+ ')}{line('Cash taken out', t.cashOut, '− ')}{line('Expenses', t.expenses, '− ')}
            <div className="gp-reg-line" data-strong><span>Should be in the drawer</span><span className="ui-money">{money(r.status === 'open' ? t.expected : r.expectedCash)}</span></div>
            {r.status === 'closed' && <div className="gp-reg-line"><span>Counted</span><span className="ui-money">{money(r.countedCash)}</span></div>}
          </div>
          {r.expectedOpening !== null && r.expectedOpening !== r.openingCash && <div className="ui-caption">The last closing left {money(r.expectedOpening)}; opened with {money(r.openingCash)}: “{r.openingNote}”</div>}
          {r.closeNote && <div className="ui-caption">Reason given at closing: “{r.closeNote}”</div>}
          {!!t.lapsedExpenses && <div className="ui-caption">{t.lapsedExpenses} expense{t.lapsedExpenses === 1 ? '' : 's'} still waiting at closing {t.lapsedExpenses === 1 ? 'was' : 'were'} not paid.</div>}
        </div></div>

        <div className="ui-panel"><div className="ui-panel-head"><h2 className="ui-h3">Takings by method</h2></div><div className="ui-panel-body">
          {t.methods.length === 0 ? <span className="ui-muted">No payments.</span> : t.methods.map((m) => (
            <div key={m.name} className="gp-reg-line"><span>{m.name}{m.payments ? ` · ${m.payments} payment${m.payments === 1 ? '' : 's'}` : ''}</span>
              <span className="ui-money">{money(m.received)}{Number(m.refunded) > 0 ? ` (− ${money(m.refunded)} back)` : ''}</span></div>
          ))}
        </div></div>

        {(r.openingCounts || r.closingCounts) && (
          <div className="ui-panel"><div className="ui-panel-head"><h2 className="ui-h3">Notes and coins</h2></div><div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <CountTable counts={r.openingCounts} title={`At opening (${money(r.openingCash)})`} />
            <CountTable counts={r.closingCounts} title={`At closing (${money(r.countedCash)})`} />
          </div></div>
        )}
      </div>

      <div className="ui-panel" style={{ marginTop: 'var(--space-4)' }}>
        <div className="ui-panel-head"><h2 className="ui-h3">Cash added, taken out and expenses</h2></div>
        {r.movements.length === 0 ? <div className="ui-empty"><p className="ui-muted" style={{ margin: 0 }}>None.</p></div> : (
          <div className="ui-table-wrap"><table className="ui-table" data-collapse>
            <thead><tr><th scope="col">Time</th><th scope="col">What</th><th scope="col">Details</th><th scope="col">By</th><th scope="col" className="ui-money">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>{r.movements.map((m) => (
              <tr key={m.id}>
                <td data-primary className="ui-nowrap">{fmtTime(m.recordedAt)}</td>
                <td data-label="What">{MOVEMENT_LABEL[m.kind]}<div className="ui-cell-sub">{m.category}</div></td>
                <td data-label="Details">{m.reason}</td>
                <td data-label="By">{m.recordedBy}</td>
                <td className="ui-money" data-label="Amount">{m.kind === 'cash_in' ? '+ ' : '− '}{money(m.amount)}</td>
                <td data-label="Status"><span className={`ui-badge ui-badge--${MOVEMENT_STATUS[m.status].tone}`}>{MOVEMENT_STATUS[m.status].label}</span>
                  {m.decidedBy && <div className="ui-cell-sub">{m.decidedBy}{m.decidedVia === 'pin' ? ' (PIN at the till)' : ''}{m.note ? ` · “${m.note}”` : ''}</div>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
