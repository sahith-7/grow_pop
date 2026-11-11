'use client';
import { useEffect, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { useCan } from '@/lib/me';

type S = Record<string, string | null>;
const TEXT: [string, string][] = [
  ['name', 'Store name'], ['legalName', 'Legal business name'], ['gstin', 'GSTIN'], ['phone', 'Phone'], ['email', 'Contact email'],
  ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['postalCode', 'Postal code'],
  ['locale', 'Locale'], ['currency', 'Currency'],
];

export default function Settings() {
  const canManage = useCan('settings.manage');
  const [s, setS] = useState<S | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => { api<S>('/settings').then(setS).catch((e) => setError(errorText(e))); }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setFieldErrors({}); setSaved(false);
    const { plan, ...body } = Object.fromEntries(new FormData(e.currentTarget) as unknown as Iterable<[string, string]>) as S;
    try { setS(await api<S>('/settings', { method: 'PATCH', body })); setSaved(true); }
    catch (err) { setError(errorText(err)); if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors); }
  }

  if (!s) return error ? <div className="alert error">{error}</div> : <p className="muted">Loading…</p>;
  return (
    <form className="card stack" onSubmit={save}>
      <h1>Store settings</h1>
      <div className="grid2">
        {TEXT.map(([k, label]) => (
          <label key={k}>{label}
            <input className="input" name={k} defaultValue={s[k] ?? ''} disabled={!canManage} />
            {fieldErrors[k]?.map((t) => <span key={t} className="field-error">{t}</span>)}
          </label>
        ))}
        <label>Date and time
          {/* v2 (D93): India only, so always IST; saving also repairs a store that had another zone. */}
          <input className="input" value="India Standard Time (IST, UTC+5:30)" readOnly disabled />
          <input type="hidden" name="timezone" value="Asia/Kolkata" />
        </label>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {saved && <div className="alert ok">Settings saved.</div>}
      {canManage && <div><button className="btn primary">Save changes</button></div>}
    </form>
  );
}
