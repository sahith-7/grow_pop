'use client';
import QRCode from 'qrcode';
import { useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { BRAND } from '@/lib/brand';

// Owner's authenticator app (D83): scan the QR code (or type the key), then confirm with the first 6-digit code.
export function TotpSetup({ required, onDone }: { required?: boolean; onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true); setError('');
    try {
      const r = await api<{ secret: string; otpauthUri: string }>('/auth/totp/start', { method: 'POST' });
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 400 }) });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setBusy(true); setError('');
    try { await api('/auth/totp/confirm', { method: 'POST', body: { code } }); onDone(); }
    catch (err) { setError(err instanceof ApiError ? (err.fieldErrors.code?.[0] ?? err.message) : errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Protect the owner account</h1>
      <p className="muted" style={{ margin: 0 }}>
        {required ? 'Before you continue, ' : ''}add {BRAND.name} to an authenticator app on your phone (Google Authenticator,
        Microsoft Authenticator, Aegis or 1Password). From then on, signing in as owner needs your password and the 6-digit code
        from the app, so a stolen password alone can’t open your store.
      </p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!setup ? (
        <button className="btn primary" type="button" disabled={busy} onClick={start}>Start setup</button>
      ) : (
        <form className="stack" onSubmit={confirm}>
          <img className="qr" src={setup.qr} alt="QR code for your authenticator app" />
          <span className="small muted">Can’t scan? Choose “Enter a setup key” in the app and type:</span>
          <span className="code">{setup.secret.match(/.{1,4}/g)?.join(' ')}</span>
          <label>6-digit code from the app
            <input className="input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>Turn on</button>
          <span className="small muted">Lost your phone later? Contact support: we confirm it’s you before resetting it.</span>
        </form>
      )}
    </div>
  );
}
