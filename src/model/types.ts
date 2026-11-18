// Core data model for BoatWire.
//
// A Project holds a boat profile, an equipment list (what is / will be aboard),
// scenarios (what-if variants of the ideal design) and an optional hand-drawn
// "existing" wiring design. The rules engine turns (profile + equipment +
// scenario) into an ideal Design; the audit engine checks any Design.

export type SystemVoltage = 12 | 24;
export type Chemistry = 'flooded' | 'agm' | 'gel' | 'lifepo4';
export type AcStandard = 'us120' | 'eu230';
export type Domain = 'dc' | 'ac';

export interface Zone {
  id: string;
  name: string;
  /** Distance from the bow, feet. */
  x: number;
  /** Extra vertical/routing distance to reach equipment here (e.g. masthead), feet. */
  rise: number;
}

export interface BoatProfile {
  name: string;
  lengthFt: number;
  systemVoltage: SystemVoltage;
  acStandard: AcStandard;
  /** Zone where the main battery banks / DC distribution live. */
  batteryZone: string;
  /** Zone of the main DC/AC panel (nav station). */
  panelZone: string;
  /** Zone of the helm, where windlass, thruster and winch controls are. */
  helmZone: string;
  zones: Zone[];
}

export type BankRole = 'house' | 'start' | 'windlass' | 'thruster' | 'winch' | 'fridge';

/** Every catalog kind. Batteries and engine are equipment like anything else. */
export type EquipmentKind =
  // storage / engine
  | 'battery-bank'
  | 'engine'
  // charging / sources
  | 'solar'
  | 'wind'
  | 'hydro'
  | 'shore-power'
  | 'generator'
  | 'battery-charger'
  | 'inverter-charger'
  | 'inverter'
  // DC loads
  | 'cabin-lights'
  | 'nav-lights'
  | 'anchor-light'
  | 'steaming-deck-light'
  | 'fridge'
  | 'freezer'
  | 'water-pump'
  | 'bilge-pump'
  | 'shower-sump'
  | 'watermaker'
  | 'autopilot'
  | 'chartplotter'
  | 'vhf'
  | 'radar'
  | 'ais'
  | 'instruments'
  | 'ssb'
  | 'starlink'
  | 'stereo'
  | 'fans'
  | 'usb-outlets'
  | 'horn'
  | 'diesel-heater'
  | 'windlass'
  | 'bow-thruster'
  | 'electric-winch'
  | 'custom-dc'
  // AC loads
  | 'ac-outlets'
  | 'water-heater'
  | 'air-conditioner'
  | 'microwave'
  | 'induction-cooktop'
  | 'custom-ac';

export type PropValue = number | string | boolean;

export interface Equipment {
  id: string;
  kind: EquipmentKind;
  name: string;
  zone: string;
  props: Record<string, PropValue>;
}

export interface Scenario {
  id: string;
  name: string;
  /** Overrides; undefined = use profile / equipment values. */
  systemVoltage?: SystemVoltage;
  houseChemistry?: Chemistry;
  houseCapacityAh?: number;
}

export interface LayerSettings {
  dc: boolean;
  ac: boolean;
  negatives: 'full' | 'buses' | 'hidden';
  /** Collapse the branch circuits fed from DC panels (lights, fans, fridge…) into a summary on the panel. */
  panelLoads?: 'show' | 'collapse';
  /** Show inline fuse symbols. Off folds each fuse into its wire (rating stays on the wire label). Undefined = shown. */
  fuses?: boolean;
  signal: boolean;
  grounding: boolean;
  labels: {
    gauge: boolean;
    protection: boolean;
    current: boolean;
    length: boolean;
    vdrop: boolean;
    parts: boolean;
  };
}

// ---------------------------------------------------------------- Designs

/** Symbol / electrical type of a node in a design. */
export type NodeType =
  | 'battery'
  | 'fuse'
  | 'breaker'
  | 'switch' // battery / isolation switch
  | 'selector' // AC source selector
  | 'transfer-switch'
  | 'bus-pos'
  | 'bus-neg'
  | 'fuse-block'
  | 'shunt'
  | 'acr'
  | 'isolator' // diode / FET battery isolator (one-way)
  | 'dcdc'
  | 'bms'
  | 'contactor'
  | 'apd' // alternator protection device
  | 'regulator'
  | 'alternator'
  | 'solar-panel'
  | 'mppt'
  | 'wind-gen'
  | 'hydro-gen'
  | 'controller'
  | 'dump-load'
  | 'shore-inlet'
  | 'generator'
  | 'elci'
  | 'galvanic-isolator'
  | 'ac-panel'
  | 'ac-ground-bus'
  | 'charger'
  | 'inverter'
  | 'inverter-charger'
  | 'dc-panel'
  | 'converter' // 24→12 converter
  | 'engine'
  | 'load'
  | 'ac-load'
  | 'bilge-switch'
  | 'helm-switch';

export type Polarity = 'pos' | 'neg' | 'ac' | 'gnd' | 'sig';

export interface Terminal {
  id: string;
  pol: Polarity;
  /** Preferred side when no layout direction applies. */
  side: 'W' | 'E' | 'N' | 'S';
  label?: string;
  /** Protective rating of this output (panel breaker / fuse-block position). */
  rating?: number;
}

export type WireKind = 'pos' | 'neg' | 'ac' | 'gnd' | 'sig';

export interface DNode {
  id: string;
  type: NodeType;
  label: string;
  sublabel?: string;
  domain: Domain;
  /** Layout column hint (0 = sources … 8 = loads). */
  col: number;
  zone: string;
  equipmentId?: string;
  /** Stable semantic role used to compare designs (e.g. "house:main-fuse"). */
  role?: string;
  terminals: Terminal[];
  /** Ratings and data shown in the inspector. */
  data: {
    rating?: number; // amps for fuses/breakers/switches/etc
    fuseClass?: string;
    amps?: number; // continuous current for loads / output of sources
    watts?: number;
    volts?: number;
    critical?: boolean;
    part?: string; // suggested part / spec
    [k: string]: PropValue | undefined;
  };
  notes?: string[]; // rule ids that explain this node
  /** Manual layout position (existing designs / user drags). */
  pos?: { x: number; y: number };
}

export interface WireEnd {
  node: string;
  term: string;
}

export interface Wire {
  id: string;
  kind: WireKind;
  domain: Domain;
  from: WireEnd;
  to: WireEnd;
  /** One-way run length, feet. */
  lengthFt: number;
  /** True while lengthFt is BoatWire's starting guess for a hand-drawn wire, not a length the user entered. */
  lengthEstimated?: boolean;
  /** Design current, amps. */
  amps?: number;
  /** Conductor size, AWG string ("14", "1/0"...). */
  gauge?: string;
  /** Voltage drop percent at design current (round trip for DC). */
  vdropPct?: number;
  /** Allowed voltage drop for this circuit. */
  vdropLimit?: number;
  /** Id of the node providing over-current protection for this conductor. */
  protectedBy?: string;
  inEngineSpace?: boolean;
  notes?: string[];
  /** Short label override, e.g. "14/3" for AC cable or "2× 4/0" for parallel runs. */
  cable?: string;
  /** Equipment grounding conductor (shown only with the grounding layer). */
  equipmentGround?: boolean;
  /** Display only: id of a hidden fuse this wire has been drawn through. */
  viaFuse?: string;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  message: string;
  fix?: string;
  nodes?: string[];
  wires?: string[];
}

export interface Design {
  id: string;
  name: string;
  systemVoltage: SystemVoltage;
  nodes: DNode[];
  wires: Wire[];
  /** Notes produced while generating (design decisions). */
  findings: Finding[];
  /** A user-supplied picture of their wiring diagram, shown faded behind the drawing for tracing. */
  underlay?: Underlay;
}

/** Trace-over image, positioned in diagram (flow) coordinates. */
export interface Underlay {
  /** Downscaled image as a data URL (kept small so the project still fits in cloud storage). */
  src: string;
  /** Original file name, for display. */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–1 */
  opacity: number;
  visible: boolean;
  /** When locked the image ignores the mouse, so clicks and pans reach the canvas. */
  locked: boolean;
}

export interface Project {
  version: 1;
  profile: BoatProfile;
  equipment: Equipment[];
  scenarios: Scenario[];
  activeScenario: string;
  existing?: Design;
}
