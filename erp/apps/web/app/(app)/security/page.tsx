'use client';
import { useState } from 'react';
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
