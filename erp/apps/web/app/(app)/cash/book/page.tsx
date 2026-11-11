'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { money } from '../../../../lib/format';
import { fmtDay, fmtTime, todayIST } from '../../../../lib/datetime';
import { api, errorText, MOVEMENT_LABEL, MOVEMENT_STATUS, type CashBook } from '../../../../lib/cash-api';
import { useOutletInView, useOutletScope } from '../../../../lib/outlet-scope';
import { CashTabs, Diff, useTills } from '../_components/cash-ui';

// The day's cash book (v2 phase 3, D110): every register open that day at the outlet in view (D115) or all of them, with the day's
// drawer movements and expenses.

export default function CashBookPage() {
  const { outlets } = useTills();
  const scope = useOutletScope();
  const inView = useOutletInView();
  const [day, setDay] = useState(todayIST());
  const [book, setBook] = useState<CashBook | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBook(null);
    api<CashBook>(`/cash-book?date=${day}${scope ? `&outletId=${scope}` : ''}`).then((r) => { setBook(r.data); setError(''); }).catch((e) => setError(errorText(e)));
  }, [day, scope]);
  const many = (outlets?.length ?? 0) > 1 && !scope;
  const tot = book?.totals;

  return (
    <div className="ui-content">
      <div className="ui-page-header">
        <div><h1 className="ui-h1">Cash book</h1><div className="ui-caption">{fmtDay(day)}{inView ? ` · ${inView.name}` : many ? ' · all outlets' : ''}</div></div>
        <div className="ui-actions">
          <label className="ui-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}><span className="ui-label">Day</span>
            <input className="ui-input" type="date" value={day} max={todayIST()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        </div>
      </div>
      <CashTabs />
      {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
      {!book || !tot ? <div className="ui-skeleton" style={{ height: 240 }} /> : (
        <>
          <div className="gp-kpis" style={{ marginBottom: 'var(--space-4)' }}>
            <div className="gp-kpi"><span className="gp-kpi-label">Cash sales</span><span className="gp-kpi-value">{money(tot.cashSales)}</span><span className="ui-cell-sub">− {money(tot.cashRefunds)} given back</span></div>
            <div className="gp-kpi" data-family="amber"><span className="gp-kpi-label">Expenses</span><span className="gp-kpi-value">{money(tot.expenses)}</span></div>
            <div className="gp-kpi" data-family="violet"><span className="gp-kpi-label">Added / taken out</span><span className="gp-kpi-value">{money(tot.cashIn)}</span><span className="ui-cell-sub">− {money(tot.cashOut)} taken out</span></div>
            <div className="gp-kpi" data-family={Number(tot.difference) === 0 ? 'green' : 'rose'}><span className="gp-kpi-label">Closed registers</span><span className="gp-kpi-value">{money(tot.counted)}</span><span className="ui-cell-sub"><Diff value={tot.difference} /></span></div>
          </div>

          <div className="ui-panel">
            <div className="ui-panel-head"><h2 className="ui-h3">Registers</h2></div>
            {book.registers.length === 0 ? <div className="ui-empty"><p className="ui-muted" style={{ margin: 0 }}>No register was open on this day.</p></div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Till</th><th scope="col" className="ui-money">Opening</th><th scope="col" className="ui-money">Cash sales</th><th scope="col" className="ui-money">Given back</th>
                  <th scope="col" className="ui-money">Added</th><th scope="col" className="ui-money">Taken out</th><th scope="col" className="ui-money">Expenses</th>
                  <th scope="col" className="ui-money">Should be</th><th scope="col" className="ui-money">Counted</th><th scope="col">Difference</th></tr></thead>
                <tbody>{book.registers.map((r) => (
                  <tr key={r.id}>
                    <td data-primary><Link href={`/cash/registers/${r.id}`} className="ui-cell-title">{r.till}</Link>
                      <div className="ui-cell-sub">{many ? `${r.outlet} · ` : ''}{r.openedBy} {fmtTime(r.openedAt)}{r.closedAt ? ` – ${fmtTime(r.closedAt)}` : ' · open'}</div></td>
                    <td className="ui-money" data-label="Opening">{money(r.opening)}</td>
                    <td className="ui-money" data-label="Cash sales">{money(r.cashSales)}</td>
                    <td className="ui-money" data-label="Given back">{money(r.cashRefunds)}</td>
                    <td className="ui-money" data-label="Added">{money(r.cashIn)}</td>
                    <td className="ui-money" data-label="Taken out">{money(r.cashOut)}</td>
                    <td className="ui-money" data-label="Expenses">{money(r.expenses)}</td>
                    <td className="ui-money" data-label="Should be">{money(r.expected)}</td>
                    <td className="ui-money" data-label="Counted">{money(r.counted)}</td>
                    <td data-label="Difference"><Diff value={r.difference} />{r.closeNote && <div className="ui-cell-sub">“{r.closeNote}”</div>}</td>
                  </tr>
                ))}</tbody>
                {book.registers.length > 1 && <tfoot><tr className="gp-total-row">
                  <th scope="row">Total</th><td className="ui-money" data-label="Opening">{money(tot.opening)}</td><td className="ui-money" data-label="Cash sales">{money(tot.cashSales)}</td><td className="ui-money" data-label="Given back">{money(tot.cashRefunds)}</td>
                  <td className="ui-money" data-label="Added">{money(tot.cashIn)}</td><td className="ui-money" data-label="Taken out">{money(tot.cashOut)}</td><td className="ui-money" data-label="Expenses">{money(tot.expenses)}</td>
                  <td className="ui-money" data-label="Should be">{money(tot.expected)}</td><td className="ui-money" data-label="Counted">{money(tot.counted)}</td><td data-label="Difference"><Diff value={tot.difference} /></td></tr></tfoot>}
              </table></div>
            )}
          </div>

          <div className="ui-panel" style={{ marginTop: 'var(--space-4)' }}>
            <div className="ui-panel-head"><h2 className="ui-h3">Expenses and cash added or taken out</h2></div>
            {book.movements.length === 0 ? <div className="ui-empty"><p className="ui-muted" style={{ margin: 0 }}>None on this day.</p></div> : (
              <div className="ui-table-wrap"><table className="ui-table" data-collapse>
                <thead><tr><th scope="col">Time</th><th scope="col">What</th><th scope="col">Details</th><th scope="col">Till</th><th scope="col">By</th><th scope="col" className="ui-money">Amount</th><th scope="col">Status</th></tr></thead>
                <tbody>{book.movements.map((m) => (
                  <tr key={m.id}>
                    <td data-primary className="ui-nowrap">{fmtTime(m.recordedAt)}</td>
                    <td data-label="What">{MOVEMENT_LABEL[m.kind]}<div className="ui-cell-sub">{m.category}</div></td>
                    <td data-label="Details">{m.reason}</td>
                    <td data-label="Till">{m.till}{many ? <div className="ui-cell-sub">{m.outlet}</div> : null}</td>
                    <td data-label="By">{m.recordedBy}</td>
                    <td className="ui-money" data-label="Amount">{m.kind === 'cash_in' ? '+ ' : '− '}{money(m.amount)}</td>
                    <td data-label="Status"><span className={`ui-badge ui-badge--${MOVEMENT_STATUS[m.status].tone}`}>{MOVEMENT_STATUS[m.status].label}</span>
                      {m.decidedBy && <div className="ui-cell-sub">{m.decidedBy}{m.note ? ` · “${m.note}”` : ''}</div>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
