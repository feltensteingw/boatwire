// Zones (locations aboard) and what depends on them.

import type { Project } from './types';

export interface ZoneUse {
  /** Names of the equipment located in the zone. */
  equipment: string[];
  /** How many components on the existing-boat drawing are located in it. */
  drawn: number;
  /** Boat-level roles the zone plays, e.g. "the battery location". */
  roles: string[];
}

/** Everything that is located in a zone. Cable lengths to these are measured from it. */
export function zoneUse(p: Project, zoneId: string): ZoneUse {
  const roles: string[] = [];
  if (p.profile.batteryZone === zoneId) roles.push('the battery / main bus location');
  if (p.profile.panelZone === zoneId) roles.push('the main panel location');
  if (p.profile.helmZone === zoneId) roles.push('the helm location');
  return {
    equipment: p.equipment.filter((e) => e.zone === zoneId).map((e) => e.name),
    drawn: p.existing?.nodes.filter((n) => n.zone === zoneId).length ?? 0,
    roles,
  };
}

export const zoneInUse = (u: ZoneUse) => u.equipment.length > 0 || u.drawn > 0 || u.roles.length > 0;

/**
 * Remove a zone (in place). Anything located in it moves to `moveTo` first, so no cable length
 * is left measured from a place that no longer exists. The last zone cannot be removed.
 */
export function removeZone(p: Project, zoneId: string, moveTo?: string): void {
  if (p.profile.zones.length <= 1 || !p.profile.zones.some((z) => z.id === zoneId)) return;
  const target = moveTo && moveTo !== zoneId && p.profile.zones.some((z) => z.id === moveTo) ? moveTo : undefined;
  if (target) {
    for (const e of p.equipment) if (e.zone === zoneId) e.zone = target;
    for (const n of p.existing?.nodes ?? []) if (n.zone === zoneId) n.zone = target;
    if (p.profile.batteryZone === zoneId) p.profile.batteryZone = target;
    if (p.profile.panelZone === zoneId) p.profile.panelZone = target;
    if (p.profile.helmZone === zoneId) p.profile.helmZone = target;
  }
  p.profile.zones = p.profile.zones.filter((z) => z.id !== zoneId);
}

/** Equipment and boat-level locations that point at a zone which is not in the list. */
export function missingZones(p: Project): { equipment: string[]; roles: string[] } {
  const ids = new Set(p.profile.zones.map((z) => z.id));
  const roles: string[] = [];
  if (!ids.has(p.profile.batteryZone)) roles.push('battery / main bus location');
  if (!ids.has(p.profile.panelZone)) roles.push('main panel location');
  if (!ids.has(p.profile.helmZone)) roles.push('helm location');
  return { equipment: p.equipment.filter((e) => !ids.has(e.zone)).map((e) => e.name), roles };
}
