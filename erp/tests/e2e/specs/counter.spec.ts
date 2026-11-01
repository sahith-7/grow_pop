import { expect, test } from '@playwright/test';
import { newStore } from './fixtures';

test('counter sale, invoice and return with a credit note', async ({ page }) => {
  const store = await newStore(page);
  await page.goto('/pos');
  const scan = page.getByLabel('Scan or search items');
  await scan.fill(store.sku);
  await scan.press('Enter');
  await expect(page.locator('input[aria-label^="Quantity of"]')).toHaveCount(1);
  await page.getByLabel('Cash received').fill('500');
  await page.locator('button:has-text("Take ₹")').click();
  await expect(page.getByText('Paid ·')).toBeVisible();

  await page.goto('/invoices');
  await page.locator('table a').first().click();
  await expect(page.getByText('Print A4')).toBeVisible();
  await page.getByText('Return items').click();
  await page.locator('button:has-text("All")').first().click();
  await page.getByPlaceholder('e.g. wrong size').fill('Wrong size');
  await page.getByRole('button', { name: 'Issue credit note' }).click();
  await expect(page).toHaveURL(/invoices\/[0-9a-f-]+$/);
  await expect(page.locator('h1')).toContainText('CN');
});

test('the counter fits a phone screen @phone', async ({ page }) => {
  await newStore(page);
  await page.goto('/pos');
  await expect(page.getByLabel('Scan or search items')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
