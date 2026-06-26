import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isMonster } from "./estuarine";

const VariableIn = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  weight: z.number().min(-100).max(100).optional().default(0),
});

const Input = z.object({
  model: z.object({
    outcomeName: z.string().max(200).optional(),
    variables: z.array(VariableIn).min(1).max(16),
  }),
});

const EFFORT_SET = new Set(["low", "med", "high"] as const);
const TIME_SET = new Set(["now", "soon", "ongoing", "years"] as const);

export type MalleabilityPosition = {
  id: string;
  effortToChange: "low" | "med" | "high";
  timeToChange: "now" | "soon" | "ongoing" | "years";
  monster: boolean;
};

const SYSTEM_PROMPT =
  "You help a decision-maker read a map of the drivers behind a decision. For each driver, judge two things in plain language: (1) how much effort it would take to actually move it — low / med / high; (2) how long that change typically takes — now (days), soon (weeks), ongoing (months), or years. Be honest: some drivers are quick to nudge, others are slow to budge no matter what. Also flag any driver that is BOTH hard to move AND high-stakes for the outcome, so the team knows to design around it instead of fighting it head-on. Return ONLY JSON.\n\nWRITING STYLE: Plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push, Cynefin, estuarine, granite, complex domain. Say instead: driver, knock-on effect, helps or hurts your goal, quick to change, slow to change, hard to budge.";

const JSON_SHAPE_HINT = `Return ONLY a JSON object matching exactly:
{
  "positions": [
    { "id": string, "effortToChange": "low"|"med"|"high", "timeToChange": "now"|"soon"|"ongoing"|"years", "monster": boolean }
  ]
}
Include exactly one entry per driver id provided. Use only the allowed enum values.`;

export const assessMalleability = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { rateLimit } = await import("./ai-guard.server");
    rateLimit("assessMalleability", { perMinute: 10 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI_HTTP_ERROR: LOVABLE_API_KEY missing");

    const userPayload = {
      outcome: data.model.outcomeName ?? "",
      drivers: data.model.variables.map((v) => ({
        id: v.id,
        name: v.name,
        weight: v.weight ?? 0,
      })),
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT + "\n\n" + JSON_SHAPE_HINT },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("assessMalleability gateway error", {
        status: res.status,
        body: body.slice(0, 200),
      });
      throw new Error(`AI_HTTP_ERROR: gateway ${res.status}`);
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI_BAD_JSON: gateway returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI_BAD_JSON: gateway returned non-JSON content");
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        throw new Error("AI_BAD_JSON: gateway returned non-JSON content");
      }
    }

    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const rawPositions = Array.isArray(root.positions) ? root.positions : [];
    const byId = new Map<string, { effortToChange?: string; timeToChange?: string; monster?: unknown }>();
    for (const p of rawPositions) {
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      if (!id) continue;
      byId.set(id, {
        effortToChange: typeof o.effortToChange === "string" ? o.effortToChange : undefined,
        timeToChange: typeof o.timeToChange === "string" ? o.timeToChange : undefined,
        monster: o.monster,
      });
    }

    const positions: MalleabilityPosition[] = data.model.variables.map((v) => {
      const raw = byId.get(v.id);
      const effortToChange = (
        raw && EFFORT_SET.has(raw.effortToChange as "low" | "med" | "high")
          ? raw.effortToChange
          : "med"
      ) as "low" | "med" | "high";
      const timeToChange = (
        raw && TIME_SET.has(raw.timeToChange as "now" | "soon" | "ongoing" | "years")
          ? raw.timeToChange
          : "soon"
      ) as "now" | "soon" | "ongoing" | "years";
      const aiMonster = raw && typeof raw.monster === "boolean" ? raw.monster : false;
      // Cross-check with the pure helper so the flag stays internally consistent.
      const derivedMonster = isMonster({
        weight: v.weight ?? 0,
        effortToChange,
        timeToChange,
      });
      return {
        id: v.id,
        effortToChange,
        timeToChange,
        monster: aiMonster || derivedMonster,
      };
    });

    return { positions };
  });
