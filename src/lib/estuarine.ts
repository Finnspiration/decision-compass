// Pure helpers for the "map of drivers" reading.
// No I/O, no React, no AI. Safe to import from anywhere.

export type EffortToChange = "low" | "med" | "high";
export type TimeToChange = "now" | "soon" | "ongoing" | "years";

export type ZoneInput = {
  effortToChange?: EffortToChange;
  timeToChange?: TimeToChange;
};

/** Where a driver sits on the map. Internal names; UI text stays plain. */
export type Zone = "openWater" | "sandbank" | "granite";

/**
 * Place a driver on the map by how hard and how slow it is to change.
 * - low effort + (now|soon)      -> openWater   (easy to nudge)
 * - high effort + (ongoing|years) -> granite     (design around it)
 * - anything else / missing      -> sandbank   (safe experiment territory)
 */
export function classifyZone(input: ZoneInput): Zone {
  const { effortToChange, timeToChange } = input;
  if (effortToChange === "low" && (timeToChange === "now" || timeToChange === "soon")) {
    return "openWater";
  }
  if (effortToChange === "high" && (timeToChange === "ongoing" || timeToChange === "years")) {
    return "granite";
  }
  return "sandbank";
}

/**
 * A "monster": a driver that is hard to move AND carries high stakes
 * (|weight| >= 60). These are the things to design around, not fight head-on.
 */
export function isMonster(v: {
  weight: number;
  effortToChange?: EffortToChange;
  timeToChange?: TimeToChange;
}): boolean {
  if (Math.abs(v.weight) < 60) return false;
  return classifyZone(v) === "granite";
}

/**
 * How well an option's energy lands on things that can actually move.
 * - effective: sum of |push| on openWater drivers
 * - wasted:    sum of |push| on granite drivers
 * - ratio:     effective / (effective + wasted), or 0 if the option pushes neither
 */
export function effortEfficiency(
  option: { pushes: Record<string, number> },
  variables: Array<{
    id: string;
    effortToChange?: EffortToChange;
    timeToChange?: TimeToChange;
  }>,
): { effective: number; wasted: number; ratio: number } {
  const zoneById = new Map<string, Zone>();
  for (const v of variables) zoneById.set(v.id, classifyZone(v));

  let effective = 0;
  let wasted = 0;
  for (const [id, push] of Object.entries(option.pushes ?? {})) {
    const zone = zoneById.get(id);
    if (!zone) continue;
    const mag = Math.abs(Number(push) || 0);
    if (zone === "openWater") effective += mag;
    else if (zone === "granite") wasted += mag;
  }
  const total = effective + wasted;
  const ratio = total > 0 ? effective / total : 0;
  return { effective, wasted, ratio };
}
