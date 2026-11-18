import { expect, test } from '@playwright/test';
import { blankDrawing, openFresh, storedProject, terminal, undo, wire } from './helpers';

test('every view opens without errors', async ({ page }) => {
  const errors = await openFresh(page);
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(30);

  await page.getByRole('button', { name: 'Existing boat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Draw the system you have now' })).toBeVisible();

  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compare scenarios' })).toBeVisible();
  await expect(page.locator('table.cmp')).toBeVisible();

  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  for (const tab of ['Upgrade plan', 'Wire schedule', 'Bill of materials', 'Energy']) {
    await page.locator('.report-tabs button', { hasText: tab }).click();
    await expect(page.locator('.report-body')).not.toBeEmpty();
  }

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'BoatWire how-to guide' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('editing equipment updates the diagram, keeps the view, and can be undone', async ({ page }) => {
  const errors = await openFresh(page);
  for (let i = 0; i < 3; i++) await page.locator('.react-flow__controls-zoomin').click();
  await page.waitForTimeout(500);
  const view = () => page.locator('.react-flow__viewport').evaluate((e) => (e as HTMLElement).style.transform);
  const before = await view();

  await page.locator('.eq-head', { hasText: 'Cabin lights' }).click();
  const watts = page.locator('.eq-edit input[type=number]').first();
  await watts.fill('45');
  await expect(page.locator('.react-flow__node', { hasText: '45 W' })).toHaveCount(1);
  expect(await view()).toBe(before);

  await undo(page);
  await expect(page.locator('.react-flow__node', { hasText: '45 W' })).toHaveCount(0);
  await expect(page.locator('.toast-msg')).toContainText('Undid: Edited Cabin lights');

  // removing something offers Undo instead of asking first
  await page.locator('.eq-edit .row-actions button', { hasText: 'Remove' }).click();
  await expect(page.locator('.toast-msg')).toContainText('Removed Cabin lights');
  await page.locator('.toast-action').click();
  await expect(page.locator('.eq-head', { hasText: 'Cabin lights' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('existing boat: draw wires, get checked, refuse a dead short', async ({ page }) => {
  const errors = await openFresh(page);
  await blankDrawing(page, ['battery', 'fuse', 'load']);

  await wire(page, [0, 'pos'], [1, 'in']);
  // a new wire opens in the details panel, unsized and with a guessed length
  await expect(page.locator('.inspector .insp-kind')).toHaveText('DC positive');
  await expect(page.locator('.wlabel')).toHaveText(['size?']);
  expect((await storedProject(page)).existing.wires[0]).toMatchObject({ lengthFt: 0.5, lengthEstimated: true });

  await wire(page, [1, 'out'], [2, 'pos']);
  await wire(page, [2, 'neg'], [0, 'neg']);
  await expect(page.locator('button.status')).toContainText('warnings');
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 500 } });
  await expect(page.locator('.inspector')).toContainText('3 wires have no size set');

  // positive to negative is refused with a reason, and nothing is added
  await terminal(page, 0, 'pos').click();
  await terminal(page, 2, 'neg').click();
  await expect(page.locator('.refusal')).toContainText('dead short');
  expect((await storedProject(page)).existing.wires).toHaveLength(3);

  // delete a component, then undo brings it and its wires back
  await page.locator('.react-flow__node').nth(1).locator('.sym-label').click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await undo(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  expect((await storedProject(page)).existing.wires).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('trace-over diagram: upload, survive a reload, stay out of browser storage', async ({ page }) => {
  const errors = await openFresh(page);
  await page.getByRole('button', { name: 'Existing boat', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Trace over my wiring diagram/ }).click();
  await (await chooser).setFiles('e2e/fixtures/diagram.png');
  await expect(page.locator('.underlay img')).toBeVisible();

  // the picture itself goes to IndexedDB; browser storage keeps a short reference
  await expect.poll(async () => (await storedProject(page)).existing.underlay.src).toMatch(/^idb:img-/);
  await page.reload();
  await expect(page.locator('.underlay img')).toBeVisible();
  expect(await page.locator('.underlay img').getAttribute('src')).toMatch(/^data:image\//);
  expect(errors).toEqual([]);
});

test('export the diagram as a PNG', async ({ page }) => {
  await openFresh(page);
  await page.locator('.file > button').click();
  const download = page.waitForEvent('download');
  await page.locator('.file .menu button', { hasText: 'Export diagram (PNG)' }).click();
  expect((await download).suggestedFilename()).toBe('wiring-diagram.png');
});

test('cloud: sign in, autosave, and a change from another device', async ({ page }) => {
  const errors = await openFresh(page);
  await page.locator('button.signin').click();
  await page.locator('.save-cloud').click();
  await expect(page.locator('.cloud-status')).toHaveText('Saved');

  const rename = async (name: string) => {
    await page.locator('.seg button', { hasText: 'Boat' }).click();
    await page.locator('.boat input[type=text]').first().fill(name);
  };
  await rename('Sea Otter');
  await expect(page.locator('.cloud-status')).toHaveText('Saving…');
  await expect(page.locator('.cloud-status')).toHaveText('Saved');
  const cloudName = () => page.evaluate(() => Object.values((window as any).fakeCloud.boats() as Record<string, { name: string }>)[0].name);
  expect(await cloudName()).toBe('Sea Otter');

  const otherDevice = (name: string) =>
    page.evaluate((name) => {
      const fc = (window as any).fakeCloud;
      const [id, b] = Object.entries(fc.boats() as Record<string, { data: string }>)[0];
      const p = JSON.parse(b.data);
      p.profile.name = name;
      fc.remoteSave(id, JSON.stringify(p));
    }, name);

  // nothing unsaved here: their version simply appears
  await otherDevice('From the laptop');
  await expect(page.locator('.boat input[type=text]').first()).toHaveValue('From the laptop');

  // both changed: saving pauses until the user chooses
  await rename('Mine');
  await otherDevice('Theirs');
  await expect(page.locator('.cloud-notice')).toContainText('changed on another device');
  await page.waitForTimeout(2500);
  expect(await cloudName()).toBe('Theirs');
  await page.locator('.cloud-notice button', { hasText: 'Keep mine' }).click();
  await expect(page.locator('.cloud-notice')).toHaveCount(0);
  await expect.poll(cloudName).toBe('Mine');
  expect(errors).toEqual([]);
});

test('damaged saved data never leaves a blank page', async ({ page }) => {
  await openFresh(page);
  await page.evaluate(() => localStorage.setItem('boatwire:v1', '{"state":{"project":{"version":1,'));
  await page.reload();
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('.recovery')).toContainText('could not be opened');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('boatwire:recovered'))).toContain('"version":1,');
});

for (const size of [
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`${size.name}: no sideways scrolling, panels slide over the diagram`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: true });
    const page = await context.newPage();
    const errors = await openFresh(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBe(0);
    await expect(page.locator('.sidebar')).toBeHidden();

    await page.locator('.panebar button', { hasText: 'Equipment' }).tap();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.locator('.panebar button').nth(1).tap();
    await expect(page.locator('.sidebar')).toBeHidden();

    for (const view of ['Reports', 'Compare', 'Existing boat']) {
      await page.locator('.views button', { hasText: view }).tap();
      await page.waitForTimeout(400);
      expect(await overflow(), view).toBe(0);
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}
