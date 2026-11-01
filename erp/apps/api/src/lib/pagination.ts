import { z } from 'zod';
import { appError } from './phase1.js';

export const limitParam = z.coerce.number().int().min(1).max(100).default(25);

/** Opaque cursor = base64url(JSON of the last row's sort key). Only ever decoded into a typed tuple. */
export function encodeCursor(key: unknown[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor<T extends z.ZodTypeAny>(cursor: string | undefined, shape: T): z.infer<T> | null {
  if (!cursor) return null;
  try {
    return shape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw appError(400, 'VALIDATION_ERROR', 'Invalid cursor', { cursor: ['Invalid cursor'] });
  }
}
