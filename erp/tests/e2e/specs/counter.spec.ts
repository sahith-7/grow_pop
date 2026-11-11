import { expect, test, type Page } from '@playwright/test';
import { newStore } from './fixtures';

/** Every till's drawer is counted before its first bill (v2, D110). */
async function openRegister(page: Page, cash = '1000') {
  await page.getByRole('button', { name: 'Type the total' }).click();
  await page.getByLabel('Cash in the drawer now').fill(cash);
  await page.getByRole('button', { name: /^Open with/ }).click();
  await expect(page.getByLabel('Scan or search items')).toBeVisible();
}

test('counter sale, invoice and return with a credit note', async ({ page }) => {
  const store = await newStore(page);
  await page.goto('/pos');
  await openRegister(page);
  const scan = page.getByLabel('Scan or search items');
  await scan.fill(store.sku);
  await scan.press('Enter');
  await expect(page.locator('input[aria-label^="Quantity of"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Walk-in' }).click(); // every bill needs a customer or Walk-in (v2, D104)
  await page.getByLabel('Cash received').fill('500');
  await page.locator('button:has-text("Take ₹")').click();
  await expect(page.getByText('Paid ·')).toBeVisible();

  await page.goto('/invoices');
  await page.locator('table a').first().click();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible(); // v2: one Print button with a paper picker
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
  await expect(page.getByRole('button', { name: /^Open with/ })).toBeVisible();
  const before = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(before).toBeLessThanOrEqual(1);
  await openRegister(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
