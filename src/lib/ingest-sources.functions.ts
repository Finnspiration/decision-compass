import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB per PDF
// base64 expands by ~4/3; cap raw string accordingly with slack
const MAX_PDF_B64_CHARS = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 1024;

const FileItem = z.object({
  name: z.string().min(1).max(300),
  dataBase64: z.string().min(1).max(MAX_PDF_B64_CHARS, "PDF exceeds 10MB limit"),
});

const Input = z.object({
  files: z.array(FileItem).max(5).default([]),
  urls: z.array(z.string().url().max(2048)).max(8).default([]),
  decisionText: z.string().min(1).max(2000),
});


const SYSTEM_PROMPT =
  "You are a systems analyst applying world-model thinking. Given a decision and supporting source excerpts, model the decision as a compact dynamical system. Find 3–6 latent variables that actually drive the outcome (not surface facts); mark each as helping (+weight) or hurting (-weight) and where it stands today, with a one-line rationale grounded in the sources when possible. Add 2–5 influences forming at least one feedback loop, each with a rationale. Define 2–4 options that are genuinely different strategies; each option's pushes say how it nudges each variable per step. For each option, list 2–4 concrete, operational actions a team could actually execute (not restatements of the push). Tag each action with the variable id(s) it primarily moves via `targets`, set `effort` (low/med/high) and `when` (now/soon/ongoing). When sources are provided, ground actions in them. Provide a 1–2 sentence summary of what the documents told you, and list which sources you used. Return ONLY JSON.\n\nWRITING STYLE: Write every human-readable field (summary, rationale, explanation, message) in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push. Instead say: driver / what's driving this; knock-on effect; helps or hurts your goal; how it plays out; how often it comes out best. Keep it short and specific, and always say what it means for the decision. Each variable rationale should be one short sentence in everyday words that says why this driver matters to THIS decision (e.g. 'How much your team trusts the plan — if it drops, execution slows'). The summary should sound like a plain-English brief, not an analyst's notes.";

const JSON_SHAPE_HINT = `Return ONLY a JSON object matching exactly:
{
  "outcomeName": string,
  "horizon": integer 4-36,
  "summary": string,
  "sources": [{ "name": string, "type": "pdf" | "url" }],
  "variables":  [{ "id": string, "name": string, "value": number 0-100, "weight": number -100..100, "rationale": string }],
  "influences": [{ "from": string, "to": string, "strength": number -100..100, "rationale": string }],
  "options":    [{ "name": string, "pushes": { "<variableId>": number -60..60 },
                   "actions": [{ "text": string (<=160 chars), "targets": [variableId, ...], "effort": "low"|"med"|"high", "when": "now"|"soon"|"ongoing" }] }]
}
Each option MUST include 2–4 actions. Ids must be short lowercase slugs. All influence.from/to, pushes keys, and action.targets must be ids present in variables.`;

const MAX_TOTAL_CHARS = 60_000;
const MAX_URL_BYTES = 2 * 1024 * 1024;
const URL_TIMEOUT_MS = 8_000;

/** Block obvious SSRF targets without DNS resolution. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "ip6-localhost") return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1" || h === "[::1]") return true;
  // metadata services
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  // IPv4 literal
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
  }
  // IPv6 unique-local / link-local
  if (h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe80")) return true;
  return false;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  // strip optional data: prefix
  const cleaned = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export type SkipReason =
  | "oversized"
  | "not_pdf"
  | "pdf_parse_failed"
  | "private_host"
  | "non_https"
  | "timeout"
  | "bad_content_type"
  | "http_error"
  | "empty";

export type SkippedSource = { name: string; reason: SkipReason };

class SkipError extends Error {
  reason: SkipReason;
  constructor(reason: SkipReason, msg?: string) { super(msg || reason); this.reason = reason; }
}

async function fetchUrlTextStrict(rawUrl: string): Promise<{ name: string; text: string }> {
  let current = rawUrl;
  let lastName = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { throw new SkipError("non_https", "invalid URL"); }
    if (u.protocol !== "https:") throw new SkipError("non_https");
    if (isPrivateHost(u.hostname)) throw new SkipError("private_host");
    lastName = u.hostname + u.pathname;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
    try {
      const res = await fetch(u.toString(), {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "User-Agent": "DecisionLens/1.0 (+ingest)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new SkipError("http_error", `redirect ${res.status} without location`);
        current = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok) throw new SkipError("http_error", `http ${res.status}`);

      const declared = Number(res.headers.get("content-length") || "0");
      if (declared && declared > MAX_URL_BYTES) throw new SkipError("oversized");
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct && !/^(text\/|application\/(json|xml|xhtml))/.test(ct)) throw new SkipError("bad_content_type", ct);

      const reader = res.body?.getReader();
      if (!reader) throw new SkipError("empty");
      let received = 0;
      const chunks: Uint8Array[] = [];
      let overflowed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > MAX_URL_BYTES) {
          try { await reader.cancel(); } catch { /* */ }
          overflowed = true;
          break;
        }
        received += value.length;
        chunks.push(value);
      }
      if (overflowed && received === 0) throw new SkipError("oversized");
      const buf = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const text = ct.includes("html") || /<\w+[\s>]/.test(body.slice(0, 200)) ? htmlToText(body) : body;
      if (!text.trim()) throw new SkipError("empty");
      return { name: lastName, text };
    } catch (e) {
      if (e instanceof SkipError) throw e;
      if ((e as { name?: string })?.name === "AbortError") throw new SkipError("timeout");
      throw new SkipError("http_error", (e as Error)?.message || "fetch failed");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SkipError("http_error", "too many redirects");
}

async function extractPdfTextStrict(name: string, dataBase64: string): Promise<{ name: string; text: string }> {
  let bytes: Uint8Array;
  try { bytes = decodeBase64ToBytes(dataBase64); }
  catch { throw new SkipError("not_pdf", "invalid base64"); }
  if (bytes.length === 0) throw new SkipError("empty");
  if (bytes.length > MAX_PDF_BYTES) throw new SkipError("oversized");
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)) {
    throw new SkipError("not_pdf");
  }
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : String(text || "");
    if (!joined.trim()) throw new SkipError("empty");
    return { name, text: joined };
  } catch (e) {
    if (e instanceof SkipError) throw e;
    throw new SkipError("pdf_parse_failed", (e as Error)?.message || "unpdf failed");
  }
}


function budgetExcerpts(
  items: Array<{ name: string; text: string; kind: "pdf" | "url" }>,
  totalBudget: number
): { labelled: string; sources: Array<{ name: string; type: "pdf" | "url" }> } {
  const sources: Array<{ name: string; type: "pdf" | "url" }> = [];
  const nonEmpty = items.filter((i) => i.text.trim().length > 0);
  if (nonEmpty.length === 0) return { labelled: "", sources };
  const perItem = Math.max(800, Math.floor(totalBudget / nonEmpty.length));
  const parts: string[] = [];
  for (const it of nonEmpty) {
    const slice = it.text.replace(/\s+/g, " ").trim().slice(0, perItem);
    sources.push({ name: it.name, type: it.kind });
    parts.push(`=== SOURCE (${it.kind}): ${it.name} ===\n${slice}`);
  }
  let labelled = parts.join("\n\n");
  if (labelled.length > totalBudget) labelled = labelled.slice(0, totalBudget);
  return { labelled, sources };
}

async function callGateway(
  apiKey: string,
  decisionText: string,
  labelled: string,
  retry: boolean
): Promise<unknown> {
  const userContent = labelled
    ? `Decision: ${decisionText}\n\nSource excerpts:\n${labelled}`
    : `Decision: ${decisionText}`;

  const body = {
    model: "google/gemini-3-flash-preview",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + JSON_SHAPE_HINT },
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
    console.error("ingestSources gateway error", { status: res.status, body: t.slice(0, 200) });
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
    if (retry) return callGateway(apiKey, decisionText, labelled, false);
    throw new Error("AI_BAD_JSON: gateway returned non-JSON content");
  }
}

export type IngestResult = {
  outcomeName?: string;
  horizon?: number;
  summary?: string;
  sources?: Array<{ name: string; type: "pdf" | "url" }>;
  variables?: Array<{ id?: string; name?: string; value?: number; weight?: number; rationale?: string }>;
  influences?: Array<{ from?: string; to?: string; strength?: number; rationale?: string }>;
  options?: Array<{ name?: string; pushes?: Record<string, number>; actions?: Array<{ text?: string; targets?: string[]; effort?: "low" | "med" | "high"; when?: "now" | "soon" | "ongoing" }> }>;
  skipped?: SkippedSource[];
  degraded?: boolean;
};

export const ingestSources = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<IngestResult> => {
    const { rateLimit, validateAndClampModel, modelIsUsable } = await import("./ai-guard.server");
    rateLimit("ingestSources", { perMinute: 6 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI_HTTP_ERROR: LOVABLE_API_KEY missing");

    const items: Array<{ name: string; text: string; kind: "pdf" | "url" }> = [];
    const skipped: SkippedSource[] = [];
    const requestedSources = data.files.length + data.urls.length;

    for (const f of data.files) {
      try {
        const r = await extractPdfTextStrict(f.name, f.dataBase64);
        items.push({ name: r.name, text: r.text, kind: "pdf" });
      } catch (e) {
        const reason = e instanceof SkipError ? e.reason : "pdf_parse_failed";
        console.error("ingestSources pdf skipped", { name: f.name, reason, msg: (e as Error)?.message });
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
        console.error("ingestSources url skipped", { url: rawName, reason, msg: (r.reason as Error)?.message });
        skipped.push({ name: rawName, reason });
      }
    });

    const degraded = requestedSources > 0 && items.length === 0;
    const { labelled, sources } = budgetExcerpts(items, MAX_TOTAL_CHARS);

    const parsed = await callGateway(apiKey, data.decisionText, labelled, true);
    const safe = validateAndClampModel(parsed);
    if (!modelIsUsable(safe)) {
      throw new Error("AI_BAD_JSON: model has no variables");
    }
    const result: IngestResult = { ...safe, skipped, degraded };
    if (!Array.isArray(result.sources) || result.sources.length === 0) {
      result.sources = sources;
    }
    return result;
  });

