'use client';
import Link from 'next/link';
import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { BRAND } from '@/lib/brand';

// Every signed-out screen: /login, /register, /forgot, /reset?token=…, /invite?token=…
type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'invite';
const TITLE: Record<Mode, string> = {
  login: 'Sign in', register: 'Create your store', forgot: 'Reset your password', reset: 'Choose a new password', invite: 'Join your team',
};

export default function AuthPage() {
  return <Suspense fallback={null}><AuthForm /></Suspense>;
}

function AuthForm() {
  const { mode } = useParams<{ mode: string }>();
  if (!(mode in TITLE)) notFound();
  const m = mode as Mode;
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [sent, setSent] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setError(''); setFields({});
    try {
      if (challenge) {
        await api('/auth/login/code', { method: 'POST', body: { challenge, code: f.code } });
        router.replace('/dashboard');
      } else if (m === 'login') {
        const r = await api<{ ok?: boolean; totpRequired?: boolean; challenge?: string }>('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } });
        if (r.totpRequired && r.challenge) setChallenge(r.challenge);
        else router.replace('/dashboard');
      } else if (m === 'register') {
        if (f.password !== f.confirm) { setFields({ confirm: ['The passwords don’t match'] }); return; }
        await api('/auth/register', { method: 'POST', body: { businessName: f.businessName, name: f.name, email: f.email, password: f.password } });
        router.replace('/dashboard');
      } else if (m === 'forgot') {
        await api('/auth/forgot-password', { method: 'POST', body: { email: f.email } });
        setSent(true);
      } else {
        if (f.password !== f.confirm) { setFields({ confirm: ['The passwords don’t match'] }); return; }
        await api(m === 'reset' ? '/auth/reset-password' : '/auth/accept-invite', { method: 'POST', body: { token, password: f.password } });
        router.replace('/dashboard');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHALLENGE_EXPIRED') setChallenge(null);
      setError(errorText(err));
      if (err instanceof ApiError) setFields(err.fieldErrors);
    } finally { setBusy(false); }
  }

  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>{label}
      <input className="input" name={name} required aria-invalid={fields[name] ? true : undefined} {...props} />
      {fields[name]?.map((t) => <span key={t} className="field-error">{t}</span>)}
    </label>
  );
  const newPassword = (
    <>
      {field('password', 'Password', { type: 'password', autoComplete: 'new-password', minLength: 12 })}
      <span className="muted small">At least 12 characters. A short sentence is easiest to remember.</span>
      {field('confirm', 'Same password again', { type: 'password', autoComplete: 'new-password', minLength: 12 })}
    </>
  );

  return (
    <main className="auth">
      <div className="card stack">
        <div className="auth-brand"><img src="/icon.svg" alt="" />{BRAND.name}</div>
        <h1 style={{ margin: 0 }}>{challenge ? 'Enter your code' : TITLE[m]}</h1>
        {error && <div className="alert error" role="alert">{error}</div>}
        {sent ? (
          <div className="alert ok" role="status">If that e-mail has an account, a reset link is on its way. It works for 1 hour.</div>
        ) : (
          <form className="stack" onSubmit={submit} noValidate={false}>
            {challenge ? (
              <>
                <p className="muted" style={{ margin: 0 }}>Open your authenticator app and type the 6-digit code for {BRAND.name}.</p>
                {field('code', 'Code', { inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9]{6}', maxLength: 6, autoFocus: true })}
              </>
            ) : (
              <>
                {m === 'register' && field('businessName', 'Store name', { autoComplete: 'organization', maxLength: 120 })}
                {m === 'register' && field('name', 'Your name', { autoComplete: 'name', maxLength: 120 })}
                {(m === 'login' || m === 'register' || m === 'forgot') && field('email', 'E-mail', { type: 'email', autoComplete: 'email', maxLength: 200 })}
                {m === 'login' && field('password', 'Password', { type: 'password', autoComplete: 'current-password' })}
                {(m === 'register' || m === 'reset' || m === 'invite') && newPassword}
                {(m === 'reset' || m === 'invite') && !token && <div className="alert error">This link is incomplete. Open it again from the e-mail.</div>}
              </>
            )}
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : challenge ? 'Sign in' : TITLE[m]}</button>
          </form>
        )}
        <div className="row small">
          {m === 'login' && <><Link href="/forgot">Forgot password?</Link><span className="muted">·</span><Link href="/register">Create a store</Link></>}
          {m !== 'login' && <Link href="/login">Back to sign in</Link>}
        </div>
      </div>
    </main>
  );
}
