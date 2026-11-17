import { BATTERY_FUSE_MAX_IN, ELCI_TRIP_MA, REFS, SHORE_MAIN_MAX_FT, VDROP } from '../model/standards';

export interface RuleInfo {
  title: string;
  why: string;
  ref?: string;
}

/** Plain-English explanations attached to nodes, wires and findings. */
export const RULES: Record<string, RuleInfo> = {
  'battery-fuse': {
    title: 'Fuse at the battery',
    why: `Every positive conductor leaving a battery needs over-current protection within ${BATTERY_FUSE_MAX_IN} in of the terminal (longer only if sheathed). A short in an unfused battery cable can start a fire — batteries can deliver thousands of amps.`,
    ref: REFS.E11,
  },
  'class-t': {
    title: 'Class T fuse for lithium / large banks',
    why: 'LiFePO4 banks can deliver 10,000–20,000 A into a dead short. A Class T fuse has a ~20 kA interrupt rating, so it actually breaks the arc; ANL fuses (~6 kA) may not.',
    ref: REFS.E13,
  },
  'battery-switch': {
    title: 'Battery isolation switch',
    why: 'Each bank gets a switch, readily accessible, so the whole system can be shut down for service or in an emergency. It goes after the main fuse.',
    ref: REFS.E11,
  },
  'house-start-split': {
    title: 'Separate house and start banks',
    why: 'Running the house bank flat must never stop you starting the engine. A dedicated start battery, charged automatically, keeps them independent.',
  },
  'acr': {
    title: 'Automatic charging relay',
    why: 'An ACR (voltage-sensitive relay) joins start and house banks while charging and separates them when voltage falls, so both get charged without a manual 1-2-Both switch that people forget.',
  },
  'isolator': {
    title: 'Battery isolator (diode / FET)',
    why: 'An isolator lets one alternator charge several banks through one-way diodes or MOSFETs, so the banks are never connected to each other and a flat house bank cannot drain the start battery. Diode isolators drop about 0.6–0.8 V, so with a stock regulator that senses at the alternator the batteries are chronically undercharged. Use a FET (zero-drop) isolator or a regulator that senses on the battery side. Isolators give every bank the same voltage, so they are unsuitable for lithium mixed with lead-acid.',
  },
  'dcdc': {
    title: 'DC-DC charger between banks',
    why: 'Lithium and lead-acid need different charge voltages and must not be paralleled directly. A DC-DC charger gives the target bank the correct profile and limits current so the alternator is not overloaded.',
    ref: REFS.TE13,
  },
  'alternator-lfp': {
    title: 'Protect the alternator from a BMS disconnect',
    why: 'If a lithium BMS opens while the alternator is charging, the voltage spike can destroy the alternator diodes. Either keep the alternator on a lead-acid start battery and charge lithium through a DC-DC charger, or use an external regulator with an alternator protection device (APD).',
    ref: REFS.E13,
  },
  'external-bms': {
    title: 'External BMS',
    why: 'An external BMS monitors cells and controls a contactor plus "allow-to-charge" / "allow-to-discharge" signals to chargers and loads, so it can stop charging gracefully before it has to disconnect the bank.',
    ref: REFS.E13,
  },
  'shunt': {
    title: 'Battery monitor shunt',
    why: 'Only the battery negative goes on the battery side of the shunt; every other negative goes on the system side. Otherwise the monitor misses current and the state-of-charge reading drifts.',
  },
  'common-negative': {
    title: 'Common negative / ground',
    why: 'All DC negatives return to a main negative bus that connects to the engine block, so there is a single reference and starter current does not flow through electronics.',
    ref: REFS.E11,
  },
  'conductor-sizing': {
    title: 'Conductor sizing',
    why: `Wire is sized by whichever is larger: ampacity (it must carry the rating of the fuse protecting it) or voltage drop (${VDROP.critical}% for critical circuits like nav lights, bilge pumps and electronics; ${VDROP.nonCritical}% for others). Length is the full round trip, positive and negative.`,
    ref: REFS.E11,
  },
  'negative-same-size': {
    title: 'Negative return same size',
    why: 'The negative return carries the same current as the positive, so it is the same gauge.',
    ref: REFS.E11,
  },
  'branch-protection': {
    title: 'Branch circuit protection',
    why: 'Each circuit has its own breaker or fuse rated about 125% of the load, and never more than the wire\'s ampacity, so the device protects the wire.',
    ref: REFS.E11,
  },
  'unswitched': {
    title: 'Unswitched (always-on) circuits',
    why: 'Bilge pumps, CO/propane alarms and equipment memory are fed from the battery side of the main switch through their own fuse, so they keep working when the boat is shut down.',
    ref: REFS.E11,
  },
  'bilge-switch': {
    title: 'Bilge pump control',
    why: 'An Auto/Off/Manual switch at the panel lets the float switch run the pump automatically while still allowing manual override.',
  },
  'heavy-load': {
    title: 'Heavy loads straight from the bus',
    why: 'Windlass, thruster and winch motors draw hundreds of amps. They are fed from the main bus through their own breaker (a manual reset is preferred for motors) and a contactor controlled from the helm, not through the house panel.',
  },
  'inverter-fuse': {
    title: 'Inverter feed',
    why: 'An inverter is fed directly from the main bus with a dedicated (Class T on lithium) fuse sized to its maximum DC input, using short, heavy cable.',
    ref: REFS.A31,
  },
  'charging-source-fuse': {
    title: 'Fuse charging sources at the battery end',
    why: 'Charger and controller outputs are protected at the battery/bus end, because the battery is the source of fault current if that wire shorts.',
    ref: REFS.A31,
  },
  'mppt': {
    title: 'MPPT controller',
    why: 'An MPPT controller converts the higher panel voltage down to the battery voltage efficiently. Place it close to the batteries and keep the PV side protected by a disconnect breaker.',
  },
  'dump-load': {
    title: 'Dump load',
    why: 'A wind or hydro generator must never run unloaded. When the batteries are full the controller diverts power into a dump resistor.',
  },
  'shore-main': {
    title: 'Shore power main breaker + ELCI',
    why: `The shore cable needs a main breaker within ${SHORE_MAIN_MAX_FT} ft of the inlet. Current standards require ELCI protection (${ELCI_TRIP_MA} mA) to trip on leakage that can electrocute swimmers near the boat.`,
    ref: REFS.E11,
  },
  'galvanic-isolator': {
    title: 'Galvanic isolator',
    why: 'Shore-power ground connects your boat to every other boat on the dock. A galvanic isolator blocks the small DC currents that would eat your zincs and underwater metals, while still passing fault current.',
    ref: REFS.A28,
  },
  'ac-dc-bond': {
    title: 'AC ground bonded to DC negative',
    why: 'The AC grounding (green) conductor connects to the DC negative bus / engine so a fault between AC and DC systems trips a breaker instead of energizing metal.',
    ref: REFS.E11,
  },
  'source-selector': {
    title: 'AC source selection',
    why: 'Shore, generator and inverter must never be connected to the same AC circuit at once. A break-before-make selector or transfer switch guarantees only one source feeds the panel.',
    ref: REFS.E11,
  },
  'charger-not-on-inverter': {
    title: 'Battery charger off the inverter',
    why: 'A battery charger powered by the inverter just circulates energy and wastes it. Separate chargers go on the shore/generator-only circuit.',
  },
  'shore-only': {
    title: 'Shore-only loads',
    why: 'Water heaters and air conditioners would empty a battery bank in minutes. They go on a circuit powered only by shore or generator.',
  },
  'converter-24-12': {
    title: '24 → 12 V converter',
    why: 'In a 24 V system, equipment only built for 12 V (most electronics and nav lights) is fed through a DC-DC converter and a 12 V sub-panel.',
  },
  'voltage-choice': {
    title: 'System voltage',
    why: 'Doubling voltage halves current for the same power, so cables can be much smaller — very useful for big inverters, windlasses and thrusters. The cost is converters for 12 V-only equipment.',
  },
  'bank-sizing': {
    title: 'House bank sizing',
    why: 'Usable capacity should cover about two days of consumption: lead-acid is good for about 50% depth of discharge, LiFePO4 about 80%.',
  },
  'series-parallel': {
    title: 'Series / parallel bank wiring',
    why: 'Series connections add voltage, parallel connections add capacity. For a parallel bank, take the positive from one end and the negative from the opposite end so every battery shares the load equally. Each lithium battery in parallel should have its own fuse.',
    ref: REFS.E10,
  },
  'no-mixed-chemistry': {
    title: 'Never parallel different chemistries',
    why: 'Lithium and lead-acid batteries have different voltages and charge profiles. Connected directly, one will over-charge or over-discharge the other.',
    ref: REFS.E13,
  },
  'v12-on-24': {
    title: '12 V equipment on a 24 V supply',
    why: 'Equipment rated only for 12 V will be damaged by 24 V; it needs a converter.',
  },
  'neg-return': {
    title: 'Every load needs a negative return',
    why: 'A load without a proper negative conductor will find a return path through other equipment, bonding or the hull — causing failures and corrosion.',
    ref: REFS.E11,
  },
  'starter-exempt': {
    title: 'Starter circuit',
    why: 'The starter cable may be left unfused under ABYC, but a high-rated terminal fuse at the start battery is widely recommended. It is sized well above cranking current so it does not blow during a start.',
    ref: REFS.E11,
  },
};

export function ruleInfo(id: string): RuleInfo {
  return RULES[id] ?? { title: id, why: '' };
}
