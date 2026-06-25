/**
 * Shared, server-only source extraction helpers.
 *
 * Used by ingest-sources.functions.ts AND suggest-decisions.functions.ts.
 * Kept in a *.server.ts so Vite blocks it from client bundles even when
 * dynamically imported from a *.functions.ts handler.
 */

export const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB per PDF
export const MAX_URL_BYTES = 2 * 1024 * 1024;
export const URL_TIMEOUT_MS = 8_000;
export const MAX_TOTAL_CHARS = 60_000;

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

export class SkipError extends Error {
  reason: SkipReason;
  constructor(reason: SkipReason, msg?: string) {
    super(msg || reason);
    this.reason = reason;
  }
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "ip6-localhost") return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1" || h === "[::1]") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
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
  if (h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe80")) return true;
  return false;
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function htmlToText(html: string): string {
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

export async function fetchUrlTextStrict(rawUrl: string): Promise<{ name: string; text: string }> {
  let current = rawUrl;
  let lastName = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new SkipError("non_https", "invalid URL");
    }
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
        headers: {
          "User-Agent": "DecisionLens/1.0 (+ingest)",
          Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        },
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
      if (ct && !/^(text\/|application\/(json|xml|xhtml))/.test(ct))
        throw new SkipError("bad_content_type", ct);

      const reader = res.body?.getReader();
      if (!reader) throw new SkipError("empty");
      let received = 0;
      const chunks: Uint8Array[] = [];
      let overflowed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > MAX_URL_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* */
          }
          overflowed = true;
          break;
        }
        received += value.length;
        chunks.push(value);
      }
      if (overflowed && received === 0) throw new SkipError("oversized");
      const buf = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const text =
        ct.includes("html") || /<\w+[\s>]/.test(body.slice(0, 200)) ? htmlToText(body) : body;
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

export async function extractPdfTextStrict(
  name: string,
  dataBase64: string,
): Promise<{ name: string; text: string }> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64ToBytes(dataBase64);
  } catch {
    throw new SkipError("not_pdf", "invalid base64");
  }
  if (bytes.length === 0) throw new SkipError("empty");
  if (bytes.length > MAX_PDF_BYTES) throw new SkipError("oversized");
  if (
    !(
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d
    )
  ) {
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

export function budgetExcerpts(
  items: Array<{ name: string; text: string; kind: "pdf" | "url" }>,
  totalBudget: number,
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
