// Lets code outside the canvas (the toolbar that adds components) ask where the middle of the
// user's current view is, in diagram coordinates. The open diagram registers how to work it out.

type Point = { x: number; y: number };
let where: (() => Point) | null = null;

export function registerViewCentre(fn: (() => Point) | null) {
  where = fn;
}

/** The middle of what the user is looking at; a sensible spot near the origin if no diagram is open. */
export function viewCentre(): Point {
  return where?.() ?? { x: 200, y: 160 };
}
