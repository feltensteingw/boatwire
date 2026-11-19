import { expect, type Page } from '@playwright/test';

/** Open the app with empty storage (the example boat) and the first-visit guide dismissed. */
export async function openFresh(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-started')) return; // keep storage across reloads within a test
    sessionStorage.setItem('e2e-started', '1');
    localStorage.clear();
    localStorage.setItem('boatwire:guide-seen', '1');
  });
  await page.goto('/');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  return errors;
}

/** The project as written to browser storage. */
export const storedProject = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('boatwire:v1')!).state.project);

/** Existing boat → Blank canvas, with the named palette components added and spread out. */
export async function blankDrawing(page: Page, types: string[]) {
  await page.getByRole('button', { name: 'Existing boat', exact: true }).click();
  await page.getByRole('button', { name: /Blank canvas/ }).click();
  for (const t of types) await page.locator('.toolbar select').first().selectOption(t);
  // Spread the components out so their terminals can be reached, then reload to apply.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('boatwire:v1')!);
    s.state.project.existing.nodes.forEach((n: { pos: { x: number; y: number } }, k: number) => (n.pos = { x: 100 + (k % 3) * 320, y: 100 + Math.floor(k / 3) * 220 }));
    localStorage.setItem('boatwire:v1', JSON.stringify(s));
  });
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(types.length);
}

/** The terminal dot `term` of the n-th component on the drawing. */
export const terminal = (page: Page, nth: number, term: string) => page.locator('.react-flow__node').nth(nth).locator(`.react-flow__handle[data-handleid="${term}"]`);

/** Draw a wire by clicking one terminal and then another. */
export async function wire(page: Page, from: [number, string], to: [number, string]) {
  await terminal(page, ...from).click();
  await terminal(page, ...to).click();
}

export const undo = (page: Page) => page.keyboard.press('ControlOrMeta+z');
