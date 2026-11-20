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

// Every colour scheme but one gets the same scan. Night watch is left out: it is dim red on black
// on purpose, to keep the eyes adjusted to the dark, so it cannot meet the contrast rules.
for (const theme of ['dark', 'chart', 'blueprint', 'contrast']) {
  test(`${theme} theme passes the same check`, async ({ page }) => {
    await openFresh(page);
    await page.locator('.header > .theme-pick').selectOption(theme);
    const found = await problems(page, theme);
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    found.push(...(await problems(page, `${theme} reports`)));
    await page.locator('.file > button').click();
    await page.locator('.file .menu button', { hasText: 'New boat' }).click();
    await expect(page.getByRole('dialog', { name: 'New boat' })).toBeVisible();
    found.push(...(await problems(page, `${theme} new boat`)));
    expect(found, found.join('\n')).toEqual([]);
  });
}

/** Text contrast of every element matching `selector`, against the colours painted behind it. */
function textContrast(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => {
    // rgb(…) / rgba(…), or color(srgb …) with channels from 0 to 1 (what color-mix() computes to)
    const rgba = (c: string) => {
      const p = c.match(/[\d.]+/g)!.map(Number);
      const k = c.startsWith('color(') ? 255 : 1;
      return [p[0] * k, p[1] * k, p[2] * k, p[3] ?? 1];
    };
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    return els.map((el) => {
      // the backgrounds from the element outwards until an opaque one, laid over each other
      const layers: number[][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.unshift(c);
        if (c[3] === 1) break;
      }
      const bg = layers.reduce((under, c) => under.map((u, i) => c[i] * c[3] + u * (1 - c[3])), [255, 255, 255]);
      const [hi, lo] = [lum(rgba(getComputedStyle(el).color)), lum(bg)].sort((a, b) => b - a);
      return `${el.className} "${el.textContent}" ${((hi + 0.05) / (lo + 0.05)).toFixed(2)}`;
    });
  });
}

// axe skips some small text: the "?" help marks, the upgrade-plan counts and the units beside
// inputs. These sit on tinted fills, so check them directly in the schemes that have struggled.
for (const theme of ['chart', 'blueprint', 'contrast']) {
  test(`${theme} theme: help marks, counts and units are readable`, async ({ page }) => {
    await openFresh(page);
    await page.locator('.header > .theme-pick').selectOption(theme);
    await page.locator('.eq-head', { hasText: 'Cabin lights' }).click();
    const seen = [...(await textContrast(page, '.help-dot')), ...(await textContrast(page, '.unit'))];

    await blankDrawing(page, ['battery', 'fuse']);
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await page.locator('.report-tabs button', { hasText: 'Upgrade plan' }).click();
    await expect(page.locator('.changes .count').first()).toBeVisible();
    const counts = await textContrast(page, '.changes .count');
    expect(counts.length).toBeGreaterThan(0);
    seen.push(...counts);
    if (theme === 'contrast') {
      // High contrast keeps the counts in their heading's colour (red for safety, orange for recommended)
      const colours = await page
        .locator('.changes h3')
        .evaluateAll((hs) => hs.map((h) => [getComputedStyle(h).color, getComputedStyle(h.querySelector('.count')!).color]));
      for (const [heading, count] of colours) expect(count).toBe(heading);
    }

    expect(seen.length).toBeGreaterThan(5);
    const low = seen.filter((s) => Number(s.split(' ').pop()) < 4.5);
    expect(low, `${theme}: ${low.join(', ')}`).toEqual([]);
  });
}

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
