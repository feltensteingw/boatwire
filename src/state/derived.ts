import { useMemo } from 'react';
import { audit } from '../engine/audit';
import { generateIdeal } from '../engine/generate';
import { activeScenario } from '../engine/scenario';
import { AC_STANDARDS } from '../model/standards';
import type { Design, Finding, Project } from '../model/types';
import { useStore } from './store';

export function acVoltsOf(p: Project) {
  return AC_STANDARDS[p.profile.acStandard].volts;
}

export function useIdeal(): Design {
  const project = useStore((s) => s.project);
  return useMemo(() => generateIdeal(project, activeScenario(project)), [project]);
}

export function useExisting(): Design | undefined {
  const project = useStore((s) => s.project);
  return useMemo(() => {
    if (!project.existing) return undefined;
    return { ...project.existing, systemVoltage: project.profile.systemVoltage };
  }, [project.existing, project.profile.systemVoltage]);
}

export function useFindings(design: Design | undefined): Finding[] {
  const project = useStore((s) => s.project);
  return useMemo(() => (design ? [...design.findings, ...audit(design, { acVolts: acVoltsOf(project) })] : []), [design, project]);
}

export function severityByNode(findings: Finding[]): Map<string, Finding['severity']> {
  const m = new Map<string, Finding['severity']>();
  const rank = { error: 3, warning: 2, info: 1 };
  for (const f of findings) {
    for (const id of f.nodes ?? []) {
      const cur = m.get(id);
      if (!cur || rank[f.severity] > rank[cur]) m.set(id, f.severity);
    }
  }
  return m;
}
