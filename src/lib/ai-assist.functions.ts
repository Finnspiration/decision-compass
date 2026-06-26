import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/* -------------------------------- shared --------------------------------- */

const VariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
  weight: z.number(),
  effortToChange: z.enum(["low", "med", "high"]).optional(),
  timeToChange: z.enum(["now", "soon", "ongoing", "years"]).optional(),
});
const InfluenceSchema = z.object({
  from: z.string(),
  to: z.string(),
  strength: z.number(),
});
const OptionSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  pushes: z.record(z.string(), z.number()).default({}),
});
const ModelSchema = z.object({
  outcomeName: z.string(),
  horizon: z.number(),
  variables: z.array(VariableSchema),
  influences: z.array(InfluenceSchema),
  options: z.array(OptionSchema),
});

async function callGateway(
  apiKey: string,
  system: string,
  user: string,
  json = true,
): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 429)
      throw new Error("Decision Lens AI is rate-limited. Please try again shortly.");
    if (res.status === 402)
      throw new Error(
        "Decision Lens AI credits exhausted. Add credits in Settings → Plans & credits.",
      );
    throw new Error(`Decision Lens AI error ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("Decision Lens AI returned no content");
  return content;
}

function parseJson<T>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    /* fallthrough */
  }
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Decision Lens AI returned non-JSON");
  return JSON.parse(m[0]) as T;
}

/* --------------------------- explainDecision ----------------------------- */

const RankedItem = z.object({
  name: z.string(),
  score: z.number(),
  winProb: z.number(),
  finalValues: z.record(z.string(), z.number()).optional(),
});

const ExplainInput = z.object({
  model: ModelSchema,
  ranked: z.array(RankedItem).min(1),
});

export const explainDecision = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ExplainInput.parse(data))
  .handler(async ({ data }): Promise<{ explanation: string }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const lead = data.ranked[0];
    const runner = data.ranked[1];
    const gap = runner ? lead.score - runner.score : null;
    const winGap = runner ? lead.winProb - runner.winProb : null;

    const sys =
      "You are a trusted advisor talking to a busy decision-maker. In 3–5 plain sentences, explain why the leading option comes out best: the one or two things it improves most, the main knock-on effect, and whether it's a clear win or a close call. End with the single biggest risk to watch. No jargon, no numbers-speak, plain prose only. No headings, no bullet lists, no markdown.\n\nWRITING STYLE: Write every human-readable field (summary, rationale, explanation, message) in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Instead say: driver / what's driving this; knock-on effect; helps or hurts your goal; how it plays out; how often it comes out best. Keep it short and specific, and always say what it means for the decision.";

    const payload = {
      outcomeName: data.model.outcomeName,
      horizon: data.model.horizon,
      variables: data.model.variables.map((v) => ({
        id: v.id,
        name: v.name,
        value: v.value,
        weight: v.weight,
      })),
      influences: data.model.influences,
      options: data.model.options.map((o) => ({ name: o.name, pushes: o.pushes })),
      ranked: data.ranked,
      gap,
      winGap,
    };

    const content = await callGateway(
      apiKey,
      sys,
      "Model + ranking:\n" + JSON.stringify(payload),
      false,
    );
    return { explanation: content.trim() };
  });

/* ------------------------------ improveModel ----------------------------- */

const ImproveInput = z.object({
  focus: z.enum(["model", "options"]),
  model: ModelSchema,
});

export type ImproveSuggestion =
  | {
      kind: "add_driver";
      message: string;
      variable: { id: string; name: string; value: number; weight: number };
    }
  | {
      kind: "add_influence";
      message: string;
      influence: { from: string; to: string; strength: number };
    }
  | {
      kind: "add_option";
      message: string;
      option: { name: string; pushes: Record<string, number> };
    }
  | { kind: "note"; message: string };

const STYLE_RULE =
  "WRITING STYLE: Write every human-readable field (summary, rationale, explanation, message) in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Instead say: driver / what's driving this; knock-on effect; helps or hurts your goal; how it plays out; how often it comes out best. Keep it short and specific, and always say what it means for the decision.";

const SYS_MODEL =
  "You are a trusted second opinion for a decision-maker reviewing their decision setup. Propose 2–4 concrete improvements: missing drivers (including at least one downside/risk if none exists yet), and knock-on effects that form or strengthen a feedback loop between drivers. You may include a single 'note' for advice with no concrete add. Each suggestion has 'kind' = 'add_driver' | 'add_influence' | 'note', plus ONE plain sentence as 'message' that a non-expert understands and that says what it means for the decision (e.g. \"You haven't accounted for staff morale, which could quietly sink this.\"). For add_driver, include { variable: { id (lowercase slug, max 24 chars), name (everyday words), value 0-100, weight -100..100 (negative = hurts goal) } }. For add_influence, include { influence: { from, to, strength -100..100 } } where from/to are EXISTING variable ids from the provided model. Return ONLY JSON: { \"suggestions\": [...] }.\n\n" +
  STYLE_RULE;

const SYS_OPTIONS =
  "You are a trusted second opinion helping a decision-maker think of better choices. Propose 1–3 genuinely DIFFERENT strategies the decision-maker hasn't considered. Each strategy must be a realistic mix of BOOSTS and COSTS (real trade-offs — not all-positive). You may also include a single 'note' if two existing options look near-duplicates. Each suggestion has 'kind' = 'add_option' | 'note', plus ONE plain sentence as 'message' that a non-expert understands and that says what the strategy is and why it's worth considering. For add_option, include { option: { name (3–4 words, plain), pushes: { <variableId>: number -60..60 } } } using ONLY existing variable ids from the provided model. Include both positive AND negative push values. Return ONLY JSON: { \"suggestions\": [...] }.\n\n" +
  STYLE_RULE;

function slugifyVarId(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "driver"
  );
}

export const improveModel = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ImproveInput.parse(data))
  .handler(async ({ data }): Promise<{ suggestions: ImproveSuggestion[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const sys = data.focus === "options" ? SYS_OPTIONS : SYS_MODEL;
    const payload = {
      outcomeName: data.model.outcomeName,
      horizon: data.model.horizon,
      variables: data.model.variables.map((v) => ({
        id: v.id,
        name: v.name,
        value: v.value,
        weight: v.weight,
      })),
      influences: data.model.influences,
      options: data.model.options.map((o) => ({ name: o.name, pushes: o.pushes })),
    };

    const content = await callGateway(apiKey, sys, "Model:\n" + JSON.stringify(payload), true);
    const parsed = parseJson<{ suggestions?: unknown }>(content);

    const out: ImproveSuggestion[] = [];
    const existingIds = new Set(data.model.variables.map((v) => v.id));
    const usedNewIds = new Set<string>();
    const existingOptionNames = new Set(data.model.options.map((o) => o.name.trim().toLowerCase()));
    const max = data.focus === "options" ? 3 : 4;

    if (Array.isArray(parsed.suggestions)) {
      for (const raw of parsed.suggestions) {
        if (!raw || typeof raw !== "object") continue;
        const s = raw as Record<string, unknown>;
        const message = typeof s.message === "string" ? s.message.trim().slice(0, 220) : "";
        if (!message) continue;
        const kind = s.kind;

        if (kind === "add_driver" && data.focus === "model") {
          const v = (s.variable ?? {}) as Record<string, unknown>;
          const name = typeof v.name === "string" ? v.name.trim().slice(0, 60) : "";
          if (!name) continue;
          let id = slugifyVarId(typeof v.id === "string" && v.id ? v.id : name);
          while (existingIds.has(id) || usedNewIds.has(id))
            id = id + "_" + Math.random().toString(36).slice(2, 4);
          usedNewIds.add(id);
          out.push({
            kind: "add_driver",
            message,
            variable: {
              id,
              name,
              value: Math.max(0, Math.min(100, Number(v.value) || 50)),
              weight: Math.max(-100, Math.min(100, Number(v.weight) || 0)),
            },
          });
        } else if (kind === "add_influence" && data.focus === "model") {
          const i = (s.influence ?? {}) as Record<string, unknown>;
          const from = String(i.from ?? "");
          const to = String(i.to ?? "");
          if (!existingIds.has(from) || !existingIds.has(to) || from === to) continue;
          out.push({
            kind: "add_influence",
            message,
            influence: {
              from,
              to,
              strength: Math.max(-100, Math.min(100, Number(i.strength) || 0)),
            },
          });
        } else if (kind === "add_option" && data.focus === "options") {
          const o = (s.option ?? {}) as Record<string, unknown>;
          const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
          if (!name || existingOptionNames.has(name.toLowerCase())) continue;
          const pushesRaw = (o.pushes ?? {}) as Record<string, unknown>;
          const pushes: Record<string, number> = {};
          for (const [k, val] of Object.entries(pushesRaw)) {
            if (!existingIds.has(k)) continue;
            const n = Math.max(-60, Math.min(60, Number(val) || 0));
            if (n !== 0) pushes[k] = n;
          }
          if (Object.keys(pushes).length === 0) continue;
          existingOptionNames.add(name.toLowerCase());
          out.push({ kind: "add_option", message, option: { name, pushes } });
        } else if (kind === "note") {
          out.push({ kind: "note", message });
        }
        if (out.length >= max) break;
      }
    }
    return { suggestions: out };
  });

/* ---------------------------- suggestActions ----------------------------- */

const EFFORTS_S = ["low", "med", "high"] as const;
const WHENS_S = ["now", "soon", "ongoing"] as const;
const ActionSchema = z.object({
  text: z.string(),
  targets: z.array(z.string()).optional(),
  effort: z.enum(EFFORTS_S).optional(),
  when: z.enum(WHENS_S).optional(),
});
export type SuggestedAction = z.infer<typeof ActionSchema>;

const SuggestActionsInput = z.object({
  decision: z.string().default(""),
  outcomeName: z.string().default(""),
  variables: z.array(VariableSchema),
  option: OptionSchema,
});

export const suggestActions = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SuggestActionsInput.parse(data))
  .handler(async ({ data }): Promise<{ actions: SuggestedAction[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const sys =
      "You are a decision-execution coach. Given a decision, its outcome, the drivers in play, and ONE option (with how it moves each driver per step), propose 2–4 concrete, operational actions a team could actually execute this quarter to realise that option. Do not restate what the option moves — translate it into actions. Tag each action with the variable id(s) it primarily moves via `targets` (only ids that exist in `variables`, preferably ones the option actually moves). Set `effort` to one of 'low'|'med'|'high' and `when` to 'now'|'soon'|'ongoing'. Keep each `text` under 140 characters, written as a clear instruction in everyday language a non-expert would understand. Return ONLY JSON: { \"actions\": [{ text, targets, effort, when }] }.\n\nWRITING STYLE: Write every human-readable field (summary, rationale, explanation, message) in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Instead say: driver / what's driving this; knock-on effect; helps or hurts your goal; how it plays out; how often it comes out best. Keep it short and specific, and always say what it means for the decision.";

    const payload = {
      decision: data.decision,
      outcomeName: data.outcomeName,
      variables: data.variables.map((v) => ({
        id: v.id,
        name: v.name,
        weight: v.weight,
        value: v.value,
      })),
      option: { name: data.option.name, pushes: data.option.pushes },
    };

    const content = await callGateway(apiKey, sys, "Context:\n" + JSON.stringify(payload), true);
    const parsed = parseJson<{ actions?: unknown }>(content);
    const validIds = new Set(data.variables.map((v) => v.id));
    const out: SuggestedAction[] = [];
    if (Array.isArray(parsed.actions)) {
      for (const a of parsed.actions) {
        if (!a || typeof a !== "object") continue;
        const aa = a as Record<string, unknown>;
        const text = typeof aa.text === "string" ? aa.text.trim().slice(0, 160) : "";
        if (!text) continue;
        const targetsSrc = Array.isArray(aa.targets) ? aa.targets : [];
        const targets = (targetsSrc as unknown[])
          .map((t) => String(t))
          .filter((t) => validIds.has(t));
        const effort = (EFFORTS_S as readonly string[]).includes(aa.effort as string)
          ? (aa.effort as SuggestedAction["effort"])
          : undefined;
        const when = (WHENS_S as readonly string[]).includes(aa.when as string)
          ? (aa.when as SuggestedAction["when"])
          : undefined;
        const act: SuggestedAction = { text };
        if (targets.length) act.targets = targets;
        if (effort) act.effort = effort;
        if (when) act.when = when;
        out.push(act);
        if (out.length >= 4) break;
      }
    }
    if (!out.length) throw new Error("Decision Lens AI returned no actions");
    return { actions: out };
  });
