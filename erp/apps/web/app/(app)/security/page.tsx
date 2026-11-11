'use client';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { useMe } from '@/lib/me';
import { TotpSetup } from '../_components/totp-setup';

export default function Security() {
  const me = useMe();
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);
  const [totpOn, setTotpOn] = useState(me.totp.enabled);

  async function change(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError(''); setFields({}); setSaved(false);
    if (f.newPassword !== f.confirm) { setFields({ confirm: ['The passwords don’t match'] }); return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
      setSaved(true); form.reset();
    } catch (err) { setError(errorText(err)); if (err instanceof ApiError) setFields(err.fieldErrors); }
  }

  const input = (name: string, label: string, autoComplete: string) => (
    <label>{label}
      <input className="input" type="password" name={name} autoComplete={autoComplete} required minLength={name === 'currentPassword' ? 1 : 12} />
      {fields[name]?.map((t) => <span key={t} className="field-error">{t}</span>)}
    </label>
  );

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <form className="card stack" onSubmit={change}>
        <h1 style={{ margin: 0 }}>Change password</h1>
        {error && <div className="alert error" role="alert">{error}</div>}
        {saved && <div className="alert ok" role="status">Password changed. Other devices were signed out.</div>}
        {input('currentPassword', 'Current password', 'current-password')}
        {input('newPassword', 'New password (12+ characters)', 'new-password')}
        {input('confirm', 'New password again', 'new-password')}
        <div><button className="btn primary" type="submit">Change password</button></div>
      </form>
      {me.permissions.includes('pos.discount_approve') && <ApprovalPin />}
      {me.user.role === 'owner' && (
        <div className="card stack">
          {totpOn ? (
            <><h2 style={{ margin: 0 }}>Authenticator app</h2><div className="alert ok">On. Signing in as owner asks for a code from your phone.</div></>
          ) : <TotpSetup onDone={() => setTotpOn(true)} />}
        </div>
      )}
    </div>
  );
}

/**
 * The PIN an owner or manager types on a cashier's screen to approve a discount above the cashier's limit (v2, D107).
 * Setting it asks for the account password, because a PIN is worth money at the counter.
 */
function ApprovalPin() {
  const [status, setStatus] = useState<{ set: boolean; locked: boolean; switchedOff?: boolean } | null>(null);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState('');
  useEffect(() => { api<{ set: boolean; locked: boolean; switchedOff?: boolean }>('/pos/pin').then(setStatus).catch(() => {}); }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError(''); setFields({}); setSaved('');
    if (f.pin !== f.pin2) { setFields({ pin2: ['The PINs don’t match'] }); return; }
    try { setStatus(await api('/pos/pin', { method: 'PUT', body: { pin: f.pin, password: f.password } })); setSaved('PIN saved. Use it on a cashier’s screen to approve a discount.'); form.reset(); }
    catch (err) { setError(errorText(err)); if (err instanceof ApiError) setFields(err.fieldErrors); }
  }
  async function remove() {
    if (!window.confirm('Remove your PIN? You can still approve from the Approvals page.')) return;
    try { setStatus(await api('/pos/pin', { method: 'DELETE' })); setSaved('PIN removed.'); } catch (err) { setError(errorText(err)); }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2 style={{ margin: 0 }}>Discount approval PIN</h2>
      <p className="muted" style={{ margin: 0 }}>When a cashier gives a discount above their limit, you can approve it on their screen with this PIN, or from Discount approvals on your phone.
        {status?.set ? ' Your PIN is set.' : ' You have no PIN yet.'}{status?.switchedOff ? ' It was switched off after 15 wrong tries in a row at a till: set a new one to use it again.' : status?.locked ? ' It is locked for a few minutes after wrong tries; saving a new one unlocks it.' : ''}</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {saved && <div className="alert ok" role="status">{saved}</div>}
      <label>{status?.set ? 'New PIN (4 to 6 digits)' : 'PIN (4 to 6 digits)'}
        <input className="input" type="password" name="pin" inputMode="numeric" autoComplete="off" required pattern="[0-9]{4,6}" maxLength={6} />
        {fields.pin?.map((t) => <span key={t} className="field-error">{t}</span>)}</label>
      <label>PIN again
        <input className="input" type="password" name="pin2" inputMode="numeric" autoComplete="off" required pattern="[0-9]{4,6}" maxLength={6} />
        {fields.pin2?.map((t) => <span key={t} className="field-error">{t}</span>)}</label>
      <label>Your password
        <input className="input" type="password" name="password" autoComplete="current-password" required />
        {fields.password?.map((t) => <span key={t} className="field-error">{t}</span>)}</label>
      <div style={{ display: 'flex', gap: 8 }}><button className="btn primary" type="submit">{status?.set ? 'Change PIN' : 'Set PIN'}</button>
        {status?.set && <button className="btn" type="button" onClick={remove}>Remove PIN</button>}</div>
    </form>
  );
}
