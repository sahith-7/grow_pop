'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BRAND } from '@/lib/brand';
import { papi, perr } from '@/lib/platform-api';

export default function PlatformLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="ui-panel" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('');
      try { await papi('/login', { method: 'POST', body: { email, password, code } }); router.replace('/platform'); }
      catch (err) { setError(perr(err)); setCode(''); } finally { setBusy(false); }
    }}>
      <div className="ui-panel-head"><h1 className="ui-h2" style={{ margin: 0 }}>{BRAND.name} console</h1></div>
      <div className="ui-panel-body" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p className="ui-muted" style={{ margin: 0 }}>For the people who run the service. Store owners sign in on the normal sign-in page.</p>
        {error && <div className="ui-alert ui-alert--danger" role="alert"><div className="ui-alert-body">{error}</div></div>}
        <label className="ui-field"><span className="ui-label">E-mail</span>
          <input className="ui-input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="ui-field"><span className="ui-label">Password</span>
          <input className="ui-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label className="ui-field"><span className="ui-label">Code from your authenticator app</span>
          <input className="ui-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="ui-btn ui-btn--primary" type="submit" disabled={busy} aria-busy={busy}>Sign in</button>
      </div>
    </form>
  );
}
