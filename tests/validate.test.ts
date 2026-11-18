import { describe, expect, it } from 'vitest';
import { existingFromIdeal } from '../src/engine/existing';
import { generateIdeal } from '../src/engine/generate';
import { blankProject, exampleProject } from '../src/model/examples';
import type { Project } from '../src/model/types';
import { parseProject, ProjectError, PROJECT_VERSION } from '../src/model/validate';

const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** The example boat with an existing-boat drawing copied from its ideal design, as saved to disk. */
function fullProject(): Project {
  const p = exampleProject();
  p.existing = existingFromIdeal(generateIdeal(p), {});
  p.existing.underlay = { src: 'data:image/webp;base64,AAAA', name: 'plan.png', x: 10, y: 20, width: 800, height: 600, opacity: 0.4, visible: true, locked: true };
  return json(p);
}

describe('parseProject: good data', () => {
  it('returns a clean project unchanged, with no notes', () => {
    for (const p of [json(blankProject()), json(exampleProject()), fullProject()]) {
      const { project, notes } = parseProject(json(p));
      expect(notes).toEqual([]);
      expect(json(project)).toEqual(p);
    }
  });

  it('does not hand back the object it was given', () => {
    const p = fullProject();
    const { project } = parseProject(p);
    expect(project).not.toBe(p);
    expect(project.equipment[0]).not.toBe(p.equipment[0]);
  });
});

describe('parseProject: not a project at all', () => {
  it('refuses with a readable message', () => {
    for (const bad of [null, undefined, 42, 'boat', [], {}, { hello: 'world' }]) {
      expect(() => parseProject(bad), JSON.stringify(bad)).toThrow(ProjectError);
    }
    expect(() => parseProject({})).toThrow(/not a BoatWire project/);
  });

  it('refuses a boat from a newer BoatWire and says to reload', () => {
    const p = { ...json(exampleProject()), version: PROJECT_VERSION + 1 };
    expect(() => parseProject(p)).toThrow(/newer version of BoatWire.*Reload/s);
  });
});

describe('parseProject: repairs', () => {
  it('fills in missing settings, zones and scenarios', () => {
    const { project, notes } = parseProject({ equipment: [] });
    expect(project.profile.zones.length).toBeGreaterThan(3);
    expect(project.profile.zones.some((z) => z.id === project.profile.batteryZone)).toBe(true);
    expect(project.scenarios).toHaveLength(1);
    expect(project.activeScenario).toBe(project.scenarios[0].id);
    expect(project.version).toBe(PROJECT_VERSION);
    expect(notes.join(' ')).toMatch(/no zones/);
  });

  it('points battery / panel locations and the active scenario at things that exist', () => {
    const p = json(exampleProject()) as unknown as Record<string, any>;
    p.profile.batteryZone = 'nowhere';
    p.profile.panelZone = 123;
    p.activeScenario = 'gone';
    p.profile.systemVoltage = 48;
    p.profile.acStandard = 'mars';
    const { project } = parseProject(p);
    const zones = project.profile.zones.map((z) => z.id);
    expect(zones).toContain(project.profile.batteryZone);
    expect(zones).toContain(project.profile.panelZone);
    expect(project.activeScenario).toBe(project.scenarios[0].id);
    expect(project.profile.systemVoltage).toBe(12);
    expect(project.profile.acStandard).toBe('us120');
  });

  it('leaves out equipment it cannot understand and says how many', () => {
    const p = json(exampleProject()) as unknown as Record<string, any>;
    const before = p.equipment.length;
    p.equipment.push({ id: 'x1', kind: 'fusion-reactor', name: 'Mr Fusion', zone: 'aft', props: {} }, 'garbage', null);
    const { project, notes } = parseProject(p);
    expect(project.equipment).toHaveLength(before);
    expect(notes.join(' ')).toMatch(/1 item of a kind this version of BoatWire does not know was left out/);
    expect(notes.join(' ')).toMatch(/2 damaged equipment items were left out/);
  });

  it('restores missing equipment fields from the catalog and fixes duplicate ids', () => {
    const p = json(exampleProject()) as unknown as Record<string, any>;
    const fridge = p.equipment.find((e: any) => e.kind === 'fridge');
    delete fridge.props;
    delete fridge.name;
    p.equipment[1].id = p.equipment[0].id;
    const { project } = parseProject(p);
    const f = project.equipment.find((e) => e.kind === 'fridge')!;
    expect(f.name).toBeTruthy();
    expect(typeof f.props.watts).toBe('number');
    expect(new Set(project.equipment.map((e) => e.id)).size).toBe(project.equipment.length);
  });

  it('drops wires that point at missing components or terminals, and components of unknown type', () => {
    const p = fullProject() as unknown as Record<string, any>;
    const nodes = p.existing.nodes.length;
    const wires = p.existing.wires.length;
    p.existing.wires.push({ id: 'bad1', kind: 'pos', domain: 'dc', from: { node: 'ghost', term: 'pos' }, to: { node: p.existing.nodes[0].id, term: p.existing.nodes[0].terminals[0].id }, lengthFt: 1 });
    p.existing.wires.push({ id: 'bad2', kind: 'pos', domain: 'dc', from: { node: p.existing.nodes[0].id, term: 'no-such-terminal' }, to: { node: p.existing.nodes[1].id, term: p.existing.nodes[1].terminals[0].id }, lengthFt: 1 });
    p.existing.nodes.push({ id: 'n-x', type: 'flux-capacitor', label: 'Flux', terminals: [], data: {} });
    const { project, notes } = parseProject(p);
    expect(project.existing!.nodes).toHaveLength(nodes);
    expect(project.existing!.wires).toHaveLength(wires);
    expect(notes.join(' ')).toMatch(/2 wires .* were left out/);
    expect(notes.join(' ')).toMatch(/1 component .* was left out/);
  });

  it('drops a damaged trace-over diagram but keeps the drawing', () => {
    const p = fullProject() as unknown as Record<string, any>;
    p.existing.underlay = { src: 'javascript:alert(1)', width: 10, height: 10 };
    const { project, notes } = parseProject(p);
    expect(project.existing!.underlay).toBeUndefined();
    expect(project.existing!.nodes.length).toBeGreaterThan(10);
    expect(notes.join(' ')).toMatch(/trace-over diagram was damaged/);
  });

  it('leaves out a drawing that is not a drawing', () => {
    const p = json(exampleProject()) as unknown as Record<string, any>;
    p.existing = 'oops';
    const { project, notes } = parseProject(p);
    expect(project.existing).toBeUndefined();
    expect(notes.join(' ')).toMatch(/existing-boat drawing was damaged/);
  });

  it('a repaired project still generates and audits without throwing', () => {
    const p = fullProject() as unknown as Record<string, any>;
    p.profile.zones = [{ id: 'only', name: 'Only zone', x: 5, rise: 0 }];
    p.equipment[3].zone = 42;
    const { project } = parseProject(p);
    expect(() => generateIdeal(project)).not.toThrow();
  });
});
