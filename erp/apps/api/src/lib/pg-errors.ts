
/** Turn a unique-violation on a known constraint into the API error the user can act on; rethrow anything else. */
export function mapUniqueViolation(e: unknown, map: Record<string, () => Error>): never {
  const err = e as { code?: string; constraint?: string };
  if (err?.code === '23505' && err.constraint && map[err.constraint]) throw map[err.constraint]();
  throw e;
}
