import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  decisionText: z.string().min(1).max(2000),
});

export type DraftedModel = {
  outcomeName?: string;
  horizon?: number;
  variables?: Array<{ id?: string; name?: string; value?: number; weight?: number }>;
  influences?: Array<{ from?: string; to?: string; strength?: number }>;
  options?: Array<{ name?: string; pushes?: Record<string, number>; actions?: Array<{ text?: string; targets?: string[]; effort?: "low" | "med" | "high"; when?: "now" | "soon" | "ongoing" }> }>;
};

const SYSTEM_PROMPT =
  "You are a systems analyst applying world-model thinking. Given a decision, model it as a compact dynamical system. Find 3–6 latent variables that actually drive the outcome (not surface facts); mark each as helping (+weight) or hurting (-weight) and where it stands today. Add 2–5 influences forming at least one feedback loop. Define 2–4 options that are genuinely different strategies; each option's pushes say how it nudges each variable per step. For each option, list 2–4 concrete, operational actions a team could actually execute (not restatements of the push). Tag each action with the variable id(s) it primarily moves via `targets`, set `effort` (low/med/high) and `when` (now/soon/ongoing). Return ONLY JSON.\n\nWRITING STYLE: Write every human-readable field (summary, rationale, explanation, message) in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Instead say: driver / what's driving this; knock-on effect; helps or hurts your goal; how it plays out; how often it comes out best. Keep it short and specific, and always say what it means for the decision. When you name a driver, use everyday words anyone in the room would recognise, and make sure the reason it matters to this decision is obvious from the wording itself.";

const JSON_SHAPE_HINT = `Return ONLY a JSON object matching exactly:
{
  "outcomeName": string,
  "horizon": integer 4-36,
  "variables": [{ "id": string, "name": string, "value": number 0-100, "weight": number -100..100 }],
  "influences": [{ "from": string, "to": string, "strength": number -100..100 }],
  "options":    [{ "name": string, "pushes": { "<variableId>": number -60..60 },
                   "actions": [{ "text": string (<=160 chars), "targets": [variableId, ...], "effort": "low"|"med"|"high", "when": "now"|"soon"|"ongoing" }] }]
}
Each option MUST include 2–4 actions. Ids must be short lowercase slugs. All influence.from/to, pushes keys, and action.targets must be ids present in variables.`;

export const draftModel = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { rateLimit, validateAndClampModel } = await import("./ai-guard.server");
    rateLimit("draftModel", { perMinute: 10 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI_HTTP_ERROR: LOVABLE_API_KEY missing");

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
          { role: "user", content: data.decisionText },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("draftModel gateway error", { status: res.status, body: body.slice(0, 200) });
      throw new Error(`AI_HTTP_ERROR: gateway ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI_BAD_JSON: gateway returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI_BAD_JSON: gateway returned non-JSON content");
      try { parsed = JSON.parse(m[0]); } catch { throw new Error("AI_BAD_JSON: gateway returned non-JSON content"); }
    }
    return validateAndClampModel(parsed) as DraftedModel;
  });


