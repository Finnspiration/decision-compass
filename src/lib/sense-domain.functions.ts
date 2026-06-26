import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { classifyZone, isMonster } from "./estuarine";

const VariableIn = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  weight: z.number().min(-100).max(100).optional().default(0),
  effortToChange: z.enum(["low", "med", "high"]).optional(),
  timeToChange: z.enum(["now", "soon", "ongoing", "years"]).optional(),
});
const InfluenceIn = z.object({
  from: z.string(),
  to: z.string(),
});
const OptionIn = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
});

const Input = z.object({
  model: z.object({
    outcomeName: z.string().max(200).optional(),
    variables: z.array(VariableIn).default([]),
    influences: z.array(InfluenceIn).default([]),
    options: z.array(OptionIn).default([]),
  }),
  /** Win-% gap between the top two options (0-100). Optional. */
  topGap: z.number().min(0).max(100).optional(),
});

export type SenseDomain = {
  domain: "clear" | "complicated" | "complex" | "chaotic";
  confidence: number; // 0..1
  plainWhy: string;
  leadView: "ranking" | "map";
  signals: {
    loops: number;
    granites: number;
    monsters: number;
    topGap: number | null;
    drivers: number;
    options: number;
  };
};

/* -------------------------- pure heuristic core --------------------------- */

/** Count distinct directed cycles (Tarjan-style SCC > 1 nodes, plus self-loops). */
function countFeedbackLoops(
  variableIds: string[],
  influences: Array<{ from: string; to: string }>,
): number {
  const idSet = new Set(variableIds);
  const adj = new Map<string, string[]>();
  for (const id of variableIds) adj.set(id, []);
  let selfLoops = 0;
  for (const e of influences) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    if (e.from === e.to) {
      selfLoops += 1;
      continue;
    }
    adj.get(e.from)!.push(e.to);
  }
  // Tarjan's SCC
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let sccCyclic = 0;

  function strongConnect(v: string) {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) sccCyclic += 1;
    }
  }
  for (const v of variableIds) if (!idx.has(v)) strongConnect(v);
  return sccCyclic + selfLoops;
}

export function senseDomainHeuristic(
  model: {
    variables: Array<{
      id: string;
      weight?: number;
      effortToChange?: "low" | "med" | "high";
      timeToChange?: "now" | "soon" | "ongoing" | "years";
    }>;
    influences: Array<{ from: string; to: string }>;
    options: Array<unknown>;
  },
  topGap: number | null,
): {
  domain: SenseDomain["domain"];
  confidence: number;
  signals: SenseDomain["signals"];
  leadView: SenseDomain["leadView"];
} {
  const drivers = model.variables.length;
  const options = model.options.length;
  const loops = countFeedbackLoops(
    model.variables.map((v) => v.id),
    model.influences,
  );
  let granites = 0;
  let monsters = 0;
  for (const v of model.variables) {
    const z = classifyZone({
      effortToChange: v.effortToChange,
      timeToChange: v.timeToChange,
    });
    if (z === "granite") granites += 1;
    if (isMonster({ weight: v.weight ?? 0, effortToChange: v.effortToChange, timeToChange: v.timeToChange })) {
      monsters += 1;
    }
  }
  const gap = topGap;

  // Chaotic: too little structure to reason
  if (drivers < 2 || options < 2) {
    return {
      domain: "chaotic",
      confidence: 0.6,
      signals: { loops, granites, monsters, topGap: gap, drivers, options },
      leadView: "map",
    };
  }

  const tightGap = gap !== null && gap < 6;
  const wideGap = gap !== null && gap >= 20;

  // Composite complexity score
  const score = loops * 2 + monsters * 2 + granites + (tightGap ? 2 : 0);

  let domain: SenseDomain["domain"];
  let confidence: number;
  if (score >= 5) {
    domain = "complex";
    confidence = Math.min(0.9, 0.55 + score * 0.05);
  } else if (loops >= 1 || granites >= 2 || monsters >= 1) {
    domain = "complicated";
    confidence = 0.65;
  } else if (wideGap && drivers <= 6 && loops === 0) {
    domain = "clear";
    confidence = 0.8;
  } else {
    domain = "complicated";
    confidence = 0.55;
  }

  const leadView: SenseDomain["leadView"] = domain === "complex" ? "map" : "ranking";


  return {
    domain,
    confidence,
    signals: { loops, granites, monsters, topGap: gap, drivers, options },
    leadView,
  };
}

function fallbackPlainWhy(
  domain: SenseDomain["domain"],
  s: SenseDomain["signals"],
): string {
  if (domain === "chaotic") {
    return "There isn't enough here yet to compare options — add a few drivers and at least two choices, then try again.";
  }
  if (domain === "complex") {
    const bits: string[] = [];
    if (s.loops > 0) bits.push(`${s.loops} knock-on loop${s.loops === 1 ? "" : "s"}`);
    if (s.monsters > 0) bits.push(`${s.monsters} big thing${s.monsters === 1 ? "" : "s"} that's hard to move`);
    else if (s.granites > 0) bits.push(`${s.granites} slow-to-budge driver${s.granites === 1 ? "" : "s"}`);
    if (s.topGap !== null && s.topGap < 6) bits.push("a tight race between the top choices");
    const why = bits.length ? bits.join(", ") : "tangled cause-and-effect";
    return `This is a tangled situation — ${why}. Small experiments and things to design around will beat one big bet.`;
  }
  if (domain === "complicated") {
    return "There's a lot to weigh up, but the pieces connect in a fairly orderly way. Working through the ranking carefully should give you a defensible call.";
  }
  return "The picture is fairly clean: a small number of drivers and a clear front-runner. You can lean on the ranking.";
}

/* ------------------------------ server fn -------------------------------- */

const SYSTEM_PROMPT =
  "You write ONE short sentence (max 28 words) for a decision-maker, in plain everyday language. No jargon. Never use the words: complex, complicated, chaotic, Cynefin, estuarine, granite, monster, latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability, trajectory, push, domain. Say things like: tangled, knock-on effects, hard to budge, tight race, clean picture, front-runner. Be honest and concrete. Return ONLY JSON.";

const JSON_HINT = `Return ONLY JSON of shape:
{ "plainWhy": string }`;

export const senseDomain = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<SenseDomain> => {
    const heur = senseDomainHeuristic(
      {
        variables: data.model.variables,
        influences: data.model.influences,
        options: data.model.options,
      },
      data.topGap ?? null,
    );

    const fallback: SenseDomain = {
      domain: heur.domain,
      confidence: heur.confidence,
      plainWhy: fallbackPlainWhy(heur.domain, heur.signals),
      leadView: heur.leadView,
      signals: heur.signals,
    };

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return fallback;

    try {
      const { rateLimit } = await import("./ai-guard.server");
      rateLimit("senseDomain", { perMinute: 12 });
    } catch {
      return fallback;
    }

    const userPayload = {
      outcome: data.model.outcomeName ?? "",
      readout: {
        kind:
          heur.domain === "complex"
            ? "tangled situation, lean on experiments"
            : heur.domain === "complicated"
              ? "orderly but lots to weigh"
              : heur.domain === "clear"
                ? "clean picture, clear front-runner"
                : "not enough to compare yet",
        knockOnLoops: heur.signals.loops,
        bigHardToMove: heur.signals.monsters,
        slowToBudge: heur.signals.granites,
        driverCount: heur.signals.drivers,
        optionCount: heur.signals.options,
        raceTightness:
          heur.signals.topGap === null
            ? "unknown"
            : heur.signals.topGap < 6
              ? "tight"
              : heur.signals.topGap >= 20
                ? "wide"
                : "moderate",
      },
      hint: "Write ONE sentence that explains, in plain words, what kind of situation this is and why — referring to the readout signals.",
    };

    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT + "\n\n" + JSON_HINT },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
        }),
      });
      if (!res.ok) return fallback;
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = j.choices?.[0]?.message?.content ?? "";
      if (!content) return fallback;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) return fallback;
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          return fallback;
        }
      }
      const obj =
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      let plainWhy = typeof obj.plainWhy === "string" ? obj.plainWhy.trim() : "";
      // Jargon sanity check
      const banned = /\b(complex|complicated|chaotic|cynefin|estuarine|granite|monster|latent|variable|feedback loop|coefficient|monte[- ]?carlo|probability|trajectory|domain)\b/i;
      if (!plainWhy || banned.test(plainWhy) || plainWhy.length > 240) {
        plainWhy = fallback.plainWhy;
      }
      return { ...fallback, plainWhy };
    } catch {
      return fallback;
    }
  });
