'use client';

import { useEffect, useState } from 'react';
import { api, errorText, type Supplier } from '../../../../lib/stock-api';

/** Active suppliers for a picker (most shops have a few dozen). */
export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ items: Supplier[] }>('/suppliers?limit=100').then((r) => setSuppliers(r.data.items)).catch((e) => { setError(errorText(e)); setSuppliers([]); });
  }, []);
  return { suppliers, error };
}
