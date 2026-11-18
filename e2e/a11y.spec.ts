import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { blankDrawing, openFresh } from './helpers';

/** Accessibility problems axe rates serious or critical, as short readable lines. */
async function problems(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    // The diagram canvas is React Flow's own markup: an interactive drawing surface that axe's
    // generic rules do not model. Everything around it is checked.
    .exclude('.react-flow')
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${label}: ${v.id} — ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? v.help}`));
}

test('no serious accessibility problems in any view or dialog', async ({ page }) => {
  await openFresh(page);
  const found: string[] = [];
  found.push(...(await problems(page, 'ideal')));

  await page.locator('.eq-head', { hasText: 'Cabin lights' }).click();
  found.push(...(await problems(page, 'equipment editor')));
  await page.locator('.seg button', { hasText: 'Boat' }).click();
  found.push(...(await problems(page, 'boat & zones')));

  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('table.cmp')).toBeVisible();
  found.push(...(await problems(page, 'compare')));

  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  for (const tab of ['Design check', 'Upgrade plan', 'Wire schedule', 'Bill of materials', 'Energy']) {
    await page.locator('.report-tabs button', { hasText: tab }).click();
    found.push(...(await problems(page, `reports/${tab}`)));
  }

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'BoatWire how-to guide' })).toBeVisible();
  found.push(...(await problems(page, 'guide')));
  await page.keyboard.press('Escape');

  await page.locator('.file > button').click();
  found.push(...(await problems(page, 'file menu')));
  await page.keyboard.press('Escape');

  await blankDrawing(page, ['battery', 'fuse']);
  await page.locator('.react-flow__node').nth(1).locator('.sym-label').click();
  found.push(...(await problems(page, 'existing + component details')));

  expect(found, found.join('\n')).toEqual([]);
});

test('dark theme passes the same check', async ({ page }) => {
  await openFresh(page);
  await page.locator('.header > .theme-pick').selectOption('dark');
  const found = await problems(page, 'dark');
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  found.push(...(await problems(page, 'dark reports')));
  expect(found, found.join('\n')).toEqual([]);
});

test('dialogs and menus work from the keyboard', async ({ page }) => {
  await openFresh(page);
  // File menu: opens with Enter, arrows move, Escape closes and returns focus
  const file = page.locator('.file > button');
  await file.focus();
  await page.keyboard.press('Enter');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.file .menu button', { hasText: 'New boat' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.file .menu button', { hasText: 'Load example boat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  await expect(file).toBeFocused();
  // …and does not close just because the mouse moved away
  await file.click();
  await page.mouse.move(200, 500);
  await expect(page.locator('.file .menu')).toBeVisible();
  await page.mouse.click(200, 500);
  await expect(page.locator('.file .menu')).toHaveCount(0);

  // The guide keeps the keyboard inside it and gives focus back when closed
  const help = page.locator('.help-btn');
  await help.focus();
  await page.keyboard.press('Enter');
  const guide = page.getByRole('dialog', { name: 'BoatWire how-to guide' });
  await expect(guide).toBeVisible();
  for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(help).toBeFocused();

  // An error is an in-app dialog, not a browser alert
  let browserDialogs = 0;
  page.on('dialog', (d) => {
    browserDialogs++;
    void d.dismiss();
  });
  const chooser = page.waitForEvent('filechooser');
  await file.click();
  await page.locator('.file .menu button', { hasText: 'Open project' }).click();
  await (await chooser).setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('this is not a boat') });
  const alert = page.getByRole('alertdialog');
  await expect(alert).toContainText('Could not open “notes.json”');
  await expect(alert.getByRole('button', { name: 'OK' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(alert).toHaveCount(0);
  expect(browserDialogs).toBe(0);
});

test('a question on top of a dialog: Escape answers only the question', async ({ page }) => {
  await openFresh(page);
  await page.locator('button.signin').click();
  await page.locator('.save-cloud').click();
  await expect(page.locator('.cloud-status')).toHaveText('Saved');
  await page.locator('.cloud button', { hasText: 'My boats' }).click();
  const boats = page.getByRole('dialog', { name: 'My boats' });
  await boats.locator('.boat-row button', { hasText: 'Delete' }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText('This cannot be undone');
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(boats).toBeVisible();
  await expect(boats.locator('.boat-row')).toHaveCount(1);

  await boats.locator('.boat-row button', { hasText: 'Delete' }).click();
  await ask.getByRole('button', { name: 'Delete it' }).click();
  await expect(boats.locator('.boat-row')).toHaveCount(0);
  // the boat stays open here, no longer linked to the account
  await expect(page.locator('.toast-msg')).toContainText('was deleted from your account');
});
