import { expect, test } from '@playwright/test';
import { newStore } from './fixtures';

test('getting started, trial plan, data export and support access', async ({ page }) => {
  await newStore(page);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Getting started/ })).toBeVisible();
  await expect(page.getByText('Add or import your products')).toBeVisible();

  await page.goto('/account');
  await expect(page.getByText('Free trial', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Store + Online' })).toBeVisible();

  await page.getByRole('button', { name: 'Prepare a download' }).click();
  const link = page.getByRole('link', { name: /^Download \(/ });
  await expect(link).toBeVisible({ timeout: 60_000 }); // the worker builds it
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^store-export-\d{4}-\d{2}-\d{2}\.zip$/);

  await page.getByLabel("What's wrong (optional)").fill('e2e check');
  await page.getByRole('button', { name: 'Allow support access' }).click();
  await expect(page.getByText(/Support can look until/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop access now' }).click();
  await expect(page.getByRole('button', { name: 'Allow support access' })).toBeVisible();
});
