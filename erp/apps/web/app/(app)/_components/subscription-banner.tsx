'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, contact, day, daysLeft, type Subscription } from '../../../lib/account-api';

// The store's state, above every screen (B7). Quiet while active; a trial shows only in its last 14 days.
// Staff see what is happening; only the owner gets the link to pay.

export function SubscriptionBanner() {
  const [s, setS] = useState<Subscription | null>(null);
  useEffect(() => { api<Subscription>('/subscription').then((r) => setS(r.data)).catch(() => {}); }, []);
  if (!s) return null;

  const pay = s.can.manage ? <> <Link href="/account">How to pay</Link>.</> : <> Ask the store owner to pay.</>;
  let tone = 'info', text: React.ReactNode = null;
  if (s.state === 'trial' && daysLeft(s.trialEndsAt) <= 14) {
    text = <>Free trial: {daysLeft(s.trialEndsAt)} day{daysLeft(s.trialEndsAt) === 1 ? '' : 's'} left (until {day(s.trialEndsAt)}).{pay}</>;
  } else if (s.state === 'past_due') {
    tone = 'warning';
    text = <>Payment is due. Everything works until {day(s.suspendsAt)}; after that the store becomes read-only.{pay}</>;
  } else if (s.state === 'suspended') {
    tone = 'danger';
    text = <>Your store is read-only because payment is overdue. You can see everything but cannot sell or make changes. Web orders are still received.{pay}</>;
  } else if (s.state === 'closed') {
    tone = 'danger';
    text = <>This store is closed.{s.can.manage ? <> You can download all its data until {day(s.exportUntil)} from <Link href="/account">Account</Link>.</> : ''} Questions: {contact(s.support)}.</>;
  }
  if (!text) return null;
  return <div className={`ui-alert ui-alert--${tone}`} role="status" style={{ marginBottom: 'var(--space-4)' }}><div className="ui-alert-body">{text}</div></div>;
}
