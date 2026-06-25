import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const FileItem = z.object({
  name: z.string().min(1).max(300),
  dataBase64: z.string().min(1),
});

const Input = z.object({
  files: z.array(FileItem).max(5).default([]),
  urls: z.array(z.string().url()).max(8).default([]),
  decisionText: z.string().min(1).max(2000),
});

const SYSTEM_PROMPT =
  "You are a systems analyst applying world-model thinking. Given a decision and supporting source excerpts, model the decision as a compact dynamical system. Find 3–6 latent variables that actually drive the outcome (not surface facts); mark each as helping (+weight) or hurting (-weight) and where it stands today, with a one-line rationale grounded in the sources when possible. Add 2–5 influences forming at least one feedback loop, each with a rationale. Define 2–4 options that are genuinely different strategies; each option's pushes say how it nudges each variable per step. Provide a 1–2 sentence summary of what the documents told you, and list which sources you used. Return ONLY JSON.";

const JSON_SHAPE_HINT = `Return ONLY a JSON object matching exactly:
{
  "outcomeName": string,
  "horizon": integer 4-36,
  "summary": string,
  "sources": [{ "name": string, "type": "pdf" | "url" }],
  "variables":  [{ "id": string, "name": string, "value": number 0-100, "weight": number -100..100, "rationale": string }],
  "influences": [{ "from": string, "to": string, "strength": number -100..100, "rationale": string }],
  "options":    [{ "name": string, "pushes": { "<variableId>": number -60..60 } }]
}
Ids must be short lowercase slugs. All influence.from/to and pushes keys must be ids present in variables.`;

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

async function fetchUrlText(rawUrl: string): Promise<{ name: string; text: string } | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isPrivateHost(u.hostname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "DecisionLens/1.0 (+ingest)" },
    });
    if (!res.ok) return null;
    // Cap body size
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_URL_BYTES) { try { await reader.cancel(); } catch { /* */ } break; }
      chunks.push(value);
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, buf.length - off)), off); off += c.length; if (off >= buf.length) break; }
    const ct = res.headers.get("content-type") || "";
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const text = ct.includes("html") || /<\w+[\s>]/.test(body.slice(0, 200)) ? htmlToText(body) : body;
    return { name: u.hostname + u.pathname, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractPdfText(name: string, dataBase64: string): Promise<{ name: string; text: string } | null> {
  try {
    const bytes = decodeBase64ToBytes(dataBase64);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : String(text || "");
    return { name, text: joined };
  } catch (e) {
    console.error("pdf extract failed", name, e);
    return null;
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
    throw new Error(`AI gateway ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI gateway returned no content");
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
    if (retry) return callGateway(apiKey, decisionText, labelled, false);
    throw new Error("AI gateway returned non-JSON content");
  }
}

export const ingestSources = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const items: Array<{ name: string; text: string; kind: "pdf" | "url" }> = [];

    // PDFs
    for (const f of data.files) {
      const r = await extractPdfText(f.name, f.dataBase64);
      if (r && r.text.trim()) items.push({ name: r.name, text: r.text, kind: "pdf" });
    }
    // URLs (in parallel)
    const urlResults = await Promise.all(data.urls.map((u) => fetchUrlText(u)));
    for (const r of urlResults) {
      if (r && r.text.trim()) items.push({ name: r.name, text: r.text, kind: "url" });
    }

    const { labelled, sources } = budgetExcerpts(items, MAX_TOTAL_CHARS);
    const parsed = await callGateway(apiKey, data.decisionText, labelled, true);

    // attach sources if missing
    if (parsed && typeof parsed === "object" && !(parsed as any).sources) {
      (parsed as any).sources = sources;
    }
    return parsed;
  });
