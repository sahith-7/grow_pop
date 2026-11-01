'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type Step } from '../../../lib/account-api';

// Getting started (B7 onboarding): for owner and manager, until every step is done or they hide it on this device.
const HIDE_KEY = 'getting-started-hidden';

export function GettingStarted() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try { setHidden(localStorage.getItem(HIDE_KEY) === '1'); } catch { setHidden(false); }
    api<{ steps: Step[] }>('/onboarding').then((r) => setSteps(r.data.steps)).catch(() => setSteps([]));
  }, []);
  if (!steps?.length || hidden || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="ui-panel" aria-labelledby="gs-title">
      <div className="ui-panel-head" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <h2 className="ui-h3" id="gs-title" style={{ flex: 1, margin: 0 }}>Getting started · {done} of {steps.length} done</h2>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" type="button"
          onClick={() => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* private window */ } setHidden(true); }}>Hide</button>
      </div>
      <div className="ui-panel-body">
        <progress className="ui-progress" max={steps.length} value={done} aria-label="Steps done" style={{ width: '100%' }} />
        <ol style={{ margin: 'var(--space-3) 0 0', paddingLeft: '1.25rem', display: 'grid', gap: 'var(--space-2)' }}>
          {steps.map((s) => (
            <li key={s.key}>
              {s.done ? <span className="ui-muted"><s>{s.title}</s> ✓</span> : <Link href={s.href}>{s.title}</Link>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
