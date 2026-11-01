'use client';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { useCan, useMe } from '@/lib/me';

type User = { id: string; email: string; name: string; role: string; status: 'invited' | 'active' | 'disabled' };
const ROLES: [string, string][] = [
  ['manager', 'Manager: everything except the shop’s keys, voids and the account'],
  ['cashier', 'Cashier: counter sales, returns, invoices'],
  ['inventory', 'Inventory: products, stock, counts, receiving'],
  ['fulfillment', 'Fulfilment: picking and dispatching web orders'],
];
const STATUS: Record<User['status'], string> = { invited: 'Invited', active: 'Active', disabled: 'Disabled' };

export default function Team() {
  const me = useMe();
  const manage = useCan('users.manage');
  const [users, setUsers] = useState<User[] | null>(null);
  const [seats, setSeats] = useState<{ max: number; used: number } | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => Promise.all([
    api<User[]>('/users').then(setUsers),
    api<{ max: number; used: number }>('/users/seats').then(setSeats),
  ]).catch((e) => setError(errorText(e))), []);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setError(''); setNote(''); setFields({});
    try { await fn(); setNote(ok); await load(); return true; }
    catch (e) { setError(errorText(e)); if (e instanceof ApiError) setFields(e.fieldErrors); return false; }
    finally { setBusy(false); }
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (await run(() => api('/users/invite', { method: 'POST', body: f }), `Invitation e-mailed to ${f.email}. The link works for 3 days.`)) form.reset();
  }

  if (!users) return error ? <div className="alert error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Team</h1>
        {seats && <span className="muted">{seats.used} of {seats.max} people on your plan</span>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {note && <div className="alert ok" role="status">{note}</div>}
      <table className="table">
        <thead><tr><th>Name</th><th>E-mail</th><th>Role</th><th>Status</th>{manage && <th />}</tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}{u.id === me.user.id && <span className="muted"> (you)</span>}</td>
              <td>{u.email}</td>
              <td>{manage && u.role !== 'owner' && u.status !== 'disabled' ? (
                <select className="input" aria-label={`Role of ${u.name}`} value={u.role} disabled={busy}
                  onChange={(e) => run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.name} is now ${e.target.value}. They were signed out.`)}>
                  {ROLES.map(([r]) => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : u.role}</td>
              <td>{STATUS[u.status]}</td>
              {manage && (
                <td className="row">
                  {u.role !== 'owner' && u.status === 'invited' && (
                    <button className="btn" type="button" disabled={busy} onClick={() => run(() => api(`/users/${u.id}/resend-invite`, { method: 'POST' }), 'Invitation sent again.')}>Resend</button>
                  )}
                  {u.role !== 'owner' && u.status !== 'disabled' && (
                    <button className="btn" type="button" disabled={busy}
                      onClick={() => confirm(`Disable ${u.name}? They are signed out at once.`) && run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { status: 'disabled' } }), `${u.name} is disabled.`)}>Disable</button>
                  )}
                  {u.role !== 'owner' && u.status === 'disabled' && (
                    <button className="btn" type="button" disabled={busy} onClick={() => run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), `${u.name} is enabled again.`)}>Enable</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <form className="card stack" onSubmit={invite}>
          <h2 style={{ margin: 0 }}>Invite someone</h2>
          <div className="grid2">
            <label>Name<input className="input" name="name" required maxLength={120} />{fields.name?.map((t) => <span key={t} className="field-error">{t}</span>)}</label>
            <label>E-mail<input className="input" name="email" type="email" required maxLength={200} />{fields.email?.map((t) => <span key={t} className="field-error">{t}</span>)}</label>
            <label>Role
              <select className="input" name="role" defaultValue="cashier">{ROLES.map(([r, label]) => <option key={r} value={r}>{label}</option>)}</select>
            </label>
          </div>
          <div><button className="btn primary" type="submit" disabled={busy}>Send invitation</button></div>
        </form>
      )}
    </div>
  );
}
