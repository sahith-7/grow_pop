import { expect, test } from '@playwright/test';
import { newStore, totp } from './fixtures';

const admin = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD, secret: process.env.E2E_ADMIN_TOTP_SECRET };

test.skip(!admin.email || !admin.password || !admin.secret, 'needs E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET');

test('console: suspend makes the store read-only; a UPI payment makes it active', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const store = await newStore(page);
  const consoleCtx = await browser.newContext();
  const c = await consoleCtx.newPage();
  await c.goto('/platform/login');
  await c.getByLabel('E-mail').fill(admin.email!);
  await c.getByLabel('Password').fill(admin.password!);
  // A code is accepted once; wait for a fresh 30-second step so a parallel run's code is not reused.
  await c.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  await c.getByLabel('Code from your authenticator app').fill(totp(admin.secret!));
  await c.getByRole('button', { name: 'Sign in' }).click();
  await expect(c.getByRole('heading', { name: 'Stores' })).toBeVisible();

  await c.getByLabel('Search name, store code or owner e-mail').fill(store.name);
  await c.getByRole('link', { name: store.name }).click();
  await c.getByRole('combobox', { name: /^Action/ }).selectOption({ label: 'Make read-only (suspend)' });
  await c.getByLabel('Reason (kept in the log)').fill('e2e suspend');
  await c.getByRole('button', { name: 'Apply' }).click();
  await expect(c.getByText('Read-only', { exact: true }).first()).toBeVisible();

  await page.goto('/pos');
  await expect(page.getByText(/Your store is read-only because payment is overdue/)).toBeVisible();

  await c.getByLabel('Amount received (₹)').fill('1178.82');
  await c.getByLabel('Transaction id (UTR) or reference').fill(`E2E${Date.now()}`);
  await c.getByRole('button', { name: 'Record payment' }).click();
  await expect(c.getByText('Active', { exact: true }).first()).toBeVisible();
  await expect(c.getByRole('cell', { name: /^R-\d{6}$/ })).toBeVisible();

  await page.goto('/account');
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^R-\d{6}$/ })).toBeVisible();
  await consoleCtx.close();
});
