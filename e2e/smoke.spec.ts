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

test('works with no connection after the first visit, and can be installed', async ({ page, context }) => {
  const errors = await openFresh(page);
  // installable: a manifest with icons, and a service worker in control of the page
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.short_name).toBe('BoatWire');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // it takes over this first page too, so parts loaded later in the session come from the offline copy
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
  // wait until the offline copy is complete (the layout engine's worker is the largest part)
  await expect
    .poll(async () => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url)))).flat().some((u) => u.includes('elk-worker'))), { timeout: 30_000 })
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.header')).toBeVisible();
  await expect(page.locator('.offline-chip')).toBeVisible();
  // the diagram is laid out again from scratch, with no network
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(30);

  // …and stays fully usable: edit, switch views, draw
  await page.locator('.eq-head', { hasText: 'Cabin lights' }).click();
  await page.locator('.eq-edit input[type=number]').first().fill('45');
  await expect(page.locator('.react-flow__node', { hasText: '45 W' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page.locator('.report-body')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('table.cmp')).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'BoatWire how-to guide' })).toContainText('How to use BoatWire');

  await context.setOffline(false);
  await expect(page.locator('.offline-chip')).toHaveCount(0);
  // fonts come with the app: nothing is requested from a font service
  expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Inter Variable')))).toBe(true);
  expect(errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e))).toEqual([]);
});

test('new boat: a template gives a complete design; the questions build a custom one', async ({ page }) => {
  const errors = await openFresh(page);
  // the example boat invites you to start your own
  await page.locator('.example-note button').click();
  const wizard = page.getByRole('dialog', { name: 'New boat' });
  await expect(wizard).toBeVisible();

  // 1. straight from a template
  await wizard.locator('.wiz-card', { hasText: 'Coastal cruiser' }).getByRole('button', { name: 'Use this' }).click();
  await expect(wizard).toHaveCount(0);
  await expect(page.locator('.canvas-title')).toContainText('My coastal cruiser');
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(25);
  await expect(page.locator('.inspector .counts')).toContainText('0 errors');
  await expect(page.locator('.example-note')).toHaveCount(0);
  // …and it is one undoable step
  await expect(page.locator('.toast-msg')).toContainText('Opened My coastal cruiser');

  // 2. answering the questions
  await page.locator('.file > button').click();
  await page.locator('.file .menu button', { hasText: 'New boat' }).click();
  await wizard.getByRole('button', { name: 'Answer a few questions instead' }).click();
  await wizard.locator('.field', { hasText: 'Boat name' }).locator('input').fill('Kittiwake');
  await wizard.locator('.field', { hasText: 'Length overall' }).locator('input').fill('28');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.locator('.field', { hasText: 'House battery type' }).locator('select').selectOption('lifepo4');
  await wizard.locator('.field', { hasText: 'Solar' }).locator('input').fill('300');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.locator('.toggle', { hasText: 'Anchor windlass' }).click();
  await expect(wizard.locator('.wiz-budget')).toContainText('Ah a day');
  await wizard.getByRole('button', { name: 'Create my boat' }).click();
  await expect(wizard).toHaveCount(0);

  await expect(page.locator('.canvas-title')).toContainText('Kittiwake');
  await expect(page.locator('.eq-head', { hasText: 'Anchor windlass' })).toBeVisible();
  await expect(page.locator('.eq-head', { hasText: 'House bank' })).toContainText('LIFEPO4');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('boatwire:v1')!).state.project);
  expect(stored.profile.lengthFt).toBe(28);
  // zones scaled to a 28 ft boat: nothing sits beyond the transom
  expect(Math.max(...stored.profile.zones.map((z: { x: number }) => z.x))).toBeLessThan(28);
  expect(errors).toEqual([]);
});

test('the content-security policy from firebase.json is enforced here, and the app runs inside it', async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as any).__csp = [...((window as any).__csp ?? []), `${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`];
    });
  });
  const errors = await openFresh(page);
  const policy = (await page.request.get('/')).headers()['content-security-policy'];
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  // prove it bites: an inline script is refused
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.head.appendChild(s);
  });
  expect(await page.evaluate(() => (window as any).__inlineRan)).toBeUndefined();
  await page.evaluate(() => ((window as any).__csp = []));

  // the parts of the app most likely to trip a policy: workers, PDF import, picture export
  await page.getByRole('button', { name: 'Existing boat', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Trace over my wiring diagram/ }).click();
  await (await chooser).setFiles('e2e/fixtures/diagram.pdf');
  await expect(page.locator('.underlay img')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Ideal design', exact: true }).click();
  await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(30);
  for (const kind of ['PNG', 'SVG']) {
    await page.locator('.file > button').click();
    const download = page.waitForEvent('download');
    await page.locator('.file .menu button', { hasText: `Export diagram (${kind})` }).click();
    await download;
  }
  violations.push(...(await page.evaluate(() => (window as any).__csp as string[])));
  expect(violations).toEqual([]);
  // the only console error allowed is the one from the deliberate inline script above
  expect(errors.filter((e) => !e.includes('Executing inline script'))).toEqual([]);
  expect(errors.filter((e) => e.includes('Executing inline script'))).toHaveLength(1);
});

test('metric units: mm² and metres everywhere, same design underneath', async ({ page }) => {
  const errors = await openFresh(page);
  const labels = () => page.locator('.wlabel').allTextContents();
  const before = await labels();
  expect(before.some((l) => /^(\d+|\d\/0)$/.test(l))).toBe(true);
  const gaugesBefore = (await page.evaluate(() => JSON.parse(localStorage.getItem('boatwire:v1')!).state.project.profile.zones.map((z: { x: number }) => z.x))) as number[];

  await page.locator('.seg button', { hasText: 'Boat' }).click();
  await page.locator('.boat .field', { hasText: 'Units' }).locator('select').selectOption('metric');
  // diagram labels
  await expect.poll(async () => (await labels()).every((l) => !/^(\d+|\d\/0)$/.test(l))).toBe(true);
  expect((await labels()).some((l) => /mm²$/.test(l))).toBe(true);
  // boat length and zone table are in metres, and the stored values (feet) have not moved
  await expect(page.locator('.boat .field', { hasText: 'Length overall' }).locator('.unit')).toHaveText('m');
  await expect(page.locator('table.zones thead')).toContainText('Aft (m)');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('boatwire:v1')!).state.project.profile.zones.map((z: { x: number }) => z.x))).toEqual(gaugesBefore);
  // typing a metric distance stores the right number of feet
  const bilge = page.locator('table.zones tr', { has: page.locator('input[value="Bilge"]') }).locator('input[type=number]').first();
  await bilge.fill('6');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('boatwire:v1')!).state.project.profile.zones.find((z: { id: string }) => z.id === 'bilge').x)).toBeCloseTo(19.69, 1);

  // reports
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.locator('.report-tabs button', { hasText: 'Wire schedule' }).click();
  const firstRow = page.locator('.report-body table.grid tbody tr').first().locator('td');
  await expect(firstRow.nth(4)).toHaveText(/mm²$|^3G/);
  await expect(firstRow.nth(5)).toHaveText(/^[\d.]+\s*m$/);
  await expect(page.locator('.report-body')).not.toContainText(' ft');
  await page.locator('.report-tabs button', { hasText: 'Bill of materials' }).click();
  await expect(page.locator('.report-body')).toContainText('mm²');
  await expect(page.locator('.report-body')).not.toContainText('AWG');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('table.cmp')).toContainText('Cable length (m)');
  await expect(page.locator('table.cmp')).toContainText('mm²');

  // existing boat: sizes are picked in mm² and lengths typed in metres
  await blankDrawing(page, ['battery', 'fuse']);
  await wire(page, [0, 'pos'], [1, 'in']);
  const size = page.locator('.inspector .field', { hasText: 'Conductor size' }).locator('select');
  expect(await size.locator('option').allTextContents()).toEqual(['—', '1 mm²', '1.5 mm²', '2.5 mm²', '4 mm²', '6 mm²', '10 mm²', '16 mm²', '25 mm²', '35 mm²', '50 mm²', '70 mm²', '95 mm²', '120 mm²']);
  await size.selectOption({ label: '35 mm²' });
  const len = page.locator('.inspector .field', { hasText: 'Run length' }).locator('input');
  await len.fill('0.15');
  const stored = (await storedProject(page)).existing.wires[0];
  expect(stored.gauge).toBe('2');
  expect(stored.lengthFt).toBeCloseTo(0.49, 2);
  await expect(page.locator('.wlabel')).toHaveText(['35 mm²']);
  expect(errors).toEqual([]);
});
