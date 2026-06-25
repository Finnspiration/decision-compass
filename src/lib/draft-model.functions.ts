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
  options?: Array<{ name?: string; pushes?: Record<string, number> }>;
};

const SYSTEM_PROMPT =
  "You are a systems analyst applying world-model thinking. Given a decision, model it as a compact dynamical system. Find 3–6 latent variables that actually drive the outcome (not surface facts); mark each as helping (+weight) or hurting (-weight) and where it stands today. Add 2–5 influences forming at least one feedback loop. Define 2–4 options that are genuinely different strategies; each option's pushes say how it nudges each variable per step. Return ONLY JSON.";

const JSON_SHAPE_HINT = `Return ONLY a JSON object matching exactly:
{
  "outcomeName": string,
  "horizon": integer 4-36,
  "variables": [{ "id": string, "name": string, "value": number 0-100, "weight": number -100..100 }],
  "influences": [{ "from": string, "to": string, "strength": number -100..100 }],
  "options":    [{ "name": string, "pushes": { "<variableId>": number -60..60 } }]
}
Ids must be short lowercase slugs. All influence.from/to and pushes keys must be ids present in variables.`;

export const draftModel = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { rateLimit, validateAndClampModel } = await import("./ai-guard.server");
    rateLimit("draftModel", { perMinute: 10 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

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
      throw new Error(`AI gateway ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI gateway returned no content");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI gateway returned non-JSON content");
      parsed = JSON.parse(m[0]);
    }
    return validateAndClampModel(parsed) as DraftedModel;
  });

