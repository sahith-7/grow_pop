import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

// Passwords: argon2id with OWASP's minimum (19 MiB, 2 passes). Tokens: 256 random bits, stored only as SHA-256.
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON);

/** False for a wrong password or an unreadable hash; never throws. */
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);

/** Spends the same time as a real check, so a wrong e-mail can't be told apart from a wrong password by timing. */
const DUMMY = argon2.hash('timing-equaliser-not-a-password', ARGON);
export const burnPasswordCheck = async (password: string) => { await verifyPassword(await DUMMY, password); };

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest();
