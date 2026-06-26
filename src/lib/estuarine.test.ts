import { describe, expect, it } from "bun:test";
import { classifyZone, effortEfficiency, isMonster } from "./estuarine";

describe("classifyZone", () => {
  it("returns openWater for low effort + short time horizons", () => {
    expect(classifyZone({ effortToChange: "low", timeToChange: "now" })).toBe("openWater");
    expect(classifyZone({ effortToChange: "low", timeToChange: "soon" })).toBe("openWater");
  });

  it("returns granite for high effort + long time horizons", () => {
    expect(classifyZone({ effortToChange: "high", timeToChange: "ongoing" })).toBe("granite");
    expect(classifyZone({ effortToChange: "high", timeToChange: "years" })).toBe("granite");
  });

  it("returns sandbank for mixed or missing fields", () => {
    expect(classifyZone({})).toBe("sandbank");
    expect(classifyZone({ effortToChange: "med", timeToChange: "soon" })).toBe("sandbank");
    expect(classifyZone({ effortToChange: "low", timeToChange: "ongoing" })).toBe("sandbank");
    expect(classifyZone({ effortToChange: "high", timeToChange: "now" })).toBe("sandbank");
    expect(classifyZone({ effortToChange: "low" })).toBe("sandbank");
    expect(classifyZone({ timeToChange: "years" })).toBe("sandbank");
  });
});

describe("isMonster", () => {
  it("is true for high-stakes drivers in the granite zone", () => {
    expect(
      isMonster({ weight: 70, effortToChange: "high", timeToChange: "years" }),
    ).toBe(true);
    expect(
      isMonster({ weight: -80, effortToChange: "high", timeToChange: "ongoing" }),
    ).toBe(true);
    expect(
      isMonster({ weight: 60, effortToChange: "high", timeToChange: "ongoing" }),
    ).toBe(true);
  });

  it("is false when stakes are too low, even if granite", () => {
    expect(
      isMonster({ weight: 40, effortToChange: "high", timeToChange: "years" }),
    ).toBe(false);
    expect(
      isMonster({ weight: -59, effortToChange: "high", timeToChange: "ongoing" }),
    ).toBe(false);
  });

  it("is false when not in the granite zone, even if stakes are high", () => {
    expect(isMonster({ weight: 90, effortToChange: "low", timeToChange: "now" })).toBe(false);
    expect(isMonster({ weight: 90 })).toBe(false);
    expect(isMonster({ weight: 90, effortToChange: "med", timeToChange: "soon" })).toBe(false);
  });
});

describe("effortEfficiency", () => {
  const variables = [
    { id: "easy", effortToChange: "low" as const, timeToChange: "now" as const }, // openWater
    { id: "mid", effortToChange: "med" as const, timeToChange: "soon" as const }, // sandbank
    { id: "hard", effortToChange: "high" as const, timeToChange: "years" as const }, // granite
    { id: "untagged" }, // sandbank
  ];

  it("sums push magnitudes split by zone", () => {
    const r = effortEfficiency(
      { pushes: { easy: 30, mid: -20, hard: -40, untagged: 10 } },
      variables,
    );
    expect(r.effective).toBe(30);
    expect(r.wasted).toBe(40);
    expect(r.ratio).toBeCloseTo(30 / 70, 5);
  });

  it("ignores pushes that reference unknown drivers", () => {
    const r = effortEfficiency({ pushes: { ghost: 99, easy: 10 } }, variables);
    expect(r.effective).toBe(10);
    expect(r.wasted).toBe(0);
    expect(r.ratio).toBe(1);
  });

  it("returns ratio 0 when no pushes land on openWater or granite", () => {
    const r = effortEfficiency({ pushes: { mid: 50, untagged: 20 } }, variables);
    expect(r.effective).toBe(0);
    expect(r.wasted).toBe(0);
    expect(r.ratio).toBe(0);
  });

  it("handles an empty pushes record", () => {
    const r = effortEfficiency({ pushes: {} }, variables);
    expect(r).toEqual({ effective: 0, wasted: 0, ratio: 0 });
  });
});
