import { expect, test } from '@playwright/test';

test('demo: o painel abre sem erro de CSP nem de script', async ({ page }) => {
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  expect(erros).toEqual([]);
});
