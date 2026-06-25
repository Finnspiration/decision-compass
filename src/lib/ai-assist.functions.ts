import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/* -------------------------------- shared --------------------------------- */

const VariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  value: z.number(),
  weight: z.number(),
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

async function callGateway(apiKey: string, system: string, user: string, json = true): Promise<string> {
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
    if (res.status === 429) throw new Error("Decision Lens AI is rate-limited. Please try again shortly.");
    if (res.status === 402) throw new Error("Decision Lens AI credits exhausted. Add credits in Settings → Plans & credits.");
    throw new Error(`Decision Lens AI error ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("Decision Lens AI returned no content");
  return content;
}

function parseJson<T>(content: string): T {
  try { return JSON.parse(content) as T; } catch { /* fallthrough */ }
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
      variables: data.model.variables.map((v) => ({ id: v.id, name: v.name, value: v.value, weight: v.weight })),
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

/* ----------------------------- critiqueModel ----------------------------- */

const CritiqueInput = z.object({ model: ModelSchema });

export type CritiqueSuggestion = {
  kind: "add_variable" | "add_influence" | "note";
  message: string;
  variable?: { id: string; name: string; value: number; weight: number };
  influence?: { from: string; to: string; strength: number };
};

export const critiqueModel = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => CritiqueInput.parse(data))
  .handler(async ({ data }): Promise<{ suggestions: CritiqueSuggestion[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const sys =
      "You are a systems-thinking reviewer. Critique the user's decision model and return 2–4 concrete suggestions. Look for: missing drivers, absent or weak feedback loops, near-duplicate options, or a missing risk (negative-weight) variable. Each suggestion has 'kind' = 'add_variable' | 'add_influence' | 'note', a short 'message' (one sentence). For add_variable, also include { id (lowercase slug), name, value 0-100, weight -100..100 }. For add_influence, include { from, to, strength -100..100 } where from/to are existing variable ids. Return ONLY JSON: { \"suggestions\": [...] }.";

    const content = await callGateway(
      apiKey,
      sys,
      "Model:\n" + JSON.stringify(data.model),
      true,
    );
    const parsed = parseJson<{ suggestions?: CritiqueSuggestion[] }>(content);
    const out: CritiqueSuggestion[] = [];
    const ids = new Set(data.model.variables.map((v) => v.id));
    for (const s of parsed.suggestions ?? []) {
      if (!s || typeof s.message !== "string") continue;
      if (s.kind === "add_variable" && s.variable) {
        const v = s.variable;
        if (!v.id || !v.name) continue;
        out.push({
          kind: "add_variable",
          message: s.message.slice(0, 200),
          variable: {
            id: String(v.id).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24),
            name: String(v.name).slice(0, 60),
            value: Math.max(0, Math.min(100, Number(v.value) || 50)),
            weight: Math.max(-100, Math.min(100, Number(v.weight) || 0)),
          },
        });
      } else if (s.kind === "add_influence" && s.influence) {
        const i = s.influence;
        if (!ids.has(i.from) || !ids.has(i.to)) continue;
        out.push({
          kind: "add_influence",
          message: s.message.slice(0, 200),
          influence: {
            from: i.from,
            to: i.to,
            strength: Math.max(-100, Math.min(100, Number(i.strength) || 0)),
          },
        });
      } else {
        out.push({ kind: "note", message: s.message.slice(0, 200) });
      }
      if (out.length >= 4) break;
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
      "You are a decision-execution coach. Given a decision, its outcome, the latent variables in play, and ONE option (with the pushes it applies per step), propose 2–4 concrete, operational actions a team could actually execute this quarter to realise that option. Do not restate the pushes — translate them into actions. Tag each action with the variable id(s) it primarily moves via `targets` (only ids that exist in `variables`, preferably ones the option actually pushes). Set `effort` to one of 'low'|'med'|'high' and `when` to 'now'|'soon'|'ongoing'. Keep each `text` under 140 characters. Return ONLY JSON: { \"actions\": [{ text, targets, effort, when }] }.";

    const payload = {
      decision: data.decision,
      outcomeName: data.outcomeName,
      variables: data.variables.map((v) => ({ id: v.id, name: v.name, weight: v.weight, value: v.value })),
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
