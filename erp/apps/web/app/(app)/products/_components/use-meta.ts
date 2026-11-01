'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '../../../../lib/catalog-api';
import type { Meta } from './product-form';

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Meta>('/catalog/meta').then((r) => setMeta(r.data)).catch((e) => setError(errorText(e))); }, []);
  return { meta, error };
}
