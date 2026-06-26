import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { classifyZone } from "./estuarine";

/* ------------------------------- schemas --------------------------------- */

const VariableIn = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  weight: z.number().min(-100).max(100).optional().default(0),
  effortToChange: z.enum(["low", "med", "high"]).optional(),
  timeToChange: z.enum(["now", "soon", "ongoing", "years"]).optional(),
});
const OptionIn = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  pushes: z.record(z.string(), z.number()).optional().default({}),
});

const Input = z.object({
  model: z.object({
    decision: z.string().max(400).optional(),
    outcomeName: z.string().max(200).optional(),
    variables: z.array(VariableIn).min(1).max(16),
    options: z.array(OptionIn).optional().default([]),
  }),
});

/* ------------------------------- output ---------------------------------- */

const EFFORTS = ["low", "med", "high"] as const;
const WHENS = ["now", "soon", "ongoing"] as const;

export type EstuarineNudge = {
  text: string;
  targets: string[];
  effort?: (typeof EFFORTS)[number];
  when?: (typeof WHENS)[number];
};
export type EstuarineProbe = EstuarineNudge & {
  watchFor: string;
  duration: string;
};
export type EstuarineDesignAround = {
  driverId: string;
  text: string;
};
export type EstuarinePlan = {
  nudges: EstuarineNudge[];
  probes: EstuarineProbe[];
  designArounds: EstuarineDesignAround[];
};

/* --------------------------------- AI ------------------------------------ */

const STYLE_RULE =
  "WRITING STYLE: Write every human-readable field in plain, concrete language for a decision-maker with no math or modelling background. Never use the words: latent, variable, feedback loop, influence, coefficient, weight, simulate, Monte-Carlo, probability distribution, trajectory, push, Cynefin, estuarine, granite, sandbank, open water, monster, complex domain. Say instead: driver, knock-on effect, helps or hurts your goal, quick to change, slow to change, hard to budge. Keep sentences short and specific.";

const SYSTEM_PROMPT =
  "You help a decision-maker turn a positioned set of drivers into a sensible action strategy.\n" +
  "You receive the decision, the goal, and three buckets of drivers tagged by how movable they are:\n" +
  "  - QUICK_TO_MOVE drivers: easy to nudge in days or weeks.\n" +
  "  - WORTH_TESTING drivers: uncertain — worth a small, safe experiment.\n" +
  "  - HARD_TO_MOVE drivers: stuck or slow no matter what; accept and plan around them.\n" +
  "Return ONE concrete strategy with three lists:\n" +
  "  - nudges: 2-4 small, immediate moves on QUICK_TO_MOVE drivers.\n" +
  "  - probes: 1-3 small safe experiments on WORTH_TESTING drivers. Each MUST include `watchFor` (one short sentence shaped as 'scale up if … / drop it if …') and `duration` (e.g. '2 weeks', '1 month').\n" +
  "  - designArounds: one item per HARD_TO_MOVE driver — a short sentence on how to accept it and design around it. Use the driver's id in `driverId`.\n" +
  "Each nudge/probe carries `targets` (driver ids from the matching bucket only), `effort` ('low'|'med'|'high'), `when` ('now'|'soon'|'ongoing'), and `text` under 140 chars written as a clear instruction.\n" +
  "If a bucket has no drivers, return an empty list for it.\n" +
  "Return ONLY JSON of shape:\n" +
  '{ "nudges": [{ "text", "targets": [id], "effort", "when" }], "probes": [{ "text", "targets": [id], "effort", "when", "watchFor", "duration" }], "designArounds": [{ "driverId", "text" }] }\n\n' +
  STYLE_RULE;

/* ------------------------------ server fn -------------------------------- */

function emptyPlan(): EstuarinePlan {
  return { nudges: [], probes: [], designArounds: [] };
}

export const estuarinePlan = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<EstuarinePlan> => {
    const { rateLimit } = await import("./ai-guard.server");
    rateLimit("estuarinePlan", { perMinute: 6 });

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI_HTTP_ERROR: LOVABLE_API_KEY missing");

    // Bucket drivers by zone using the pure helper.
    const openWaterIds = new Set<string>();
    const sandbankIds = new Set<string>();
    const graniteIds = new Set<string>();
    const byId = new Map<string, { id: string; name: string; weight: number }>();
    for (const v of data.model.variables) {
      byId.set(v.id, { id: v.id, name: v.name, weight: v.weight ?? 0 });
      const zone = classifyZone({
        effortToChange: v.effortToChange,
        timeToChange: v.timeToChange,
      });
      if (zone === "openWater") openWaterIds.add(v.id);
      else if (zone === "sandbank") sandbankIds.add(v.id);
      else graniteIds.add(v.id);
    }

    // Nothing positioned? Return empty plan — UI will prompt the user.
    if (openWaterIds.size + sandbankIds.size + graniteIds.size === 0) {
      return emptyPlan();
    }

    const driverPayload = (ids: Set<string>) =>
      [...ids].map((id) => {
        const v = byId.get(id)!;
        return { id: v.id, name: v.name, weight: v.weight };
      });

    const payload = {
      decision: data.model.decision ?? "",
      goal: data.model.outcomeName ?? "",
      buckets: {
        QUICK_TO_MOVE: driverPayload(openWaterIds),
        WORTH_TESTING: driverPayload(sandbankIds),
        HARD_TO_MOVE: driverPayload(graniteIds),
      },
      options: data.model.options.map((o) => ({
        name: o.name ?? "",
        pushes: o.pushes ?? {},
      })),
    };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });

    if (!res.ok) {
      if (res.status === 429)
        throw new Error("Decision Lens AI is rate-limited. Please try again shortly.");
      if (res.status === 402)
        throw new Error(
          "Decision Lens AI credits exhausted. Add credits in Settings → Plans & credits.",
        );
      const body = await res.text().catch(() => "");
      throw new Error(`AI_HTTP_ERROR: gateway ${res.status}: ${body.slice(0, 200)}`);
    }

    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? "";
    if (!content) return emptyPlan();

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return emptyPlan();
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return emptyPlan();
      }
    }

    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const out: EstuarinePlan = emptyPlan();

    // ---------- nudges: open-water only ----------
    if (Array.isArray(root.nudges)) {
      for (const raw of root.nudges) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const text = typeof r.text === "string" ? r.text.trim().slice(0, 160) : "";
        if (!text) continue;
        const targets = (Array.isArray(r.targets) ? r.targets : [])
          .map((t) => String(t))
          .filter((t) => openWaterIds.has(t));
        if (!targets.length) continue;
        const effort = (EFFORTS as readonly string[]).includes(r.effort as string)
          ? (r.effort as EstuarineNudge["effort"])
          : undefined;
        const when = (WHENS as readonly string[]).includes(r.when as string)
          ? (r.when as EstuarineNudge["when"])
          : undefined;
        out.nudges.push({ text, targets, effort, when });
        if (out.nudges.length >= 4) break;
      }
    }

    // ---------- probes: sandbank only ----------
    if (Array.isArray(root.probes)) {
      for (const raw of root.probes) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const text = typeof r.text === "string" ? r.text.trim().slice(0, 160) : "";
        if (!text) continue;
        const targets = (Array.isArray(r.targets) ? r.targets : [])
          .map((t) => String(t))
          .filter((t) => sandbankIds.has(t));
        if (!targets.length) continue;
        const watchFor =
          typeof r.watchFor === "string" ? r.watchFor.trim().slice(0, 220) : "";
        const duration =
          typeof r.duration === "string" ? r.duration.trim().slice(0, 40) : "";
        if (!watchFor || !duration) continue;
        const effort = (EFFORTS as readonly string[]).includes(r.effort as string)
          ? (r.effort as EstuarineProbe["effort"])
          : undefined;
        const when = (WHENS as readonly string[]).includes(r.when as string)
          ? (r.when as EstuarineProbe["when"])
          : undefined;
        out.probes.push({ text, targets, effort, when, watchFor, duration });
        if (out.probes.length >= 3) break;
      }
    }

    // ---------- designArounds: granite only, dedupe by driverId ----------
    if (Array.isArray(root.designArounds)) {
      const seen = new Set<string>();
      for (const raw of root.designArounds) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const driverId = typeof r.driverId === "string" ? r.driverId : "";
        if (!graniteIds.has(driverId) || seen.has(driverId)) continue;
        const text = typeof r.text === "string" ? r.text.trim().slice(0, 220) : "";
        if (!text) continue;
        seen.add(driverId);
        out.designArounds.push({ driverId, text });
        if (out.designArounds.length >= graniteIds.size) break;
      }
    }

    return out;
  });
