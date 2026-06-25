// Server-only helpers: rate limiting + AI JSON validation/clamping.
import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";

// --------- Rate limit (per-IP sliding window, in-memory) ---------
// Note: per-instance only. Adequate as a soft guard, not a hard quota.
type Bucket = { hits: number[]; };
const buckets = new Map<string, Bucket>();

export function rateLimit(name: string, opts: { perMinute: number }): void {
  let ip = "unknown";
  try { ip = getRequestIP({ xForwardedFor: true }) || "unknown"; } catch { /* */ }
  if (ip === "unknown") {
    try { ip = getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"; } catch { /* */ }
  }
  const key = `${name}:${ip}`;
  const now = Date.now();
  const windowMs = 60_000;
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= opts.perMinute) {
    throw new Error("RATE_LIMITED: Too many requests. Please wait a minute and try again.");
  }

  b.hits.push(now);
  buckets.set(key, b);
  // Best-effort cleanup
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.hits.length === 0 || now - v.hits[v.hits.length - 1] > windowMs) buckets.delete(k);
    }
  }
}

// --------- AI JSON validation + clamping ---------
const clamp = (n: unknown, lo: number, hi: number, dflt = 0): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
};
const sstr = (s: unknown, max: number): string => {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
};
const slug = (s: unknown): string => {
  const raw = typeof s === "string" ? s : "";
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
};

export type SafeAction = {
  text: string;
  targets?: string[];
  effort?: "low" | "med" | "high";
  when?: "now" | "soon" | "ongoing";
};
export type SafeModel = {
  outcomeName: string;
  horizon: number;
  summary?: string;
  sources?: Array<{ name: string; type: "pdf" | "url" }>;
  variables: Array<{ id: string; name: string; value: number; weight: number; rationale?: string }>;
  influences: Array<{ from: string; to: string; strength: number; rationale?: string }>;
  options: Array<{ name: string; pushes: Record<string, number>; actions?: SafeAction[] }>;
};
const EFFORT_SET = new Set(["low", "med", "high"]);
const WHEN_SET = new Set(["now", "soon", "ongoing"]);

export function validateAndClampModel(raw: unknown): SafeModel {
  const r = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};

  const variablesIn = Array.isArray(r.variables) ? r.variables.slice(0, 8) : [];
  const seenIds = new Set<string>();
  const variables = variablesIn.map((v, i) => {
    const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
    let id = slug(o.id ?? o.name ?? `v${i + 1}`);
    if (!id) id = `v${i + 1}`;
    let uniq = id, k = 2;
    while (seenIds.has(uniq)) uniq = `${id}_${k++}`;
    seenIds.add(uniq);
    return {
      id: uniq,
      name: sstr(o.name ?? uniq, 80) || uniq,
      value: clamp(o.value, 0, 100, 50),
      weight: clamp(o.weight, -100, 100, 0),
      rationale: sstr(o.rationale, 300) || undefined,
    };
  });
  // Need at least one variable for influences/options to be meaningful
  const ids = new Set(variables.map((v) => v.id));

  const influencesIn = Array.isArray(r.influences) ? r.influences.slice(0, 16) : [];
  const influences = influencesIn
    .map((v) => {
      const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
      const from = slug(o.from);
      const to = slug(o.to);
      if (!ids.has(from) || !ids.has(to)) return null;
      return {
        from, to,
        strength: clamp(o.strength, -100, 100, 0),
        rationale: sstr(o.rationale, 300) || undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const optionsIn = Array.isArray(r.options) ? r.options.slice(0, 6) : [];
  const options = optionsIn.map((v, i) => {
    const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
    const pushesIn = (o.pushes && typeof o.pushes === "object") ? o.pushes as Record<string, unknown> : {};
    const pushes: Record<string, number> = {};
    let count = 0;
    for (const [k, val] of Object.entries(pushesIn)) {
      if (count >= 12) break;
      const id = slug(k);
      if (!ids.has(id)) continue;
      pushes[id] = clamp(val, -60, 60, 0);
      count++;
    }
    let actions: SafeAction[] | undefined;
    if (Array.isArray((o as any).actions)) {
      const arr: SafeAction[] = [];
      for (const a of (o as any).actions as unknown[]) {
        if (!a || typeof a !== "object") continue;
        const aa = a as Record<string, unknown>;
        const text = sstr(aa.text, 160).trim();
        if (!text) continue;
        const targetsSrc = Array.isArray(aa.targets) ? aa.targets : [];
        const targets = targetsSrc
          .map((t) => slug(t))
          .filter((t) => ids.has(t));
        const effort = EFFORT_SET.has(aa.effort as string) ? (aa.effort as SafeAction["effort"]) : undefined;
        const when = WHEN_SET.has(aa.when as string) ? (aa.when as SafeAction["when"]) : undefined;
        const act: SafeAction = { text };
        if (targets.length) act.targets = targets;
        if (effort) act.effort = effort;
        if (when) act.when = when;
        arr.push(act);
        if (arr.length >= 6) break;
      }
      if (arr.length) actions = arr;
    }
    return {
      name: sstr(o.name ?? `Option ${i + 1}`, 80) || `Option ${i + 1}`,
      pushes,
      ...(actions ? { actions } : {}),
    };
  });
  // Safety net: never return zero options — downstream UI requires at least one
  if (options.length === 0 && variables.length > 0) {
    options.push({ name: "Status quo", pushes: {} });
  }

  const sourcesIn = Array.isArray(r.sources) ? r.sources.slice(0, 16) : [];
  const sources = sourcesIn
    .map((v) => {
      const o = (v && typeof v === "object") ? (v as Record<string, unknown>) : {};
      const type = o.type === "pdf" || o.type === "url" ? o.type : "url";
      const name = sstr(o.name, 200);
      return name ? { name, type: type as "pdf" | "url" } : null;
    })
    .filter((x): x is { name: string; type: "pdf" | "url" } => x !== null);

  return {
    outcomeName: sstr(r.outcomeName, 120) || "Outcome",
    horizon: Math.round(clamp(r.horizon, 4, 36, 12)),
    summary: sstr(r.summary, 600) || undefined,
    sources: sources.length ? sources : undefined,
    variables,
    influences,
    options,
  };
}

/** True when the model has enough structure to be usable downstream. */
export function modelIsUsable(m: SafeModel): boolean {
  return m.variables.length > 0 && m.options.length > 0;
}

