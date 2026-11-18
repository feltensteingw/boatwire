import { describe, expect, it } from 'vitest';
import { MISSING_ZONE_RUN_FT, runLength } from '../src/engine/calc';
import { paletteNode } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { exampleProject, newEquipment } from '../src/model/examples';
import { parseProject } from '../src/model/validate';
import { missingZones, removeZone, zoneInUse, zoneUse } from '../src/model/zones';
import { describeChange } from '../src/state/changes';

const missing = (p: ReturnType<typeof exampleProject>) => generateIdeal(p).findings.filter((f) => f.rule === 'missing-zone');

describe('what is located in a zone', () => {
  it('lists equipment, drawn components and boat-level roles', () => {
    const p = exampleProject();
    p.existing = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [paletteNode('fuse', 'battery'), paletteNode('fuse', 'nav')], wires: [], findings: [] };
    const u = zoneUse(p, 'battery');
    expect(u.equipment).toContain('House bank');
    expect(u.drawn).toBe(1);
    expect(u.roles).toEqual(['the battery / main bus location']);
    expect(zoneUse(p, 'cockpit').roles).toEqual(['the helm location']);
    expect(zoneInUse(u)).toBe(true);
  });

  it('an empty zone is not in use', () => {
    const p = exampleProject();
    p.profile.zones.push({ id: 'spare', name: 'Spare', x: 5, rise: 0 });
    expect(zoneInUse(zoneUse(p, 'spare'))).toBe(false);
  });
});

describe('removing a zone', () => {
  it('moves everything out first, so nothing is left pointing at it', () => {
    const p = exampleProject();
    p.existing = { id: 'existing', name: 'Existing', systemVoltage: 12, nodes: [paletteNode('fuse', 'battery')], wires: [], findings: [] };
    const there = zoneUse(p, 'battery').equipment.length;
    expect(there).toBeGreaterThan(0);
    removeZone(p, 'battery', 'engine');
    expect(p.profile.zones.some((z) => z.id === 'battery')).toBe(false);
    expect(p.profile.batteryZone).toBe('engine');
    expect(p.equipment.some((e) => e.zone === 'battery')).toBe(false);
    expect(p.existing!.nodes[0].zone).toBe('engine');
    expect(missingZones(p)).toEqual({ equipment: [], roles: [] });
    expect(missing(p)).toHaveLength(0);
  });

  it('moves the helm and panel locations too', () => {
    const p = exampleProject();
    removeZone(p, 'cockpit', 'aft');
    removeZone(p, 'nav', 'saloon');
    expect(p.profile.helmZone).toBe('aft');
    expect(p.profile.panelZone).toBe('saloon');
  });

  it('never removes the last zone, and ignores unknown ids and bad targets', () => {
    const p = exampleProject();
    const n = p.profile.zones.length;
    removeZone(p, 'no-such-zone', 'battery');
    expect(p.profile.zones).toHaveLength(n);
    p.profile.zones = [p.profile.zones[0]];
    removeZone(p, p.profile.zones[0].id);
    expect(p.profile.zones).toHaveLength(1);
  });

  it('is described as one undoable step even when equipment moved with it', () => {
    const a = exampleProject();
    const b = structuredClone(a);
    removeZone(b, 'bilge', 'saloon');
    expect(describeChange(a, b)).toEqual({ label: 'Removed the zone Bilge', destructive: true });
  });
});

describe('a location that is not in the zone list', () => {
  it('is reported by the design check instead of silently becoming a 10 ft guess', () => {
    const p = exampleProject();
    expect(missing(p)).toHaveLength(0);
    // as could happen in a boat saved by an older version, which let any zone be deleted
    p.profile.zones = p.profile.zones.filter((z) => z.id !== 'bilge' && z.id !== 'cockpit');
    expect(runLength(p.profile, 'battery', 'bilge')).toBe(MISSING_ZONE_RUN_FT);
    const f = missing(p);
    expect(f.map((x) => x.severity)).toEqual(['warning', 'warning']);
    expect(f[0].message).toMatch(/Bilge pump \(main\).*not in the zone list.*10 ft guess/);
    expect(f[1].message).toMatch(/helm location is not in the zone list/);
  });

  it('names at most four items and counts the rest', () => {
    const p = exampleProject();
    for (let i = 0; i < 6; i++) p.equipment.push(newEquipment('fans', { name: `Fan ${i + 1}`, zone: 'nowhere' }));
    expect(missing(p)[0].message).toMatch(/^Fan 1, Fan 2, Fan 3, Fan 4 and 2 more are in a location/);
  });
});

describe('helm location', () => {
  it('controls for heavy loads sit at the helm location, not a fixed zone', () => {
    const p = exampleProject();
    p.profile.helmZone = 'aft';
    const d = generateIdeal(p);
    const helm = d.nodes.filter((n) => n.type === 'helm-switch');
    expect(helm.length).toBeGreaterThan(0);
    for (const h of helm) expect(h.zone).toBe('aft');
  });

  it('boats saved before the setting existed get the cockpit, or another zone that exists', () => {
    const old = JSON.parse(JSON.stringify(exampleProject()));
    delete old.profile.helmZone;
    expect(parseProject(old).project.profile.helmZone).toBe('cockpit');
    old.profile.zones = old.profile.zones.filter((z: { id: string }) => z.id !== 'cockpit');
    const { project } = parseProject(old);
    expect(project.profile.zones.map((z) => z.id)).toContain(project.profile.helmZone);
  });
});
