import { expect, test, type Locator, type Page } from '@playwright/test';
import { blankDrawing, openFresh, storedProject, terminal, undo, wire } from './helpers';

const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** The grip on the selected wire that sits beside the given terminal. */
async function gripNear(page: Page, term: Locator) {
  const t = await centre(term);
  const grips = await page.locator('.react-flow__edgeupdater').all();
  const at = await Promise.all(grips.map(centre));
  return at.sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))[0];
}

const drawing = async (page: Page) => (await storedProject(page)).existing as { nodes: { id: string; type: string; label: string; pos: { x: number; y: number } }[]; wires: { from: { node: string; term: string }; to: { node: string; term: string } }[] };

test('existing boat: select several components, nudge, duplicate, delete and undo', async ({ page }) => {
  const errors = await openFresh(page);
  await blankDrawing(page, ['battery', 'fuse', 'switch']);
  await wire(page, [0, 'pos'], [1, 'in']);

  // Shift-drag a box around the battery and the fuse, starting on the empty canvas above and left of them
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const bat = (await page.locator('.react-flow__node').nth(0).boundingBox())!;
  const fuse = (await page.locator('.react-flow__node').nth(1).boundingBox())!;
  await page.keyboard.down('Shift');
  await drag(page, { x: pane.x + 4, y: bat.y - 40 }, { x: fuse.x + fuse.width + 30, y: Math.max(bat.y + bat.height, fuse.y + fuse.height) + 30 });
  await page.keyboard.up('Shift');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.draw-tools .picked')).toContainText('2 components selected');

  // arrow keys move both, by one grid square
  const before = (await drawing(page)).nodes.map((n) => n.pos);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await drawing(page)).nodes.map((n) => n.pos.x - before.find((_, i) => i === 0)!.x)[0]).toBe(10);
  const after = (await drawing(page)).nodes.map((n) => n.pos);
  expect(after.map((p, i) => p.x - before[i].x)).toEqual([10, 10, 0]);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  // duplicate: two new components and the wire between them; the copies become the selection
  await page.keyboard.press('ControlOrMeta+d');
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const d = await drawing(page);
  const copies = d.nodes.slice(3).map((n) => n.id);
  expect(d.wires[1].from.node).toBe(copies[0]);
  expect(d.wires[1].to.node).toBe(copies[1]);

  // delete removes the copies and their wire in one step; one undo brings them all back
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.locator('.toast-msg')).toContainText('Deleted 2 components');
  await undo(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  // copy and paste one component
  await page.locator('.react-flow__node').nth(2).click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  expect((await drawing(page)).nodes[5].type).toBe('switch');
  expect(errors).toEqual([]);
});

test('existing boat: quick-add parts, move a wire end, and notes', async ({ page }) => {
  const errors = await openFresh(page);
  await blankDrawing(page, ['battery', 'fuse', 'switch', 'bus-pos']);
  await wire(page, [1, 'out'], [2, 'in']);
  await expect(page.locator('.inspector .insp-kind')).toHaveText('DC positive');
  const ids = (await drawing(page)).nodes.map((n) => n.id);

  // the selected wire has a grip beside each end; drag the switch end onto the bus bar
  await expect(page.locator('.react-flow__edgeupdater')).toHaveCount(2);
  const stud = page.locator('.react-flow__node').nth(3).locator('.react-flow__handle').first();
  await drag(page, await gripNear(page, terminal(page, 2, 'in')), await centre(stud));
  await expect.poll(async () => (await drawing(page)).wires[0].to.node).toBe(ids[3]);
  expect((await drawing(page)).wires).toHaveLength(1);
  // still selected, so the other end can be moved straight away
  await expect(page.locator('.inspector .insp-kind')).toHaveText('DC positive');
  await expect(page.locator('.react-flow__edgeupdater')).toHaveCount(2);

  // a move that would short positive to negative is refused, and nothing changes
  await drag(page, await gripNear(page, terminal(page, 1, 'out')), await centre(terminal(page, 0, 'neg')));
  await expect(page.locator('.refusal')).toContainText('Wire not moved');
  expect((await drawing(page)).wires[0]).toMatchObject({ from: { node: ids[1], term: 'out' }, to: { node: ids[3] } });

  // one undo puts the wire end back
  await page.locator('.refusal button').click();
  await undo(page);
  await expect.poll(async () => (await drawing(page)).wires[0].to.node).toBe(ids[2]);

  // a quick-add part lands in the middle of the view, not on top of another component
  await page.locator('.partbar button', { hasText: 'Breaker' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const added = await centre(page.locator('.react-flow__node').nth(4));
  expect(Math.abs(added.x - (pane.x + pane.width / 2))).toBeLessThan(260);
  expect(Math.abs(added.y - (pane.y + pane.height / 2))).toBeLessThan(200);
  const d = await drawing(page);
  expect(d.nodes.slice(0, 4).some((n) => Math.abs(n.pos.x - d.nodes[4].pos.x) < 100 && Math.abs(n.pos.y - d.nodes[4].pos.y) < 60)).toBe(false);

  // a note is free text on the drawing; the checks ignore it
  const status = await page.locator('.toolbar .status').textContent();
  await page.locator('.partbar button', { hasText: 'Note' }).click();
  await page.getByLabel('Note text').fill('Windlass solenoid\nbehind the chain locker');
  await expect(page.locator('.note-text')).toHaveText('Windlass solenoid\nbehind the chain locker');
  expect((await drawing(page)).nodes[5]).toMatchObject({ type: 'note', label: 'Windlass solenoid\nbehind the chain locker' });
  await expect(page.locator('.toolbar .status')).toHaveText(status!);
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
  await expect(page.locator('.inspector')).not.toContainText('Windlass');
  // typing in the note did not act on the drawing (no component deleted or moved by the keys)
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('existing boat: a wire bundled with others is rated for less current, and undo clears it', async ({ page }) => {
  const errors = await openFresh(page);
  await blankDrawing(page, ['battery', 'fuse', 'load']);
  await wire(page, [1, 'out'], [2, 'pos']);
  await expect(page.locator('.inspector .insp-kind')).toHaveText('DC positive');
  const field = (label: string) => page.locator('.inspector .field', { hasText: label });
  const ampacity = page.locator('.inspector .kv tr', { hasText: 'Ampacity' });
  await field('Conductor size').locator('select').selectOption('12');
  await expect(ampacity).toHaveText('Ampacity45 A');
  // quick edits to one wire are one undo step; let this one stand alone
  await page.waitForTimeout(1100);

  // three others in the bundle: 32 A × 0.857, below the 30 A fuse
  await field('Bundled with').locator('input').fill('3');
  await expect(ampacity).toHaveText('Ampacity27 A (bundled with 3 other wires)');
  expect((await storedProject(page)).existing.wires[0].bundledWith).toBe(3);
  await expect(page.locator('.inspector .findings')).toContainText('protected by 30 A but 12 AWG (bundled with 3 other wires) is only rated 27 A.');

  // one undo takes the bundle off and keeps the size
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await storedProject(page)).existing.wires[0].bundledWith).toBeUndefined();
  expect((await storedProject(page)).existing.wires[0].gauge).toBe('12');
  expect(errors).toEqual([]);
});
