import { BATTERY_FUSE_MAX_IN, ELCI_TRIP_MA, REFS, SHORE_MAIN_MAX_FT, VDROP } from '../model/standards';
import { fmtLen, fmtShort, type Units } from '../model/units';

export interface RuleInfo {
  title: string;
  why: string;
  ref?: string;
}

/** Shown wherever a design is presented as advice (Boat & zones tab, printed report) while STANDARDS_VERIFIED is false. */
export const STANDARDS_NOTICE =
  "Wire tables and limits were checked against Blue Sea Systems' published tables (2023 catalog) on 19 November 2026. Those tables summarise ABYC E-11; they are not the ABYC standard itself, and a few values used here, such as AC cable ratings and fuse interrupt ratings, are not in them. Have a qualified marine electrician review any design before installation.";

/** Plain-English explanations attached to nodes, wires and findings. */
function build(units: Units): Record<string, RuleInfo> {
  return {
  'battery-fuse': {
    title: 'Fuse at the battery',
    why: `Every positive conductor leaving a battery needs over-current protection within ${fmtShort(BATTERY_FUSE_MAX_IN, units)} of the terminal (longer only if sheathed). A short in an unfused battery cable can start a fire — batteries can deliver thousands of amps.`,
    ref: REFS.E11,
  },
  'class-t': {
    title: 'Class T fuse for lithium / large banks',
    why: 'LiFePO4 banks can deliver 10,000–20,000 A into a dead short. A Class T fuse has a ~20 kA interrupt rating, so it actually breaks the arc; ANL fuses (~6 kA), terminal fuses (~10 kA) and blade or MIDI fuses (1–2 kA) may not. BoatWire therefore asks for Class T on every fuse connected straight to a lithium battery. Other fuses belong downstream of it.',
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
  'charge-relay': {
    title: 'Engine-run charging relay',
    why: 'A split-charge relay whose coil is powered by the alternator\'s D+ (or the ignition / oil-pressure "engine running" signal). It joins the start and house banks only while the alternator is charging and opens the moment the engine stops, so the house loads can never flatten the start battery. Unlike an ACR it ignores battery voltage, so solar or shore charging will not reach the start battery through it. Use a continuous-duty relay rated above alternator output, fused at both batteries. Not for lithium mixed with lead-acid — use a DC-DC charger.',
  },
  'isolator': {
    title: 'Battery isolator (diode / FET)',
    why: 'An isolator lets one alternator charge several banks through one-way diodes or MOSFETs, so the banks are never connected to each other and a flat house bank cannot drain the start battery. Diode isolators drop about 0.6–0.8 V, so with a stock regulator that senses at the alternator the batteries are chronically undercharged. Fix it by compensating the regulator (see "Diode isolator compensation"), or use a FET (zero-drop) isolator. Isolators give every bank the same voltage, so they are unsuitable for lithium mixed with lead-acid.',
  },
  'isolator-compensation': {
    title: 'Diode isolator compensation',
    why: 'A stock alternator regulator holds its own output at the charge voltage, but a diode isolator drops about 0.7 V on the way to the batteries, so they never get fully charged. Two common fixes: (1) most diode isolators have an "E" (excitation) terminal. Wire it to the alternator\'s excitation terminal so the regulator is fed through a matching diode and raises its output by the same amount. (2) If the alternator has a remote voltage-sense terminal, run the sense lead to the battery side of the isolator (the house bus) so the regulator measures battery voltage directly. Check the isolator and alternator instructions for which your units support. An external smart regulator that senses at the battery already does this.',
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
  'alternator-disconnect': {
    title: 'Keep a battery on the running alternator',
    why: 'A running alternator must always have a battery to charge. If its last battery is switched off or disconnected while it is charging, its output voltage spikes and can destroy the alternator diodes and the electronics on the same bus. When only one battery switch stands between the alternator and every battery, leave that switch on while the engine runs, and fit an alternator protection device (APD), which absorbs the spike if it happens.',
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
  'bundling': {
    title: 'Wires in a bundle',
    why: 'Wires packed together in a bundle, loom, sheath or conduit cannot shed heat as well as a wire on its own, so each is rated for less current, and less again in a bigger bundle. Only wires that carry current count: positive and negative, including a circuit\'s own negative in the same cable, but not grounding or signal wires. Blue Sea Systems also says you need not count wires that carry less than half their rating in a bundle, or that carry current only in short bursts. BoatWire uses the ABYC E-11 figures as Blue Sea publishes them (2023 catalog, p.164). The ideal design sizes every cable as if it ran on its own. In Existing boat, set "Bundled with" on a wire to check it as bundled.',
    ref: REFS.E11,
  },
  'unsized-wire': {
    title: 'Wire size not recorded',
    why: 'A wire can only be checked once its conductor size is known: whether it can carry the current, whether its fuse is small enough to protect it, and how much voltage it loses over its length. Until then it is drawn dotted and left out of those checks, so a drawing with unsized wires has not been fully checked.',
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
  'dedicated-bank': {
    title: 'Dedicated battery for one piece of equipment',
    why: 'A windlass, bow thruster, electric winch or refrigerator can have its own battery right beside it. The heavy current then flows only through short cables from that battery, instead of long, thick cables from the house bank. The equipment is still switched from the house DC panel: a small breaker there powers the relay (or helm switch and contactor), which connects the equipment to its own battery. A DC-DC charger refills the dedicated battery from the house bank, and the two banks share a common negative.',
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
    why: `The shore cable needs a main breaker within ${fmtLen(SHORE_MAIN_MAX_FT, units)} of the inlet. Current standards require ELCI protection (${ELCI_TRIP_MA} mA) to trip on leakage that can electrocute swimmers near the boat.`,
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
  'missing-zone': {
    title: 'Location not in the zone list',
    why: 'Cable lengths are worked out from where things are aboard: each zone has a distance from the bow and an extra rise. If an item sits in a zone that is not in the list, there is nothing to measure from, so a fixed length is assumed and the wire size, voltage drop and cable quantities for it cannot be trusted.',
  },
  'not-drawn': {
    title: 'Equipment left out of the design',
    why: 'The ideal design is built around one propulsion engine, one inverter or inverter/charger, one shore power inlet, one AC generator, one engine start battery and one dedicated battery per job. Anything beyond that is not drawn yet, so it is listed here to make sure it is not missed: its cables, fuses and switches are absent from the diagram, the wire schedule and the bill of materials. Its loads still count in the energy budget.',
  },
  'beyond-sizes': {
    title: 'Bigger than the largest part',
    why: 'Fuses, breakers, switches, relays and controllers come in standard sizes, up to a largest one. When a circuit needs more, BoatWire still draws the largest so the diagram is complete, and reports it: an error when that part is smaller than the current through it, a warning when only its safety margin is short or when a controller simply cannot deliver everything. Its cables are still sized for the full current. The cure is less current through one part: a higher system voltage (24 V halves the current), the load split across two circuits, banks or controllers, a smaller generator or inverter, or a dedicated circuit with a larger part.',
  },
  'voltage-choice': {
    title: 'System voltage',
    why: 'Doubling voltage halves current for the same power, so cables can be much smaller — very useful for big inverters, windlasses and thrusters. The cost is converters for 12 V-only equipment.',
  },
  'bank-sizing': {
    title: 'House bank sizing',
    why: 'Usable capacity should cover the days of autonomy you plan for (two unless you change it under Reports → Energy budget): lead-acid is good for about 50% depth of discharge, LiFePO4 about 80%.',
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
  'wire-mismatch': {
    title: 'Wire joins terminals that must stay separate',
    why: 'A wire between a positive and a negative terminal is a dead short across the battery. AC (mains) and DC (battery) circuits are separate systems and are never joined, and a live AC conductor never connects to the safety ground. The only link between the two systems is the bond from the AC grounding bus to DC negative.',
    ref: REFS.E11,
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
}

const BUILT: Partial<Record<Units, Record<string, RuleInfo>>> = {};
const rulesFor = (units: Units) => (BUILT[units] ??= build(units));

/** The explanations in feet and inches. Use ruleInfo(id, units) to follow the boat's units. */
export const RULES: Record<string, RuleInfo> = rulesFor('imperial');

export function ruleInfo(id: string, units: Units = 'imperial'): RuleInfo {
  return rulesFor(units)[id] ?? { title: id, why: '' };
}
