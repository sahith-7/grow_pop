'use client';
import { createContext, useContext } from 'react';

export interface Me {
  user: { id: string; name: string; email: string; role: string };
  tenant: { id: string; name: string };
  permissions: string[];
  totp: { enabled: boolean; setupRequired: boolean };
  /** v2 (D115): the outlets this person may look at (main first), whether that is all of them, and the one in view. */
  outlets: { items: { id: string; name: string; isMain: boolean; active: boolean }[]; all: boolean; current: string | null };
}

const MeContext = createContext<Me | null>(null);
export const MeProvider = MeContext.Provider;

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside MeProvider');
  return me;
}

/** UI convenience only: the API checks the same permission on every request. */
export const useCan = (permission: string) => useContext(MeContext)?.permissions.includes(permission) ?? false;
