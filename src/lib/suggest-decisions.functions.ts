import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_B64_CHARS = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1024;

const FileItem = z.object({
  name: z.string().min(1).max(300),
  dataBase64: z.string().min(1).max(MAX_PDF_B64_CHARS, "PDF exceeds 10MB limit"),
});

const Input = z.object({
  files: z.array(FileItem).max(5).default([]),
  urls: z.array(z.string().url().max(2048)).max(8).default([]),
  hint: z.string().max(2000).default(""),
});

export type DecisionSuggestion = { question: string; rationale: string };
export type SuggestDecisionsResult = {
  decisions: DecisionSuggestion[];
  skipped: Array<{ name: string; reason: string }>;
  degraded: boolean;
};

const SYSTEM_PROMPT =
  "You help a busy decision-maker pin down what they're actually deciding. Given supporting source excerpts (and optionally a rough hint from the user), propose 2–3 clearly different decisions the sources point to — the real choice in the room, not a summary of the documents. " +
  "Each decision MUST be written as a single direct question phrased as a genuine choice (\"Should we …?\", \"Which … should we …?\", \"Do we … or …?\"), under 140 characters, in everyday words. The 2–3 questions should be meaningfully distinct — different scope, timing, or trade-off — not rewordings of each other. " +
  "For each, give a one-sentence rationale in plain language that names the specific thing in the sources that points to this framing (e.g. \"Your sources keep coming back to falling retention in the first 30 days.\"). " +
  "Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Return ONLY JSON: { \"decisions\": [{ \"question\": string, \"rationale\": string }] }.";

async function callGateway(apiKey: string, hint: string, labelled: string): Promise<unknown> {
  const userContent = labelled
    ? (hint
        ? `Rough hint from the decision-maker (may be vague or empty): ${hint}\n\nSource excerpts:\n${labelled}`
        : `Source excerpts:\n${labelled}`)
    : `Rough hint from the decision-maker: ${hint || "(none)"}`;

  const body = {
    model: "google/gemini-3-flash-preview",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("suggestDecisions gateway error", { status: res.status, body: t.slice(0, 200) });
    if (res.status === 429) throw new Error("RATE_LIMITED: gateway 429");
    throw new Error(`AI_HTTP_ERROR: gateway ${res.status}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI_BAD_JSON: gateway returned no content");
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
    throw new Error("AI_BAD_JSON: gateway returned non-JSON content");
  }
}

function clampDecisions(raw: unknown): DecisionSuggestion[] {
  if (!raw || typeof raw !== "object") return [];
  const arr = (raw as { decisions?: unknown }).decisions;
  if (!Array.isArray(arr)) return [];
  const out: DecisionSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const question = typeof o.question === "string" ? o.question.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    if (!question) continue;
    const norm = question.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    const rationale = typeof o.rationale === "string" ? o.rationale.trim().replace(/\s+/g, " ").slice(0, 280) : "";
    out.push({ question, rationale });
    if (out.length >= 3) break;
  }
  return out;
}

export const suggestDecisions = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<SuggestDecisionsResult> => {
    const { rateLimit } = await import("./ai-guard.server");
    rateLimit("suggestDecisions", { perMinute: 8 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI_HTTP_ERROR: LOVABLE_API_KEY missing");

    const requestedSources = data.files.length + data.urls.length;
    if (requestedSources === 0) {
      // Nothing to suggest from. Caller should not invoke us in this state.
      return { decisions: [], skipped: [], degraded: true };
    }

    const {
      extractPdfTextStrict,
      fetchUrlTextStrict,
      budgetExcerpts,
      SkipError,
      MAX_TOTAL_CHARS,
    } = await import("./source-extract.server");

    const items: Array<{ name: string; text: string; kind: "pdf" | "url" }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const f of data.files) {
      try {
        const r = await extractPdfTextStrict(f.name, f.dataBase64);
        items.push({ name: r.name, text: r.text, kind: "pdf" });
      } catch (e) {
        const reason = e instanceof SkipError ? e.reason : "pdf_parse_failed";
        skipped.push({ name: f.name, reason });
      }
    }

    const urlResults = await Promise.allSettled(data.urls.map((u) => fetchUrlTextStrict(u)));
    urlResults.forEach((r, i) => {
      const rawName = data.urls[i];
      if (r.status === "fulfilled") {
        items.push({ name: r.value.name, text: r.value.text, kind: "url" });
      } else {
        const reason = r.reason instanceof SkipError ? r.reason.reason : "http_error";
        skipped.push({ name: rawName, reason });
      }
    });

    const degraded = items.length === 0;
    const { labelled } = budgetExcerpts(items, MAX_TOTAL_CHARS);

    const parsed = await callGateway(apiKey, data.hint, labelled);
    const decisions = clampDecisions(parsed);
    if (decisions.length === 0) throw new Error("AI_BAD_JSON: no decisions returned");

    return { decisions, skipped, degraded };
  });
