import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import {
  Plus, X, Sparkles, ArrowRight, ArrowLeft, Trash2, Share2, Loader2,
  Target, Network, GitBranch, Telescope, RotateCcw,
  HelpCircle, Upload, FileText, Compass, MousePointerClick, Lightbulb, Wand2,
  BookmarkPlus, Pencil, Bookmark, CheckCircle2, Circle, PlayCircle, AlertTriangle, Check,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { explainDecision, critiqueModel, suggestActions, type CritiqueSuggestion } from "@/lib/ai-assist.functions";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

const ONBOARD_KEY = "dl_onboarded";

/* ============================================================================
   DECISION LENS — a generally-applicable, decision-focused world model.

     · STATE      latent variables that actually drive the decision's outcome
     · DYNAMICS   influence edges between variables = the feedback loops
     · ACTIONS    the options you're choosing between (each pushes the state)
     · ROLLOUT    simulate each option forward; compare trajectories, not vibes
     · DISCIPLINE name model error and what you'd watch to update

   >>> LOVABLE / AI SEAM <<<
   `autoDraftModel(decisionText)` is where a real LLM call goes.
============================================================================ */

/* --------------------------- model types -------------------------------- */
type Variable = { id: string; name: string; value: number; weight: number; rationale?: string };
type Influence = { from: string; to: string; strength: number; rationale?: string };
type DecisionAction = {
  text: string;
  targets?: string[];
  effort?: "low" | "med" | "high";
  when?: "now" | "soon" | "ongoing";
};
type DecisionOption = {
  id: string;
  name: string;
  pushes: Record<string, number>;
  actions?: DecisionAction[];
};
const EFFORTS = ["low", "med", "high"] as const;
const WHENS = ["now", "soon", "ongoing"] as const;
function sanitizeActions(raw: unknown, validIds: Set<string>): DecisionAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DecisionAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const aa = a as Record<string, unknown>;
    const text = typeof aa.text === "string" ? aa.text.trim().slice(0, 160) : "";
    if (!text) continue;
    const targetsSrc = Array.isArray(aa.targets) ? aa.targets : Array.isArray((aa as any).g) ? (aa as any).g : [];
    const targets = (targetsSrc as unknown[])
      .map((t) => String(t))
      .filter((t) => validIds.has(t));
    const effortRaw = (aa.effort ?? (aa as any).e) as unknown;
    const effort = EFFORTS.includes(effortRaw as any) ? (effortRaw as DecisionAction["effort"]) : undefined;
    const whenRaw = (aa.when ?? (aa as any).w) as unknown;
    const when = WHENS.includes(whenRaw as any) ? (whenRaw as DecisionAction["when"]) : undefined;
    const act: DecisionAction = { text };
    if (targets.length) act.targets = targets;
    if (effort) act.effort = effort;
    if (when) act.when = when;
    out.push(act);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}
type ModelSource = { name: string; type: "pdf" | "url" };
type Model = {
  outcomeName: string;
  horizon: number;
  variables: Variable[];
  influences: Influence[];
  options: DecisionOption[];
  summary?: string;
  sources?: ModelSource[];
};

/* --------------------------- URL hash codec ----------------------------- */
function encodeModel(m: Model): string {
  // Compact JSON; URL-safe via encodeURIComponent. Correctness over cleverness.
  const compact = {
    o: m.outcomeName,
    h: m.horizon,
    v: m.variables.map((v) => ({ i: v.id, n: v.name, v: v.value, w: v.weight })),
    e: m.influences.map((i) => ({ f: i.from, t: i.to, s: i.strength })),
    p: m.options.map((o) => {
      const base: any = { i: o.id, n: o.name, p: o.pushes };
      if (o.actions && o.actions.length) {
        base.a = o.actions.map((a) => {
          const x: any = { x: a.text };
          if (a.targets && a.targets.length) x.g = a.targets;
          if (a.effort) x.e = a.effort;
          if (a.when) x.w = a.when;
          return x;
        });
      }
      return base;
    }),
  };
  return encodeURIComponent(JSON.stringify(compact));
}

function parseHashModel(hash: string): Model | null {
  try {
    const m = hash.match(/[#&]m=([^&]+)/);
    if (!m) return null;
    const raw = JSON.parse(decodeURIComponent(m[1]));
    if (!raw || typeof raw !== "object") return null;
    const outcomeName = String(raw.o ?? "");
    const horizon = Number(raw.h);
    if (!outcomeName || !Number.isFinite(horizon) || horizon < 1 || horizon > 200) return null;
    if (!Array.isArray(raw.v) || !Array.isArray(raw.e) || !Array.isArray(raw.p)) return null;
    const variables: Variable[] = raw.v.map((v: any) => ({
      id: String(v.i), name: String(v.n ?? ""),
      value: Number(v.v), weight: Number(v.w),
    }));
    if (variables.some((v) => !v.id || !Number.isFinite(v.value) || !Number.isFinite(v.weight))) return null;
    const ids = new Set(variables.map((v) => v.id));
    const influences: Influence[] = raw.e.map((i: any) => ({
      from: String(i.f), to: String(i.t), strength: Number(i.s),
    }));
    if (influences.some((i) => !ids.has(i.from) || !ids.has(i.to) || !Number.isFinite(i.strength))) return null;
    const options: DecisionOption[] = raw.p.map((o: any) => {
      const pushes: Record<string, number> = {};
      if (o.p && typeof o.p === "object") {
        for (const k of Object.keys(o.p)) {
          if (!ids.has(k)) return null as any;
          const n = Number((o.p as any)[k]);
          if (!Number.isFinite(n)) return null as any;
          pushes[k] = n;
        }
      }
      const actions = sanitizeActions((o as any).a, ids);
      return { id: String(o.i), name: String(o.n ?? ""), pushes, ...(actions ? { actions } : {}) };
    });
    if (options.some((o) => !o || !o.id)) return null;
    return { outcomeName, horizon, variables, influences, options };
  } catch {
    return null;
  }
}

/* --------------------------- SVG palette --------------------------------
   SystemMap and TrajectoryChart SVGs are kept "as-is" per spec.
   These hex constants drive only those two SVGs — semantic accents
   (helps/hurts) and the option palette stay theme-independent. */
const SVG = {
  bgDeep: "#0f1117",
  inset: "#11141c",
  border: "#2a3140",
  border2: "#3a455c",
  ink: "#e9ecf3",
  ink2: "#cdd5e4",
  dim: "#8b95a8",
  primary: "#6ea8fe",
  good: "#7ee787",
  bad: "#ff6b81",
};
const FONT_DISPLAY = "Georgia,serif";

/* ----------------------------- engine -----------------------------------
   Unchanged from the verified prototype. Do not refactor. */
const clamp = (x: number) => Math.max(0, Math.min(100, x));
const uid = () => Math.random().toString(36).slice(2, 9);

function outcomeOf(vars: Variable[], vals: Record<string, number>): number {
  let num = 0, den = 0;
  vars.forEach((v) => {
    const w = v.weight / 100;
    den += Math.abs(w);
    num += w >= 0 ? w * vals[v.id] : Math.abs(w) * (100 - vals[v.id]);
  });
  return den ? clamp(num / den) : 50;
}

type TrajPoint = { t: number; vals: Record<string, number>; idx: number };
function simulate(
  vars: Variable[],
  influences: Influence[],
  pushes: Record<string, number> | undefined,
  horizon: number
): TrajPoint[] {
  const cur: Record<string, number> = {};
  vars.forEach((v) => (cur[v.id] = v.value));
  const base = { ...cur };
  const traj: TrajPoint[] = [{ t: 0, vals: { ...cur }, idx: outcomeOf(vars, cur) }];
  for (let t = 1; t <= horizon; t++) {
    const next: Record<string, number> = {};
    vars.forEach((v) => {
      let e = 0;
      influences
        .filter((i) => i.to === v.id)
        .forEach((i) => (e += (i.strength / 100) * ((cur[i.from] - 50) / 50) * 6));
      const push = ((pushes && pushes[v.id]) || 0) / 100 * 4;
      const decay = 0.08 * (cur[v.id] - base[v.id]);
      next[v.id] = clamp(cur[v.id] + push + e - decay);
    });
    Object.keys(next).forEach((k) => (cur[k] = next[k]));
    traj.push({ t, vals: { ...cur }, idx: outcomeOf(vars, cur) });
  }
  return traj;
}

/* ----------------------------- Monte Carlo ------------------------------- */
// Standard-normal sample via Box-Muller. Used to perturb pushes & influences.
function gaussSample(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export type MCBand = { t: number; p10: number; p50: number; p90: number };

/**
 * Monte-Carlo rollout for one option. Reuses the same per-step math as `simulate`,
 * but perturbs influence strengths and option pushes by Gaussian noise with
 * sigma = 15% of their value on each run. Returns p10/p50/p90 of the outcome
 * index at every timestep across `runs` rollouts.
 */
/* --- Monte-Carlo noise constants (shared by band + win-probability) --- */
const MC_COEF_SIG = 0.25;       // ±25% multiplicative noise on strengths/pushes (per run)
const MC_INIT_SIG = 3;          // Gaussian jitter on initial variable values (0-100 scale)
const MC_PROCESS_SIG = 1.5;     // Per-step SHARED additive shock (common world across options)
const MC_EXEC_SIG = 2.0;        // Per-step PER-OPTION execution shock (idiosyncratic to each option)
const MC_PUSH_STEP_SIG = 0.10;  // Per-step multiplicative jitter on option pushes

function simulateMonteCarlo(
  vars: Variable[],
  influences: Influence[],
  pushes: Record<string, number> | undefined,
  horizon: number,
  runs = 300
): MCBand[] {
  const samples: number[][] = Array.from({ length: horizon + 1 }, () => []);
  for (let r = 0; r < runs; r++) {
    const infNoise = influences.map(() => 1 + MC_COEF_SIG * gaussSample());
    const pushNoise: Record<string, number> = {};
    if (pushes) for (const k of Object.keys(pushes)) pushNoise[k] = 1 + MC_COEF_SIG * gaussSample();

    const cur: Record<string, number> = {};
    vars.forEach((v) => (cur[v.id] = clamp(v.value + MC_INIT_SIG * gaussSample())));
    const base = { ...cur };
    samples[0].push(outcomeOf(vars, cur));
    for (let t = 1; t <= horizon; t++) {
      const sharedShock: Record<string, number> = {};
      vars.forEach((v) => (sharedShock[v.id] = MC_PROCESS_SIG * gaussSample()));
      const next: Record<string, number> = {};
      vars.forEach((v) => {
        let e = 0;
        influences.forEach((i, ii) => {
          if (i.to !== v.id) return;
          const s = i.strength * infNoise[ii];
          e += (s / 100) * ((cur[i.from] - 50) / 50) * 6;
        });
        const rawPush = (pushes && pushes[v.id]) || 0;
        const stepJ = 1 + MC_PUSH_STEP_SIG * gaussSample();
        const push = (rawPush * (pushNoise[v.id] ?? 1) * stepJ) / 100 * 4;
        const decay = 0.08 * (cur[v.id] - base[v.id]);
        const exec = MC_EXEC_SIG * gaussSample();
        next[v.id] = clamp(cur[v.id] + push + e - decay + sharedShock[v.id] + exec);
      });
      Object.keys(next).forEach((k) => (cur[k] = next[k]));
      samples[t].push(outcomeOf(vars, cur));
    }
  }
  return samples.map((arr, t) => {
    const s = [...arr].sort((a, b) => a - b);
    return { t, p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9) };
  });
}




/**
 * Joint Monte-Carlo across all options sharing per-run noise, so we can
 * count "wins" — the share of runs where each option has the highest final
 * outcome index. Same noise model as `simulateMonteCarlo`.
 */
function winProbabilities(
  vars: Variable[],
  influences: Influence[],
  options: DecisionOption[],
  horizon: number,
  runs = 300
): Record<string, number> {
  if (options.length === 0) return {};
  const wins: Record<string, number> = {};
  options.forEach((o) => (wins[o.id] = 0));
  for (let r = 0; r < runs; r++) {
    // Shared per-run noise so options are compared on the same world.
    const infNoise = influences.map(() => 1 + MC_COEF_SIG * gaussSample());
    const optPushNoise = options.map((o) => {
      const m: Record<string, number> = {};
      if (o.pushes) for (const k of Object.keys(o.pushes)) m[k] = 1 + MC_COEF_SIG * gaussSample();
      return m;
    });
    const initJitter: Record<string, number> = {};
    vars.forEach((v) => (initJitter[v.id] = MC_INIT_SIG * gaussSample()));
    // Shared per-step process shocks: same world for every option this run.
    const shocks: Array<Record<string, number>> = [];
    for (let t = 1; t <= horizon; t++) {
      const s: Record<string, number> = {};
      vars.forEach((v) => (s[v.id] = MC_PROCESS_SIG * gaussSample()));
      shocks.push(s);
    }
    let bestIdx = 0, bestVal = -Infinity;
    options.forEach((o, oi) => {
      const cur: Record<string, number> = {};
      vars.forEach((v) => (cur[v.id] = clamp(v.value + initJitter[v.id])));
      const base = { ...cur };
      for (let t = 1; t <= horizon; t++) {
        const next: Record<string, number> = {};
        vars.forEach((v) => {
          let e = 0;
          influences.forEach((i, ii) => {
            if (i.to !== v.id) return;
            const s = i.strength * infNoise[ii];
            e += (s / 100) * ((cur[i.from] - 50) / 50) * 6;
          });
          const rawPush = (o.pushes && o.pushes[v.id]) || 0;
          const stepJ = 1 + MC_PUSH_STEP_SIG * gaussSample();
          const push = (rawPush * (optPushNoise[oi][v.id] ?? 1) * stepJ) / 100 * 4;
          const decay = 0.08 * (cur[v.id] - base[v.id]);
          const exec = MC_EXEC_SIG * gaussSample();
          next[v.id] = clamp(cur[v.id] + push + e - decay + shocks[t - 1][v.id] + exec);
        });
        Object.keys(next).forEach((k) => (cur[k] = next[k]));
      }

      const finalIdx = outcomeOf(vars, cur);
      if (finalIdx > bestVal) { bestVal = finalIdx; bestIdx = oi; }
    });
    wins[options[bestIdx].id]++;
  }
  const out: Record<string, number> = {};
  options.forEach((o) => (out[o.id] = wins[o.id] / runs));
  return out;
}


const MC_RUNS = 300;

/* --------------------------- starter templates --------------------------- */
const TEMPLATES = [
  {
    key: ["market", "launch", "expand", "enter", "product"],
    label: "Enter a new market?",
    decision: "Should we enter the new market now, wait and build, or partner in?",
    outcomeName: "Strategic payoff",
    horizon: 12,
    variables: [
      { id: "demand", name: "Demand signal", value: 55, weight: 80 },
      { id: "moat", name: "Competitive moat", value: 40, weight: 70 },
      { id: "runway", name: "Cash runway", value: 60, weight: 55 },
      { id: "focus", name: "Team focus", value: 55, weight: 45 },
      { id: "risk", name: "Brand risk", value: 35, weight: -60 },
    ],
    influences: [
      { from: "focus", to: "moat", strength: 50 },
      { from: "runway", to: "focus", strength: 40 },
      { from: "risk", to: "demand", strength: -40 },
      { from: "moat", to: "demand", strength: 30 },
    ],
    options: [
      { id: uid(), name: "Enter now", pushes: { demand: 30, moat: 20, runway: -40, focus: -30, risk: 40 }, actions: [
        { text: "Ship MVP to 3 lighthouse customers within 30 days", targets: ["demand"], effort: "high", when: "now" },
        { text: "Hire 2 senior engineers to staff launch team", targets: ["focus", "runway"], effort: "high", when: "now" },
        { text: "Run weekly competitive teardown to defend positioning", targets: ["moat", "risk"], effort: "med", when: "ongoing" },
      ] },
      { id: uid(), name: "Wait & build", pushes: { demand: -5, moat: 35, runway: 10, focus: 25, risk: -20 }, actions: [
        { text: "Spend a quarter hardening core IP before any go-to-market", targets: ["moat"], effort: "high", when: "now" },
        { text: "Run 5 customer-discovery interviews per week", targets: ["demand"], effort: "low", when: "ongoing" },
        { text: "Defer new hires; reallocate two engineers to platform", targets: ["runway", "focus"], effort: "med", when: "soon" },
      ] },
      { id: uid(), name: "Partner in", pushes: { demand: 20, moat: 40, runway: -10, focus: 10, risk: -10 }, actions: [
        { text: "Shortlist 3 distribution partners and open term-sheet talks", targets: ["demand", "moat"], effort: "med", when: "now" },
        { text: "Negotiate revenue-share to cap downside on runway", targets: ["runway", "risk"], effort: "med", when: "soon" },
        { text: "Embed a joint product-marketing pod with the partner", targets: ["focus"], effort: "low", when: "ongoing" },
      ] },
    ],
  },
  {
    key: ["career", "job", "quit", "switch", "personal", "move"],
    label: "Make a career move?",
    decision: "Should I stay, switch companies, or go independent?",
    outcomeName: "Life payoff",
    horizon: 24,
    variables: [
      { id: "growth", name: "Skill growth", value: 45, weight: 70 },
      { id: "income", name: "Income security", value: 65, weight: 55 },
      { id: "meaning", name: "Sense of meaning", value: 40, weight: 75 },
      { id: "network", name: "Network strength", value: 55, weight: 40 },
      { id: "stress", name: "Stress / burnout", value: 55, weight: -65 },
    ],
    influences: [
      { from: "meaning", to: "stress", strength: -40 },
      { from: "growth", to: "meaning", strength: 35 },
      { from: "network", to: "income", strength: 30 },
      { from: "stress", to: "growth", strength: -30 },
    ],
    options: [
      { id: uid(), name: "Stay & shape role", pushes: { growth: 15, income: 5, meaning: 20, network: 10, stress: -15 }, actions: [
        { text: "Pitch manager on a 20% scope shift toward a stretch project", targets: ["growth", "meaning"], effort: "low", when: "now" },
        { text: "Set a hard boundary: no work after 7pm two nights a week", targets: ["stress"], effort: "low", when: "ongoing" },
        { text: "Re-open compensation conversation at next cycle", targets: ["income"], effort: "med", when: "soon" },
      ] },
      { id: uid(), name: "Switch company", pushes: { growth: 35, income: 10, meaning: 15, network: 30, stress: 15 }, actions: [
        { text: "Refresh CV and book 5 intro calls per week for 6 weeks", targets: ["network"], effort: "med", when: "now" },
        { text: "Target roles in 2 adjacent domains to widen skill range", targets: ["growth"], effort: "med", when: "soon" },
        { text: "Negotiate signing bonus to cover transition risk", targets: ["income", "stress"], effort: "low", when: "soon" },
      ] },
      { id: uid(), name: "Go independent", pushes: { growth: 40, income: -35, meaning: 35, network: 20, stress: 35 }, actions: [
        { text: "Line up 2 anchor clients before quitting", targets: ["income"], effort: "high", when: "now" },
        { text: "Build a 9-month cash buffer", targets: ["income", "stress"], effort: "high", when: "now" },
        { text: "Publish weekly to compound an audience", targets: ["network", "meaning"], effort: "med", when: "ongoing" },
      ] },
    ],
  },
  {
    key: ["change", "org", "team", "transform", "adopt", "reorg"],
    label: "Drive an org change?",
    decision: "How hard should we push a change initiative, and how?",
    outcomeName: "Adoption",
    horizon: 18,
    variables: [
      { id: "trust", name: "Trust", value: 45, weight: 65 },
      { id: "momentum", name: "Momentum", value: 35, weight: 60 },
      { id: "coalition", name: "Coalition", value: 40, weight: 70 },
      { id: "capability", name: "Capability", value: 35, weight: 50 },
      { id: "threat", name: "Threat-perception", value: 55, weight: -70 },
    ],
    influences: [
      { from: "momentum", to: "trust", strength: 45 },
      { from: "trust", to: "threat", strength: -50 },
      { from: "coalition", to: "momentum", strength: 45 },
      { from: "threat", to: "coalition", strength: -45 },
      { from: "capability", to: "momentum", strength: 35 },
    ],
    options: [
      { id: uid(), name: "Co-create", pushes: { trust: 25, momentum: 15, coalition: 40, capability: 25, threat: -35 }, actions: [
        { text: "Run a 2-day design summit with frontline reps from each team", targets: ["coalition", "trust"], effort: "med", when: "now" },
        { text: "Publish a transparent decision log to all-hands weekly", targets: ["trust", "threat"], effort: "low", when: "ongoing" },
        { text: "Fund a capability academy with rotating cohorts", targets: ["capability"], effort: "high", when: "soon" },
      ] },
      { id: uid(), name: "Mandate & push", pushes: { trust: -25, momentum: 35, coalition: -15, capability: 5, threat: 45 }, actions: [
        { text: "CEO issues a 90-day deadline memo with named owners", targets: ["momentum"], effort: "low", when: "now" },
        { text: "Tie 20% of leader bonuses to adoption metrics", targets: ["momentum", "coalition"], effort: "med", when: "soon" },
        { text: "Shut down two legacy systems to force the switch", targets: ["momentum", "threat"], effort: "high", when: "soon" },
      ] },
      { id: uid(), name: "Quick wins first", pushes: { trust: 15, momentum: 45, coalition: 20, capability: 25, threat: -5 }, actions: [
        { text: "Pick 3 visible pain points; ship fixes in 30 days", targets: ["momentum", "trust"], effort: "med", when: "now" },
        { text: "Celebrate each win at all-hands with the team that shipped it", targets: ["coalition"], effort: "low", when: "ongoing" },
        { text: "Pair every quick win with a short skills workshop", targets: ["capability"], effort: "low", when: "soon" },
      ] },
    ],
  },
];

/* --------------------------- user templates (localStorage) --------------- */
type TemplateSource = "ai" | "documents" | "manual";
type UserTemplate = {
  id: string;
  name: string;
  source: TemplateSource;
  model: Model;
  createdAt: number;
};
const USER_TEMPLATES_KEY = "dl_templates";

function loadUserTemplatesFromStorage(): UserTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_TEMPLATES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t: any) =>
        t && typeof t.id === "string" && typeof t.name === "string" &&
        t.model && Array.isArray(t.model.variables) && Array.isArray(t.model.options)
    );
  } catch { return []; }
}
function saveUserTemplatesToStorage(list: UserTemplate[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(list)); } catch { /* noop */ }
}
function templateFromBuiltin(tpl: (typeof TEMPLATES)[number]): Model {
  return {
    outcomeName: tpl.outcomeName,
    horizon: tpl.horizon,
    variables: tpl.variables.map((v) => ({ ...v })),
    influences: tpl.influences.map((i) => ({ ...i })),
    options: tpl.options.map((o) => ({ id: uid(), name: o.name, pushes: { ...o.pushes }, ...((o as any).actions ? { actions: (o as any).actions.map((a: any) => ({ ...a, targets: a.targets ? [...a.targets] : undefined })) } : {}) })),
  };
}

function blankStarter(): Model {
  return {
    outcomeName: "Outcome",
    horizon: 12,
    variables: [
      { id: uid(), name: "Driver A", value: 50, weight: 60 },
      { id: uid(), name: "Driver B", value: 50, weight: 50 },
      { id: uid(), name: "Risk factor", value: 50, weight: -50 },
    ],
    influences: [],
    options: [
      { id: uid(), name: "Option 1", pushes: {}, actions: [
        { text: "Describe the first concrete step a team would take this week", effort: "low", when: "now" },
      ] },
      { id: uid(), name: "Option 2", pushes: {} },
    ],
  };
}

function keywordTemplate(decisionText: string): Model {
  const t = (decisionText || "").toLowerCase();
  const hit = TEMPLATES.find((tpl) => tpl.key.some((k) => t.includes(k)));
  const tpl = hit || TEMPLATES[0];
  return {
    outcomeName: tpl.outcomeName,
    horizon: tpl.horizon,
    variables: tpl.variables.map((v) => ({ ...v })),
    influences: tpl.influences.map((i) => ({ ...i })),
    options: tpl.options.map((o) => ({ id: uid(), name: o.name, pushes: { ...o.pushes }, ...((o as any).actions ? { actions: (o as any).actions.map((a: any) => ({ ...a, targets: a.targets ? [...a.targets] : undefined })) } : {}) })),
  };
}

const clampN = (n: unknown, lo: number, hi: number): number => {
  const x = Number(n);
  if (!Number.isFinite(x)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, x));
};

function validateDraftedModel(raw: any): Model | null {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.variables) || raw.variables.length === 0) return null;
  const variables: Variable[] = raw.variables
    .map((v: any) => {
      const id = String(v?.id ?? "").trim();
      if (!id) return null;
      const rationale = typeof v?.rationale === "string" ? v.rationale.slice(0, 300) : undefined;
      return {
        id,
        name: String(v?.name ?? id),
        value: clampN(v?.value, 0, 100),
        weight: clampN(v?.weight, -100, 100),
        ...(rationale ? { rationale } : {}),
      } as Variable;
    })
    .filter(Boolean) as Variable[];
  if (variables.length === 0) return null;
  const ids = new Set(variables.map((v) => v.id));

  const influences: Influence[] = (Array.isArray(raw.influences) ? raw.influences : [])
    .map((i: any) => {
      const rationale = typeof i?.rationale === "string" ? i.rationale.slice(0, 300) : undefined;
      return {
        from: String(i?.from ?? ""),
        to: String(i?.to ?? ""),
        strength: clampN(i?.strength, -100, 100),
        ...(rationale ? { rationale } : {}),
      } as Influence;
    })
    .filter((i: Influence) => ids.has(i.from) && ids.has(i.to));

  const options: DecisionOption[] = (Array.isArray(raw.options) ? raw.options : [])
    .map((o: any) => {
      const pushes: Record<string, number> = {};
      if (o?.pushes && typeof o.pushes === "object") {
        for (const k of Object.keys(o.pushes)) {
          if (!ids.has(k)) continue;
          pushes[k] = clampN((o.pushes as any)[k], -60, 60);
        }
      }
      const actions = sanitizeActions(o?.actions, ids);
      return { id: uid(), name: String(o?.name ?? "Option"), pushes, ...(actions ? { actions } : {}) };
    });
  // Synthesize a fallback option rather than rejecting the whole model
  if (options.length === 0) {
    options.push({ id: uid(), name: "Status quo", pushes: {} });
  }


  const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 600) : undefined;
  const sources: ModelSource[] | undefined = Array.isArray(raw.sources)
    ? raw.sources
        .map((s: any) => ({
          name: String(s?.name ?? "").slice(0, 200),
          type: s?.type === "url" ? "url" as const : "pdf" as const,
        }))
        .filter((s: ModelSource) => s.name)
    : undefined;

  return {
    outcomeName: String(raw.outcomeName ?? "Outcome"),
    horizon: Math.round(clampN(raw.horizon, 4, 36)),
    variables,
    influences,
    options,
    ...(summary ? { summary } : {}),
    ...(sources && sources.length ? { sources } : {}),
  };
}

async function autoDraftModel(decisionText: string): Promise<Model> {
  try {
    const { draftModel } = await import("@/lib/draft-model.functions");
    const raw = await draftModel({ data: { decisionText } });
    const m = validateDraftedModel(raw);
    if (!m) throw new Error("Invalid model JSON");
    return m;
  } catch (err) {
    console.error("autoDraftModel failed", err);
    throw err;
  }
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/* ------------------------------- palette --------------------------------
   Semantic option colors (theme-independent — they identify each option). */
const OPT_COLORS = ["#6ea8fe", "#7ee787", "#ffb454", "#ff6b81", "#9d7bff"];
const STAGES = [
  { id: "frame", label: "Frame", icon: Target },
  { id: "model", label: "Model", icon: Network },
  { id: "options", label: "Options", icon: GitBranch },
  { id: "decide", label: "Decide", icon: Telescope },
] as const;
type Stage = (typeof STAGES)[number]["id"];

/* =============================== component ================================ */
export default function DecisionLens() {
  const [stage, setStage] = useState<Stage>("frame");
  const [decision, setDecision] = useState(
    "Should we enter the new market now, wait and build, or partner in?"
  );
  const seed = useMemo(() => keywordTemplate(decision), []); // initial demo model
  const [outcomeName, setOutcomeName] = useState(seed.outcomeName);
  const [horizon, setHorizon] = useState(seed.horizon);
  const [variables, setVariables] = useState<Variable[]>(seed.variables);
  const [influences, setInfluences] = useState<Influence[]>(seed.influences);
  const [options, setOptions] = useState<DecisionOption[]>(seed.options);
  const [focusOpt, setFocusOpt] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  // Document ingest state
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestStep, setIngestStep] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | undefined>();
  const [aiSources, setAiSources] = useState<ModelSource[] | undefined>();
  const [aiAttachedCount, setAiAttachedCount] = useState(0);
  const [aiSkippedCount, setAiSkippedCount] = useState(0);
  const [aiHighlight, setAiHighlight] = useState(false);

  // User templates (gallery)
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>(() => loadUserTemplatesFromStorage());
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  // Onboarding state
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const decisionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const templatesPanelRef = useRef<HTMLDivElement | null>(null);
  const stepperRefs = useRef<Array<HTMLButtonElement | null>>([null, null, null, null]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!window.localStorage.getItem(ONBOARD_KEY)) setWelcomeOpen(true);
    } catch { /* noop */ }
  }, []);

  function closeWelcome(persist: boolean) {
    setWelcomeOpen(false);
    if (persist && typeof window !== "undefined") {
      try { window.localStorage.setItem(ONBOARD_KEY, "1"); } catch { /* noop */ }
    }
  }

  function openHelp() { setDontShow(false); setWelcomeOpen(true); }

  function startFromDocs() {
    closeWelcome(dontShow);
    setStage("frame");
    requestAnimationFrame(() => {
      dropzoneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      pdfInputRef.current?.click();
    });
  }
  function startFromText() {
    closeWelcome(dontShow);
    setStage("frame");
    requestAnimationFrame(() => {
      decisionTextareaRef.current?.focus();
      decisionTextareaRef.current?.select();
    });
  }
  function startFromTemplate() {
    closeWelcome(dontShow);
    setStage("frame");
    requestAnimationFrame(() => {
      templatesPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  function startTour() {
    closeWelcome(dontShow);
    setStage(STAGES[0].id);
    requestAnimationFrame(() => {
      setTourStep(dropzoneRef.current ? 0 : 1);
    });
  }

  function addPdfFiles(incoming: File[]) {
    const errors: string[] = [];
    const accepted: File[] = [];
    for (const f of incoming) {
      if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
        errors.push(`${f.name}: not a PDF`); continue;
      }
      if (f.size > 10 * 1024 * 1024) { errors.push(`${f.name}: over 10 MB`); continue; }
      accepted.push(f);
    }
    setPdfFiles((prev) => {
      const merged = [...prev];
      for (const f of accepted) {
        if (merged.length >= 5) { errors.push(`${f.name}: max 5 files`); continue; }
        if (!merged.some((x) => x.name === f.name && x.size === f.size)) merged.push(f);
      }
      return merged;
    });
    if (errors.length) toast.error("Some files were skipped", { description: "Decision Lens · " + errors.join(" · ") });
  }
  function removePdf(idx: number) { setPdfFiles((p) => p.filter((_, i) => i !== idx)); }

  function tryAddUrl(raw: string) {
    const v = raw.trim();
    if (!v) return;
    let u: URL | null = null;
    try { u = new URL(v.includes("://") ? v : "https://" + v); } catch { /* */ }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
      toast.error("Invalid URL", { description: "Decision Lens · use http(s) URLs only." });
      return;
    }
    setUrls((prev) => (prev.includes(u!.toString()) || prev.length >= 8 ? prev : [...prev, u!.toString()]));
    setUrlInput("");
  }
  function removeUrl(idx: number) { setUrls((p) => p.filter((_, i) => i !== idx)); }

  function describeAiError(err: unknown): { title: string; description: string } {
    const msg = (err as { message?: string })?.message || "";
    if (msg.startsWith("RATE_LIMITED")) {
      return { title: "Too many requests", description: "Decision Lens · wait a minute and try again." };
    }
    if (msg.startsWith("AI_BAD_JSON")) {
      return { title: "AI returned an unusable result", description: "Decision Lens · try again or rephrase your decision." };
    }
    if (msg.startsWith("AI_HTTP_ERROR")) {
      return { title: "AI service error", description: "Decision Lens · the gateway rejected the request. Try again shortly." };
    }
    return { title: "Couldn't reach the AI", description: "Decision Lens · loaded a template instead." };
  }

  function describeSkipReason(reason: string): string {
    switch (reason) {
      case "oversized": return "too large";
      case "not_pdf": return "not a valid PDF";
      case "pdf_parse_failed": return "couldn't read PDF";
      case "private_host": return "blocked (private host)";
      case "non_https": return "must be https://";
      case "timeout": return "timed out";
      case "bad_content_type": return "unsupported content type";
      case "http_error": return "fetch failed";
      case "empty": return "no readable text";
      default: return reason;
    }
  }

  function triggerAiHighlight() {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setAiHighlight(false); return; }
    setAiHighlight(true);
    window.setTimeout(() => setAiHighlight(false), 2200);
  }

  async function runAutoDraft(text: string) {
    setDrafting(true);
    try {
      const m = await autoDraftModel(text);
      loadModel(m);
      setAiAttachedCount(0);
      setAiSkippedCount(0);
      setStage("model");
      triggerAiHighlight();
      toast.success("Model drafted", { description: "Decision Lens · AI-built your starting system." });
    } catch (err) {
      console.error("autoDraft failed", err);
      loadModel(keywordTemplate(text));
      setAiAttachedCount(0);
      setAiSkippedCount(0);
      setStage("model");
      const { title, description } = describeAiError(err);
      toast.error(title, { description });
    } finally {
      setDrafting(false);
    }
  }

  async function runIngest() {
    if (!decision.trim()) {
      toast.error("Add your decision first", { description: "Decision Lens · we need a question to map." });
      return;
    }
    if (pdfFiles.length === 0 && urls.length === 0) {
      void runAutoDraft(decision);
      return;
    }
    setIngesting(true);
    const attached = pdfFiles.length + urls.length;
    try {
      const filesPayload = await Promise.all(
        pdfFiles.map(async (f) => ({ name: f.name, dataBase64: await fileToBase64(f) }))
      );
      const { ingestSources } = await import("@/lib/ingest-sources.functions");
      const raw = await ingestSources({ data: { files: filesPayload, urls, decisionText: decision } });
      const m = validateDraftedModel(raw);
      if (!m) throw new Error("AI_BAD_JSON: model failed validation");
      loadModel(m);
      const skipped = (raw as { skipped?: Array<{ name: string; reason: string }> }).skipped ?? [];
      const degraded = (raw as { degraded?: boolean }).degraded === true;
      setAiAttachedCount(attached);
      setAiSkippedCount(skipped.length);
      setStage("model");
      triggerAiHighlight();
      if (skipped.length > 0) {
        const lines = skipped.slice(0, 4).map((s) => `${s.name}: ${describeSkipReason(s.reason)}`).join(" · ");
        const more = skipped.length > 4 ? ` · +${skipped.length - 4} more` : "";
        toast.warning(degraded ? "Decision drafted (no sources used)" : "Decision mapped (some sources skipped)", {
          description: "Decision Lens · " + lines + more,
        });
      } else {
        toast.success("Decision mapped", { description: "Decision Lens · grounded in your sources." });
      }
    } catch (err) {
      console.error("ingest failed", err);
      const { title, description } = describeAiError(err);
      toast.error(title, { description });
    } finally {
      setIngesting(false);
    }
  }



  function loadModel(m: Model) {
    setOutcomeName(m.outcomeName);
    setHorizon(m.horizon);
    setVariables(m.variables);
    setInfluences(m.influences);
    setOptions(m.options);
    setFocusOpt(null);
    setAiSummary(m.summary);
    setAiSources(m.sources);
  }

  const model: Model = useMemo(
    () => ({ outcomeName, horizon, variables, influences, options }),
    [outcomeName, horizon, variables, influences, options]
  );

  // Load model from #m= on first mount
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (typeof window === "undefined") return;
    const m = parseHashModel(window.location.hash);
    if (m) loadModel(m);
  }, []);

  // Debounced write of model to #m=
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      try {
        const encoded = encodeModel(model);
        const newHash = "#m=" + encoded;
        if (window.location.hash !== newHash) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
        }
      } catch {
        /* noop */
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [model]);

  async function shareLink() {
    try {
      const encoded = encodeModel(model);
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}#m=${encoded}`;
      window.history.replaceState(null, "", url);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      }
      toast.success("Copied!", { description: "Decision Lens · share link ready to paste." });
    } catch {
      toast.error("Couldn't copy link", { description: "Decision Lens · try copying the URL manually." });
    }
  }

  function inferCurrentSource(): TemplateSource {
    if (aiSources && aiSources.length > 0) return "documents";
    if (aiSummary) return "ai";
    return "manual";
  }
  function persistUserTemplates(next: UserTemplate[]) {
    setUserTemplates(next);
    saveUserTemplatesToStorage(next);
  }
  function openSaveTemplate() {
    setSaveName(outcomeName || "My decision");
    setSaveOpen(true);
  }
  function confirmSaveTemplate() {
    const name = saveName.trim();
    if (!name) return;
    const entry: UserTemplate = {
      id: uid(),
      name,
      source: inferCurrentSource(),
      model: {
        outcomeName, horizon,
        variables: variables.map((v) => ({ ...v })),
        influences: influences.map((i) => ({ ...i })),
        options: options.map((o) => ({ ...o, pushes: { ...o.pushes } })),
        summary: aiSummary,
        sources: aiSources,
      },
      createdAt: Date.now(),
    };
    persistUserTemplates([entry, ...userTemplates]);
    setSaveOpen(false);
    toast.success("Template saved", { description: "Decision Lens · added to your gallery." });
  }
  function deleteUserTemplate(id: string) {
    persistUserTemplates(userTemplates.filter((t) => t.id !== id));
    toast.success("Template removed", { description: "Decision Lens · gallery updated." });
  }
  function renameUserTemplate(id: string) {
    const t = userTemplates.find((x) => x.id === id);
    if (!t) return;
    const name = window.prompt("Rename template", t.name);
    if (!name || !name.trim()) return;
    persistUserTemplates(
      userTemplates.map((x) => (x.id === id ? { ...x, name: name.trim() } : x))
    );
    toast.success("Template renamed", { description: "Decision Lens · gallery updated." });
  }
  function loadUserTemplate(t: UserTemplate) {
    loadModel(t.model);
    setStage("model");
  }
  function loadBuiltinTemplate(tpl: (typeof TEMPLATES)[number]) {
    setDecision(tpl.decision);
    loadModel(templateFromBuiltin(tpl));
    setStage("model");
  }

  const runs = useMemo(
    () =>
      options.map((o, i) => ({
        option: o,
        color: OPT_COLORS[i % OPT_COLORS.length],
        traj: simulate(variables, influences, o.pushes, horizon),
      })),
    [options, variables, influences, horizon]
  );

  // Monte-Carlo: per-option uncertainty fans + joint win probabilities.
  const mc = useMemo(() => {
    const bands: Record<string, MCBand[]> = {};
    options.forEach((o) => {
      bands[o.id] = simulateMonteCarlo(variables, influences, o.pushes, horizon, MC_RUNS);
    });
    const winProb = winProbabilities(variables, influences, options, horizon, MC_RUNS);
    return { bands, winProb };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, influences, options, horizon]);

  const ranked = useMemo(
    () =>
      [...runs]
        .map((r) => ({
          ...r,
          score: r.traj[r.traj.length - 1].idx,
          winProb: mc.winProb[r.option.id] ?? 0,
        }))
        .sort((a, b) => (b.winProb - a.winProb) || (b.score - a.score)),
    [runs, mc]
  );
  const best = ranked[0];

  /* --------------------------- AI assistance --------------------------- */
  const callExplain = useServerFn(explainDecision);
  const callCritique = useServerFn(critiqueModel);
  const callSuggestActions = useServerFn(suggestActions);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [critiquing, setCritiquing] = useState(false);
  const [critique, setCritique] = useState<CritiqueSuggestion[] | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  async function runSuggestActions(opt: DecisionOption) {
    setActionLoading((s) => ({ ...s, [opt.id]: true }));
    try {
      const res = await callSuggestActions({
        data: {
          decision,
          outcomeName,
          variables,
          option: { id: opt.id, name: opt.name, pushes: opt.pushes },
        },
      });
      const validIds = new Set(variables.map((v) => v.id));
      const incoming = (res.actions ?? [])
        .map((a) => {
          const targets = (a.targets ?? []).filter((t) => validIds.has(t));
          const act: DecisionAction = { text: a.text.trim() };
          if (targets.length) act.targets = targets;
          if (a.effort) act.effort = a.effort;
          if (a.when) act.when = a.when;
          return act;
        })
        .filter((a) => a.text.length > 0);
      const existing = opt.actions ?? [];
      const seen = new Set(existing.map((a) => a.text.trim().toLowerCase()));
      const merged = [...existing];
      for (const a of incoming) {
        const key = a.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
        if (merged.length >= 8) break;
      }
      updOpt(opt.id, { actions: merged });
      toast.success("Decision Lens · suggested actions", {
        description: `Added ${merged.length - existing.length} new action${merged.length - existing.length === 1 ? "" : "s"} to ${opt.name}.`,
      });
    } catch (e) {
      toast.error("Decision Lens · couldn't suggest actions", {
        description: e instanceof Error ? e.message : "AI unavailable.",
      });
    } finally {
      setActionLoading((s) => ({ ...s, [opt.id]: false }));
    }
  }

  // Invalidate stale AI output when the model changes
  useEffect(() => { setExplanation(null); }, [variables, influences, options, horizon]);
  useEffect(() => { setCritique(null); }, [variables, influences, options]);

  // Cycle staged loading messages during ingest
  useEffect(() => {
    if (!ingesting) { setIngestStep(0); return; }
    setIngestStep(0);
    const id = window.setInterval(() => {
      setIngestStep((s) => (s + 1) % 4);
    }, 2500);
    return () => window.clearInterval(id);
  }, [ingesting]);

  async function runExplain() {
    if (!ranked.length) return;
    setExplaining(true);
    try {
      const res = await callExplain({
        data: {
          model: { outcomeName, horizon, variables, influences, options },
          ranked: ranked.map((r) => ({ name: r.option.name, score: r.score, winProb: r.winProb })),
        },
      });
      setExplanation(res.explanation);
    } catch (e) {
      toast.error("Couldn't explain", { description: "Decision Lens · " + (e instanceof Error ? e.message : "AI unavailable.") });
    } finally {
      setExplaining(false);
    }
  }

  async function runCritique() {
    setCritiquing(true);
    try {
      const res = await callCritique({
        data: { model: { outcomeName, horizon, variables, influences, options } },
      });
      setCritique(res.suggestions);
      if (!res.suggestions.length) {
        toast.success("Looks solid", { description: "Decision Lens · no critical gaps found." });
      }
    } catch (e) {
      toast.error("Critique failed", { description: "Decision Lens · " + (e instanceof Error ? e.message : "AI unavailable.") });
    } finally {
      setCritiquing(false);
    }
  }

  function acceptSuggestion(s: CritiqueSuggestion) {
    if (s.kind === "add_variable" && s.variable) {
      const ids = new Set(variables.map((v) => v.id));
      let id = s.variable.id || uid();
      while (ids.has(id)) id = id + "_" + Math.random().toString(36).slice(2, 4);
      setVariables([...variables, { ...s.variable, id }]);
      toast.success("Variable added", { description: "Decision Lens · " + s.variable.name });
    } else if (s.kind === "add_influence" && s.influence) {
      setInfluences([...influences, s.influence]);
      toast.success("Influence added", { description: "Decision Lens · linked drivers." });
    }
    setCritique((cur) => (cur ? cur.filter((x) => x !== s) : cur));
  }

  // Suggested probe: highest out-degree (ties → highest |weight|)
  const suggestedProbe = useMemo(() => {
    if (!variables.length) return null;
    const outDeg = new Map<string, number>();
    for (const v of variables) outDeg.set(v.id, 0);
    for (const i of influences) outDeg.set(i.from, (outDeg.get(i.from) ?? 0) + 1);
    let bestVar = variables[0];
    let bestDeg = outDeg.get(bestVar.id) ?? 0;
    for (const v of variables) {
      const d = outDeg.get(v.id) ?? 0;
      if (d > bestDeg || (d === bestDeg && Math.abs(v.weight) > Math.abs(bestVar.weight))) {
        bestVar = v; bestDeg = d;
      }
    }
    return { variable: bestVar, outDegree: bestDeg };
  }, [variables, influences]);




  /* ---------------------------- mutators ------------------------------- */
  function updVar(id: string, patch: Partial<Variable>) {
    setVariables(variables.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function updOpt(id: string, patch: Partial<DecisionOption>) {
    setOptions(options.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function removeVar(id: string) {
    setVariables(variables.filter((v) => v.id !== id));
    setInfluences(influences.filter((i) => i.from !== id && i.to !== id));
    setOptions(options.map((o) => {
      const p = { ...o.pushes }; delete p[id]; return { ...o, pushes: p };
    }));
  }
  function addInfluence() {
    if (variables.length < 2) return;
    setInfluences([...influences, { from: variables[0].id, to: variables[1].id, strength: 30 }]);
  }
  function updInf(idx: number, patch: Partial<Influence>) {
    setInfluences(influences.map((i, k) => (k === idx ? { ...i, ...patch } : i)));
  }

  /* ============================== render =============================== */
  return (
    <div
      className="min-h-screen w-full bg-background text-foreground"
      style={{
        backgroundImage:
          "radial-gradient(1200px 700px at 70% -10%, var(--accent) 0%, var(--background) 60%)",
      }}
    >
      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* header */}
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold text-primary tracking-[0.18em]">
              DECISION LENS · WORLD-MODEL THINKING
            </div>
            <h1
              className="mt-1 text-3xl font-semibold tracking-tight text-foreground"
              style={{ fontFamily: FONT_DISPLAY }}
            >
              See where each choice leads — then decide with confidence.
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Every decision comes down to a few things that really matter and how your choices move them.
              Map those once, and you can see how each option is likely to play out — instead of going on gut feel.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={openHelp}
              aria-label="Open Decision Lens help"
              title="How does Decision Lens work?"
            >
              <HelpCircle size={16} />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={shareLink}
              className="gap-2"
              aria-label="Copy shareable link to this decision"
            >
              <Share2 size={15} />
              Share
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openSaveTemplate}
              className="gap-2"
              aria-label="Save current model as a template"
            >
              <BookmarkPlus size={15} />
              Save as template
            </Button>
          </div>

        </header>

        <Tabs value={stage} onValueChange={(v) => setStage(v as Stage)} className="w-full">
          <TabsList className="mb-6 flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
            {STAGES.map((s, i) => {
              const Icon = s.icon;
              return (
                <TabsTrigger
                  key={s.id}
                  value={s.id}
                  ref={(el) => { stepperRefs.current[i] = el; }}
                  className="flex items-center gap-2 rounded-full border border-border bg-secondary px-4 py-2 text-sm font-medium text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
                >
                  <Icon size={15} />
                  {s.label}
                </TabsTrigger>
              );
            })}
          </TabsList>


          {/* ---------------------------- FRAME ---------------------------- */}
          <TabsContent value="frame" className="mt-0">
            <div className="dl-frame">
              <Panel>
                <SectionTag icon={Target} text="The decision" />
                <label className="mt-3 block text-sm text-muted-foreground">
                  What decision are you facing?
                </label>
                <Textarea
                  ref={decisionTextareaRef}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  rows={3}
                  className="mt-2 resize-y bg-muted"
                />

                {/* Sources: PDFs + URLs */}
                <div className="mt-4">
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    Sources (optional)
                    <HelpPopover
                      title="Sources"
                      body="Drop PDFs or paste links. We'll read them and use them as the starting point for your decision map."
                    />
                  </div>
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const list = e.target.files ? Array.from(e.target.files) : [];
                      if (list.length) addPdfFiles(list);
                      e.target.value = "";
                    }}
                  />
                  <div
                    ref={dropzoneRef}
                    onClick={() => pdfInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault(); setDragOver(false);
                      const list = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
                      if (list.length) addPdfFiles(list);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") pdfInputRef.current?.click(); }}
                    className={
                      "mt-2 cursor-pointer rounded-xl border-2 border-dashed p-4 text-center text-xs transition-colors " +
                      (dragOver
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-muted/40 text-muted-foreground hover:border-primary/60")
                    }
                  >
                    <Upload size={16} className="mx-auto mb-1 text-primary" />
                    <div>
                      <b className="text-foreground">Drop PDFs here</b> or click to browse — up to 5 files, 10 MB each.
                    </div>
                  </div>
                  {pdfFiles.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pdfFiles.map((f, i) => (
                        <span key={f.name + i} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground">
                          <FileText size={12} className="text-primary" />
                          <span className="max-w-[180px] truncate">{f.name}</span>
                          <span className="text-dim">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                          <button
                            type="button"
                            aria-label={"Remove " + f.name}
                            onClick={(e) => { e.stopPropagation(); removePdf(i); }}
                            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-dim hover:text-foreground"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3">
                    <Input
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); tryAddUrl(urlInput); }
                      }}
                      onBlur={() => { if (urlInput.trim()) tryAddUrl(urlInput); }}
                      placeholder="Paste a URL and press Enter"
                      className="bg-muted"
                      aria-label="Source URL"
                    />
                    {urls.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {urls.map((u, i) => (
                          <span key={u + i} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground">
                            <span className="max-w-[220px] truncate">{u}</span>
                            <button
                              type="button"
                              aria-label={"Remove " + u}
                              onClick={() => removeUrl(i)}
                              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-dim hover:text-foreground"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {(() => {
                  const hasSources = pdfFiles.length > 0 || urls.length > 0;
                  const nSrc = pdfFiles.length + urls.length;
                  const busy = ingesting || drafting;
                  const ingestMessages = [
                    "Reading your sources…",
                    "Picking out what really matters…",
                    "Spotting the knock-on effects…",
                    "Laying out your options…",
                  ];
                  return (
                    <>
                      {/* Stateful guidance callout */}
                      <div className="mt-5 rounded-xl border border-primary/40 bg-primary/10 p-4">
                        {ingesting ? (
                          <div>
                            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                              <Loader2 size={16} className="animate-spin text-primary" />
                              {ingestMessages[ingestStep]}
                            </div>
                            <div className="mt-3 flex gap-1.5">
                              {ingestMessages.map((_, i) => (
                                <div
                                  key={i}
                                  className={
                                    "h-1 flex-1 rounded-full transition-colors " +
                                    (i <= ingestStep ? "bg-primary" : "bg-primary/20")
                                  }
                                />
                              ))}
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              This can take up to ~30s for large PDFs.
                            </p>
                          </div>
                        ) : hasSources ? (
                          <div>
                            <ul className="space-y-1.5 text-sm">
                              <li className="flex items-center gap-2 text-foreground">
                                <CheckCircle2 size={15} className="text-primary" />
                                <span><b>Step 1</b> — {nSrc} source{nSrc === 1 ? "" : "s"} attached</span>
                              </li>
                              <li className="flex items-center gap-2 text-muted-foreground">
                                <Circle size={15} className="text-muted-foreground/60" />
                                <span><b>Step 2</b> (optional) — refine your question above</span>
                              </li>
                              <li className="flex items-center gap-2 text-foreground">
                                <PlayCircle size={15} className="text-primary" />
                                <span><b>Step 3</b> — click “Map my decision” below</span>
                              </li>
                            </ul>
                            <p className="mt-3 text-xs text-muted-foreground">
                              Decision Lens will read your sources on the server and build the variables, feedback loops, and options — about 10–30 seconds.
                            </p>
                          </div>
                        ) : (
                          <div>
                            <div className="text-sm font-medium text-foreground">Two ways to start</div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Upload PDFs or paste links above and Decision Lens will read them to build your decision landscape — or skip sources and let AI draft from your question alone.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Action row */}
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        {hasSources ? (
                          <>
                            <Button
                              onClick={() => { void runIngest(); }}
                              disabled={busy}
                              size="lg"
                              className="gap-2"
                            >
                              {ingesting ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                              {ingesting ? "Mapping…" : "Map my decision"}
                            </Button>
                            <Button
                              onClick={() => { void runAutoDraft(decision); }}
                              disabled={busy}
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                            >
                              {drafting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                              {drafting ? "Drafting…" : "Skip sources & draft from text"}
                            </Button>
                          </>
                        ) : (
                          <Button
                            onClick={() => { void runAutoDraft(decision); }}
                            disabled={busy}
                            size="lg"
                            className="gap-2"
                          >
                            {drafting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                            {drafting ? "Drafting…" : "Auto-draft from my question"}
                          </Button>
                        )}
                      </div>

                      {/* Optional refinements */}
                      <div className="mt-6 border-t border-border pt-4">
                        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Optional refinements
                        </div>
                        <div className="mt-3 dl-2">
                          <div>
                            <label className="block text-sm text-muted-foreground">
                              What does success mean? (outcome label)
                            </label>
                            <Input
                              value={outcomeName}
                              onChange={(e) => setOutcomeName(e.target.value)}
                              className="mt-2 bg-muted"
                            />
                          </div>
                          <div>
                            <label className="flex items-center gap-1 text-sm text-muted-foreground">
                              Horizon: <span className="text-primary">{horizon} steps</span>
                              <HelpPopover
                                title="Horizon"
                                body="How many steps forward we simulate each option. Short horizons show the immediate punch; long horizons reveal where feedback loops take you."
                              />
                            </label>
                            <Slider
                              min={4}
                              max={36}
                              step={1}
                              value={[horizon]}
                              onValueChange={(v) => setHorizon(v[0])}
                              className="mt-4"
                              aria-label="Horizon"
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}

              </Panel>




              <div ref={templatesPanelRef}>
                <Panel>
                  <SectionTag icon={GitBranch} text="Template gallery" />
                  <p className="mt-2 text-xs text-dim">
                    Pick a starting system — built-in or one of your saved models.
                  </p>
                  <div
                    className="mt-3 grid gap-3"
                    style={{ gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))" }}
                  >
                    {TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.label}
                        type="button"
                        onClick={() => loadBuiltinTemplate(tpl)}
                        className="group flex h-full flex-col gap-2 rounded-md border border-border bg-muted p-3 text-left transition-colors hover:border-primary"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            Built-in
                          </span>
                          <ArrowRight size={14} className="text-primary opacity-60 group-hover:opacity-100" />
                        </div>
                        <div className="text-sm font-medium text-foreground">{tpl.label}</div>
                        <div className="text-[11px] text-dim">Outcome · {tpl.outcomeName}</div>
                      </button>
                    ))}

                    {userTemplates.map((t) => {
                      const badge =
                        t.source === "ai" ? "AI" : t.source === "documents" ? "Documents" : "Manual";
                      return (
                        <div
                          key={t.id}
                          className="group flex h-full flex-col gap-2 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                              <Bookmark size={10} /> {badge}
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => renameUserTemplate(t.id)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                aria-label={`Rename ${t.name}`}
                                title="Rename"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteUserTemplate(t.id)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                                aria-label={`Delete ${t.name}`}
                                title="Delete"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => loadUserTemplate(t)}
                            className="flex flex-1 flex-col gap-1 text-left"
                          >
                            <div className="text-sm font-medium text-foreground">{t.name}</div>
                            <div className="text-[11px] text-dim">Outcome · {t.model.outcomeName}</div>
                          </button>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => { loadModel(blankStarter()); setStage("model"); }}
                      className="flex h-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-transparent p-3 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    >
                      <Plus size={16} />
                      Start blank
                    </button>
                  </div>
                </Panel>
              </div>

            </div>
          </TabsContent>

          {/* ---------------------------- MODEL ---------------------------- */}
          <TabsContent value="model" className="mt-0">
            {(aiSummary || (aiSources && aiSources.length > 0)) && (
              <div className="mb-5">
                <Panel>
                  <SectionTag icon={Sparkles} text="Your decision landscape" />
                  {aiSummary && (
                    <p className="mt-2 text-sm text-foreground">{aiSummary}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Built from your sources — review and adjust anything below, then move to Options → Decide.
                  </p>
                  {aiAttachedCount > 0 && (
                    <p className="mt-2 text-xs text-foreground">
                      Used <b>{Math.max(0, aiAttachedCount - aiSkippedCount)}</b> of <b>{aiAttachedCount}</b> source{aiAttachedCount === 1 ? "" : "s"}
                      {aiSkippedCount > 0 && (
                        <span className="text-muted-foreground"> ({aiSkippedCount} skipped: unreadable or too large)</span>
                      )}
                      .
                    </p>
                  )}
                  {aiSources && aiSources.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {aiSources.map((s, i) => (
                        <span
                          key={s.name + i}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
                        >
                          {s.type === "pdf" ? <FileText size={11} className="text-primary" /> : <Upload size={11} className="text-primary" />}
                          <span className="max-w-[220px] truncate">{s.name}</span>
                          <span className="text-dim uppercase tracking-wider">{s.type}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-dim">
                    Hover the <span className="inline-flex items-center"><HelpCircle size={11} className="mx-0.5" /></span> next to each variable to see why the AI included it.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <Button
                      onClick={() => setStage("options")}
                      className="gap-2"
                    >
                      Looks right — set up options <ArrowRight size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStage("frame")}
                      className="gap-1.5"
                    >
                      <ArrowLeft size={13} /> Re-map from sources
                    </Button>
                  </div>
                </Panel>
              </div>
            )}

            <div className="mb-5">
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <SectionTag icon={Lightbulb} text="AI critique" />
                    <HelpPopover
                      title="AI critique"
                      body="Looks for missing drivers, weak feedback loops, near-duplicate options, or a missing risk variable. Accept any suggestion to add it to your model."
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={runCritique}
                    disabled={critiquing || variables.length === 0}
                    className="gap-1.5"
                  >
                    {critiquing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                    {critique ? "Re-run critique" : "Critique my model"}
                  </Button>
                </div>
                {critique && critique.length > 0 && (
                  <ul className="mt-3 grid list-none gap-2 p-0">
                    {critique.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-3 rounded-lg border border-border bg-muted/60 p-2.5 text-xs"
                      >
                        <Lightbulb size={13} className="mt-0.5 shrink-0 text-primary" />
                        <div className="flex-1 leading-relaxed text-foreground">
                          {s.message}
                          {s.kind === "add_variable" && s.variable && (
                            <div className="mt-1 text-dim">
                              → add variable <b className="text-foreground">{s.variable.name}</b>{" "}
                              ({s.variable.weight >= 0 ? "helps" : "hurts"} {Math.abs(s.variable.weight)})
                            </div>
                          )}
                          {s.kind === "add_influence" && s.influence && (
                            <div className="mt-1 text-dim">
                              → link <b className="text-foreground">{variables.find((v) => v.id === s.influence!.from)?.name ?? s.influence.from}</b>
                              {" → "}
                              <b className="text-foreground">{variables.find((v) => v.id === s.influence!.to)?.name ?? s.influence.to}</b>
                              {" "}({s.influence.strength >= 0 ? "+" : ""}{s.influence.strength})
                            </div>
                          )}
                        </div>
                        {(s.kind === "add_variable" || s.kind === "add_influence") && (
                          <Button size="sm" variant="default" onClick={() => acceptSuggestion(s)} className="h-7 gap-1 px-2 text-[11px]">
                            <Plus size={11} /> Accept
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {critique && critique.length === 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No critical gaps found — your model looks coherent.
                  </p>
                )}
                {!critique && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Get 2–4 suggestions: missing drivers, weak feedback loops, duplicate options, or absent risks.
                  </p>
                )}
              </Panel>
            </div>

            <div className="dl-model">


              <div className={aiHighlight ? "rounded-xl ring-2 ring-primary/70 ring-offset-2 ring-offset-background motion-safe:animate-pulse transition-shadow" : "transition-shadow"}>
              <Panel>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <SectionTag icon={Network} text="State variables" />
                    <HelpPopover
                      title="Latent variable"
                      body="A small number of underlying forces that actually drive the outcome — not symptoms. Examples: trust, demand, runway."
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setVariables([...variables, { id: uid(), name: "New driver", value: 50, weight: 40 }])
                    }
                    className="gap-1"
                  >
                    <Plus size={13} /> Add
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  The few things that actually drive {outcomeName.toLowerCase()}. Set where each stands today and
                  whether it helps or hurts.
                </p>
                <div className="mt-3 grid gap-3">
                  {variables.map((v) => (
                    <div key={v.id} className="rounded-xl border border-border bg-muted p-3">
                      <div className="flex items-center gap-2">
                        <Input
                          value={v.name}
                          onChange={(e) => updVar(v.id, { name: e.target.value })}
                          className="flex-1 h-9 bg-transparent text-sm font-medium"
                          aria-label={"Variable name: " + v.name}
                        />
                        {v.rationale && (
                          <HelpPopover title="Why this variable" body={v.rationale} />
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeVar(v.id)}
                          aria-label={"Remove " + v.name}
                          className="text-dim"
                        >
                          <X size={15} />
                        </Button>
                      </div>
                      <div className="mt-2 dl-2">
                        <SliderRow
                          label="Today" val={v.value} min={0} max={100} tone="primary"
                          onChange={(x) => updVar(v.id, { value: x })}
                        />
                        <SliderRow
                          label={v.weight >= 0 ? "Helps outcome" : "Hurts outcome"}
                          val={v.weight} min={-100} max={100}
                          tone={v.weight >= 0 ? "helps" : "hurts"}
                          onChange={(x) => updVar(v.id, { weight: x })}
                          help={{
                            title: "Weight (helps / hurts)",
                            body: "How strongly this variable lifts (positive) or drags (negative) the outcome. Bigger magnitude = bigger swing.",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <SectionTag icon={GitBranch} text="Influences (the loops)" />
                    <HelpPopover
                      title="Influence (feedback loop)"
                      body="A directed link saying one variable nudges another up or down each step. Chain a few together and you get a feedback loop — the engine of long-run behavior."
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={addInfluence}
                    className="gap-1"
                  >
                    <Plus size={13} /> Add
                  </Button>
                </div>
                <div className="mt-3 grid gap-2">
                  {influences.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      <b className="text-foreground">No links yet.</b> Add how one variable pushes another — this is what creates the feedback loops that make outcomes diverge over time.
                    </div>
                  )}

                  {influences.map((inf, idx) => (
                    <div key={idx} className="flex items-center gap-2 rounded-xl border border-border bg-muted p-2">
                      <VarSelect value={inf.from} vars={variables} onChange={(val) => updInf(idx, { from: val })} />
                      <ArrowRight
                        size={14}
                        className={inf.strength >= 0 ? "text-helps" : "text-hurts"}
                      />
                      <VarSelect value={inf.to} vars={variables} onChange={(val) => updInf(idx, { to: val })} />
                      <Slider
                        min={-100} max={100} step={1} value={[inf.strength]}
                        onValueChange={(val) => updInf(idx, { strength: val[0] })}
                        className="flex-1 min-w-[60px]"
                        aria-label="Influence strength"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setInfluences(influences.filter((_, i) => i !== idx))}
                        aria-label="Remove influence"
                        className="text-dim"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                </div>
              </Panel>
              </div>

              {/* live system map — transforms as you add variables & links */}
              <Panel>
                <SectionTag icon={Network} text="System map" />
                <p className="mt-2 text-xs text-muted-foreground">
                  Your model, live. Nodes are state variables (green helps, red hurts); arrows are influences.
                </p>
                <SystemMap variables={variables} influences={influences} />
                <div className="mt-3 flex justify-end">
                  <NavBtn dir="next" onClick={() => setStage("options")}>Define options</NavBtn>
                </div>
              </Panel>
            </div>
          </TabsContent>

          {/* ---------------------------- OPTIONS ---------------------------- */}
          <TabsContent value="options" className="mt-0">
            <div className="grid gap-5">
              <Panel>
                <div className="flex items-center justify-between">
                  <SectionTag icon={GitBranch} text="The options you're choosing between" />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setOptions([...options, { id: uid(), name: "Option " + (options.length + 1), pushes: {} }])
                    }
                    className="gap-1"
                  >
                    <Plus size={13} /> Add option
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Each option is an action that pushes the state every step. Drag a variable up if the option lifts
                  it, down if it drags it.
                </p>
                {options.every((o) => Object.values(o.pushes).every((p) => !p)) && (
                  <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                    <b className="text-foreground">No effects set yet.</b> Move at least one slider per option — that's how each option distinguishes itself in the simulation.
                  </div>
                )}


                <div
                  className="mt-4 grid gap-4"
                  style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}
                >
                  {options.map((o, i) => {
                    const color = OPT_COLORS[i % OPT_COLORS.length];
                    return (
                      <div
                        key={o.id}
                        className="rounded-xl bg-muted p-3"
                        style={{ border: "1px solid " + color + "66" }}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded"
                            style={{ background: color }}
                          />
                          <Input
                            value={o.name}
                            onChange={(e) => updOpt(o.id, { name: e.target.value })}
                            className="flex-1 h-9 bg-transparent text-sm font-medium"
                            aria-label={"Option name: " + o.name}
                          />
                          {options.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setOptions(options.filter((x) => x.id !== o.id))}
                              aria-label={"Remove " + o.name}
                              className="text-dim"
                            >
                              <X size={15} />
                            </Button>
                          )}
                        </div>
                        <div className="mt-3 grid gap-2">
                          {variables.map((v) => (
                            <div key={v.id} className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground" style={{ width: 92 }}>
                                {v.name}
                              </span>
                              <Slider
                                min={-60} max={60} step={1}
                                value={[o.pushes[v.id] || 0]}
                                onValueChange={(val) =>
                                  updOpt(o.id, { pushes: { ...o.pushes, [v.id]: val[0] } })
                                }
                                className="flex-1"
                                aria-label={o.name + " effect on " + v.name}
                              />
                              <span
                                className="text-xs text-dim text-right"
                                style={{ width: 26 }}
                              >
                                {o.pushes[v.id] > 0 ? "+" : ""}{o.pushes[v.id] || 0}
                              </span>
                            </div>
                          ))}
                        </div>
                        <ActionPlanEditor
                          option={o}
                          variables={variables}
                          onChange={(actions) => updOpt(o.id, { actions })}
                          onSuggest={() => runSuggestActions(o)}
                          suggesting={!!actionLoading[o.id]}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-between">
                  <NavBtn dir="back" onClick={() => setStage("model")}>Back to model</NavBtn>
                  <NavBtn dir="next" onClick={() => setStage("decide")}>Roll forward &amp; decide</NavBtn>
                </div>
              </Panel>
            </div>
          </TabsContent>

          {/* ---------------------------- DECIDE ---------------------------- */}
          <TabsContent value="decide" className="mt-0">
            <div className="dl-decide">
              <Panel>
                <SectionTag icon={Telescope} text={"Rollout · " + outcomeName} />
                <p className="mt-2 text-xs text-muted-foreground">
                  Each line is one option's {outcomeName.toLowerCase()} over {horizon} steps. The shaded fan on the
                  focused option is the p10–p90 range from Monte-Carlo rollouts — it widens as model noise
                  compounds, so trust the near term.
                </p>
                <TrajectoryChart
                  runs={runs}
                  horizon={horizon}
                  focusId={focusOpt}
                  best={best}
                  mcBands={mc.bands}
                />
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {runs.map((r) => (
                    <span key={r.option.id} className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: r.color }} />
                      {r.option.name}
                    </span>
                  ))}
                  <span className="ml-auto text-dim">simulations: {MC_RUNS}</span>
                </div>
              </Panel>


              <div className="grid gap-5">
                <Panel>
                  <SectionTag icon={Target} text="Ranked options" />
                  <div className="mt-3 grid gap-2">
                    {ranked.map((r, i) => (
                      <button
                        key={r.option.id}
                        onMouseEnter={() => setFocusOpt(r.option.id)}
                        onMouseLeave={() => setFocusOpt(null)}
                        onFocus={() => setFocusOpt(r.option.id)}
                        onBlur={() => setFocusOpt(null)}
                        onClick={() => setFocusOpt((cur) => (cur === r.option.id ? null : r.option.id))}
                        aria-pressed={focusOpt === r.option.id}
                        className={
                          "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                          (i === 0
                            ? "border-helps/40 bg-helps/10"
                            : "border-border bg-muted hover:bg-accent")
                        }
                      >
                        <span className="w-[18px] text-sm font-semibold text-dim">{i + 1}</span>
                        <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: r.color }} />
                        <span className="flex-1 text-sm">{r.option.name}</span>
                        <span className="flex flex-col items-end leading-tight">
                          <span className="text-lg font-bold tabular-nums">
                            {Math.round(r.winProb * 100)}%
                          </span>
                          <span className="text-[10px] text-dim tabular-nums">
                            median {Math.round(r.score)}
                          </span>
                        </span>
                        {i === 0 && <span className="text-xs font-semibold text-helps">best in {Math.round(r.winProb * 100)}%</span>}
                      </button>
                    ))}

                  </div>

                  <div className="mt-4 border-t border-border pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Wand2 size={13} className="text-primary" />
                        <span>Why does <b className="text-foreground">{best?.option.name ?? "this option"}</b> win?</span>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={runExplain}
                        disabled={explaining || ranked.length === 0}
                        className="gap-1.5"
                      >
                        {explaining ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                        {explanation ? "Re-explain" : "Explain"}
                      </Button>
                    </div>
                    {explanation && (
                      <p className="mt-2 rounded-lg border border-border bg-muted/60 p-3 text-xs leading-relaxed text-foreground">
                        {explanation}
                      </p>
                    )}
                  </div>
                </Panel>

                {best && (() => {
                  const focused = focusOpt ? ranked.find((r) => r.option.id === focusOpt) : null;
                  const shown = focused ?? best;
                  return (
                    <ActionPlanReadout
                      option={shown.option}
                      winProb={shown.winProb}
                      variables={variables}
                      decision={decision}
                      outcomeName={outcomeName}
                      explanation={explanation}
                      suggesting={!!actionLoading[shown.option.id]}
                      onSuggest={() => runSuggestActions(shown.option)}
                      onGoOptions={() => setStage("options")}
                    />
                  );
                })()}




                <Panel>
                  <SectionTag icon={Telescope} text="Respect the model error" />
                  <ul className="mt-3 grid list-none gap-2 p-0 text-xs text-muted-foreground">
                    <li>
                      <b className="text-foreground">Load-bearing:</b> the gap between #1 and #2 is{" "}
                      {Math.round(best.score - (ranked[1]?.score ?? best.score))} pts. If that's thin, this is a
                      near-tie — don't over-trust the ranking.
                    </li>
                    <li>
                      <b className="text-foreground">Decays with horizon:</b> reliability falls off after a few
                      steps. Re-run as reality comes in.
                    </li>
                    <li>
                      <b className="text-foreground">Cheapest probe:</b>{" "}
                      {suggestedProbe ? (
                        <>measure <b className="text-primary">{suggestedProbe.variable.name}</b> before committing — it feeds {suggestedProbe.outDegree} downstream {suggestedProbe.outDegree === 1 ? "link" : "links"}.</>
                      ) : (
                        <>measure whichever upstream variable feeds the most arrows before committing.</>
                      )}
                    </li>
                    {best.winProb >= 0.95 && Math.round(best.score - (ranked[1]?.score ?? best.score)) >= 10 && (
                      <li>
                        <b className="text-foreground">Robust lead:</b> in this model, #1 wins in essentially every plausible world. Stress-test it by lowering its strongest variable weight or strengthening a competing influence.
                      </li>
                    )}
                  </ul>

                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setStage("model")}
                    className="mt-3 gap-2"
                  >
                    <RotateCcw size={13} /> Adjust the model
                  </Button>
                </Panel>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <WelcomeDialog
        open={welcomeOpen}
        dontShow={dontShow}
        setDontShow={setDontShow}
        onClose={() => closeWelcome(dontShow)}
        onDocs={startFromDocs}
        onDescribe={startFromText}
        onTemplate={startFromTemplate}
        onTour={startTour}
      />
      <TourCoachmark
        step={tourStep}
        anchors={[dropzoneRef.current, ...stepperRefs.current]}
        onNext={() => {
          const next = (tourStep ?? 0) + 1;
          if (next > STAGES.length) { setTourStep(null); return; }
          setTourStep(next);
          // next=1 → Frame tab, next=2 → Model, etc.
          const stageIdx = Math.max(0, next - 1);
          if (stageIdx < STAGES.length) setStage(STAGES[stageIdx].id);
        }}
        onSkip={() => setTourStep(null)}
      />


      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookmarkPlus size={16} className="text-primary" />
              Save as template
            </DialogTitle>
            <DialogDescription>
              Decision Lens · stores your current model in this browser for reuse.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 grid gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="dl-save-name">Template name</label>
            <Input
              id="dl-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmSaveTemplate(); }}
              placeholder="e.g. Q3 market entry"
              autoFocus
            />
            <div className="text-[11px] text-dim">
              Will be saved as <span className="text-foreground">{inferCurrentSource()}</span> source.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={confirmSaveTemplate} disabled={!saveName.trim()} className="gap-2">
              <BookmarkPlus size={14} /> Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ----------------------------- small parts ------------------------------- */
const EFFORT_OPTS: DecisionAction["effort"][] = ["low", "med", "high"];
const WHEN_OPTS: DecisionAction["when"][] = ["now", "soon", "ongoing"];

function ActionPlanEditor({
  option, variables, onChange, onSuggest, suggesting,
}: {
  option: DecisionOption;
  variables: Variable[];
  onChange: (actions: DecisionAction[]) => void;
  onSuggest: () => void;
  suggesting: boolean;
}) {
  const actions = option.actions ?? [];
  const pushedIds = new Set(
    Object.entries(option.pushes).filter(([, v]) => v !== 0).map(([k]) => k),
  );

  function setAction(idx: number, patch: Partial<DecisionAction>) {
    const next = actions.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    onChange(next);
  }
  function removeAction(idx: number) {
    onChange(actions.filter((_, i) => i !== idx));
  }
  function addAction() {
    onChange([...actions, { text: "" }]);
  }
  function toggleTarget(idx: number, varId: string) {
    const cur = actions[idx]?.targets ?? [];
    const has = cur.includes(varId);
    const next = has ? cur.filter((t) => t !== varId) : [...cur, varId];
    setAction(idx, { targets: next.length ? next : undefined });
  }

  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          Action plan
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onSuggest}
          disabled={suggesting}
          className="h-7 gap-1 text-xs"
          aria-label={`Suggest actions for ${option.name}`}
        >
          {suggesting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Suggest actions
        </Button>
      </div>

      {actions.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No actions yet. Add a step the team would execute, or let AI suggest some.
        </p>
      )}

      <div className="mt-2 grid gap-2">
        {actions.map((a, i) => {
          const targets = a.targets ?? [];
          const inconsistent = targets.some((t) => !pushedIds.has(t));
          return (
            <div
              key={i}
              className="rounded-lg border border-border/60 bg-background/40 p-2"
            >
              <div className="flex items-start gap-2">
                <Input
                  value={a.text}
                  onChange={(e) => setAction(i, { text: e.target.value })}
                  placeholder="e.g. Ship MVP to 3 lighthouse customers within 30 days"
                  className="h-8 flex-1 bg-transparent text-xs"
                  aria-label={`Action ${i + 1} for ${option.name}`}
                />
                {inconsistent && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-500"
                        aria-label="Action targets a variable this option doesn't push"
                      >
                        <AlertTriangle size={14} />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent side="top" className="w-64 text-xs">
                      This action targets a variable the option's sliders don't move. Either
                      adjust the pushes above or remove the unrelated target.
                    </PopoverContent>
                  </Popover>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAction(i)}
                  className="h-8 w-8 text-muted-foreground"
                  aria-label={`Remove action ${i + 1}`}
                >
                  <Trash2 size={13} />
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {variables.map((v) => {
                  const on = targets.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => toggleTarget(i, v.id)}
                      aria-pressed={on}
                      aria-label={`Target ${v.name}`}
                      className={
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors " +
                        (on
                          ? "border-primary/60 bg-primary/15 text-foreground"
                          : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground")
                      }
                    >
                      {on && <Check size={10} />}
                      {v.name}
                    </button>
                  );
                })}

                <span className="mx-1 h-3 w-px bg-border" aria-hidden />

                {EFFORT_OPTS.map((e) => {
                  const on = a.effort === e;
                  return (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setAction(i, { effort: on ? undefined : e })}
                      aria-pressed={on}
                      aria-label={`Effort ${e}`}
                      className={
                        "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors " +
                        (on
                          ? "border-foreground/40 bg-foreground/10 text-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:text-foreground")
                      }
                    >
                      {e}
                    </button>
                  );
                })}

                <span className="mx-1 h-3 w-px bg-border" aria-hidden />

                {WHEN_OPTS.map((w) => {
                  const on = a.when === w;
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setAction(i, { when: on ? undefined : w })}
                      aria-pressed={on}
                      aria-label={`When ${w}`}
                      className={
                        "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors " +
                        (on
                          ? "border-foreground/40 bg-foreground/10 text-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:text-foreground")
                      }
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <Button
        size="sm"
        variant="ghost"
        onClick={addAction}
        className="mt-2 h-7 gap-1 text-xs text-muted-foreground"
      >
        <Plus size={12} /> Add action
      </Button>
    </div>
  );
}

const WHEN_LABEL: Record<NonNullable<DecisionAction["when"]>, string> = {
  now: "Now",
  soon: "Soon",
  ongoing: "Ongoing",
};

function ActionPlanReadout({
  option, winProb, variables, decision, outcomeName, explanation,
  suggesting, onSuggest, onGoOptions,
}: {
  option: DecisionOption;
  winProb: number;
  variables: Variable[];
  decision: string;
  outcomeName: string;
  explanation: string | null;
  suggesting: boolean;
  onSuggest: () => void;
  onGoOptions: () => void;
}) {
  const varById = useMemo(() => {
    const m = new Map<string, Variable>();
    for (const v of variables) m.set(v.id, v);
    return m;
  }, [variables]);

  const actions = option.actions ?? [];
  const groups: Record<"now" | "soon" | "ongoing", DecisionAction[]> = { now: [], soon: [], ongoing: [] };
  for (const a of actions) {
    const bucket = (a.when ?? "ongoing") as "now" | "soon" | "ongoing";
    groups[bucket].push(a);
  }

  async function exportPlan() {
    const winPct = Math.round(winProb * 100);
    const lines: string[] = [];
    lines.push(`# Decision Lens — Action plan`);
    lines.push("");
    lines.push(`**Decision:** ${decision || "(unnamed decision)"}`);
    lines.push(`**Chosen strategy:** ${option.name}`);
    lines.push(`**Win-probability (${outcomeName}):** ${winPct}%`);
    lines.push("");
    if (explanation) {
      lines.push(`## Why this strategy`);
      lines.push("");
      lines.push(explanation);
      lines.push("");
    }
    lines.push(`## Actions`);
    (["now", "soon", "ongoing"] as const).forEach((k) => {
      if (!groups[k].length) return;
      lines.push("");
      lines.push(`### ${WHEN_LABEL[k]}`);
      for (const a of groups[k]) {
        const targets = (a.targets ?? [])
          .map((tid) => {
            const v = varById.get(tid);
            if (!v) return null;
            const push = option.pushes[tid] ?? 0;
            const arrow = push > 0 ? "▲" : push < 0 ? "▼" : "·";
            return `${arrow} ${v.name}`;
          })
          .filter(Boolean) as string[];
        const meta: string[] = [];
        if (a.effort) meta.push(`effort: ${a.effort}`);
        if (targets.length) meta.push(`drivers: ${targets.join(", ")}`);
        lines.push(`- ${a.text}${meta.length ? `  _(${meta.join(" · ")})_` : ""}`);
      }
    });
    const md = lines.join("\n");
    try {
      await navigator.clipboard.writeText(md);
      toast.success("Decision Lens · plan copied", {
        description: `${option.name} — ${actions.length} action${actions.length === 1 ? "" : "s"} on clipboard as Markdown.`,
      });
    } catch {
      toast.error("Decision Lens · couldn't copy plan", {
        description: "Clipboard unavailable in this browser.",
      });
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTag icon={PlayCircle} text={`Action plan — ${option.name}`} />
        <Button
          size="sm"
          variant="secondary"
          onClick={exportPlan}
          disabled={actions.length === 0}
          className="h-8 gap-1.5"
          aria-label={`Export action plan for ${option.name} as Markdown`}
        >
          <Share2 size={13} /> Export plan
        </Button>
      </div>

      {explanation && (
        <div className="mt-3 rounded-lg border border-border bg-muted/60 p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Why this strategy
          </div>
          <p className="text-xs leading-relaxed text-foreground">{explanation}</p>
        </div>
      )}

      {actions.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-background/40 p-4 text-xs text-muted-foreground">
          <p>
            No actions yet — add them in <button onClick={onGoOptions} className="underline underline-offset-2 hover:text-foreground">Options</button>, or
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={onSuggest}
            disabled={suggesting}
            className="mt-2 h-8 gap-1.5"
            aria-label={`Generate actions for ${option.name}`}
          >
            {suggesting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            Generate them
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {(["now", "soon", "ongoing"] as const).map((k) => (
            <div key={k} className="rounded-lg border border-border/60 bg-background/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {WHEN_LABEL[k]}
                </div>
                <span className="text-[10px] tabular-nums text-dim">{groups[k].length}</span>
              </div>
              {groups[k].length === 0 ? (
                <p className="text-[11px] text-dim">—</p>
              ) : (
                <ul className="grid list-none gap-2 p-0">
                  {groups[k].map((a, i) => (
                    <li key={i} className="rounded-md border border-border/50 bg-card/60 p-2">
                      <p className="text-xs leading-snug text-foreground">{a.text}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {a.effort && (
                          <span className="rounded-full border border-border bg-secondary/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                            {a.effort}
                          </span>
                        )}
                        {(a.targets ?? []).map((tid) => {
                          const v = varById.get(tid);
                          if (!v) return null;
                          const push = option.pushes[tid] ?? 0;
                          const arrow = push > 0 ? "▲" : push < 0 ? "▼" : "·";
                          const tone = v.weight >= 0 ? "text-helps border-helps/40 bg-helps/10" : "text-hurts border-hurts/40 bg-hurts/10";
                          return (
                            <span
                              key={tid}
                              className={"inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] " + tone}
                              aria-label={`${v.name} ${push > 0 ? "increases" : push < 0 ? "decreases" : "unchanged"}`}
                            >
                              <span aria-hidden>{arrow}</span>
                              {v.name}
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}




function SectionTag({ icon: Icon, text }: { icon: React.ComponentType<{ size?: number; className?: string }>; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground tracking-[0.12em]">
      <Icon size={14} className="text-primary" /> {text}
    </div>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={"border-border bg-card p-5 " + className}>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

type Tone = "primary" | "helps" | "hurts";
const TONE_VAR: Record<Tone, CSSProperties | undefined> = {
  primary: undefined,
  helps: { ["--primary" as any]: "var(--helps)" } as CSSProperties,
  hurts: { ["--primary" as any]: "var(--hurts)" } as CSSProperties,
};
const TONE_TEXT: Record<Tone, string> = {
  primary: "text-primary",
  helps: "text-helps",
  hurts: "text-hurts",
};

function SliderRow({
  label, val, min, max, tone, onChange, help,
}: {
  label: string;
  val: number;
  min: number;
  max: number;
  tone: Tone;
  onChange: (n: number) => void;
  help?: { title: string; body: string };
}) {
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {label}
          {help && <HelpPopover title={help.title} body={help.body} />}
        </span>
        <span className={TONE_TEXT[tone]}>{val}</span>
      </div>
      <Slider
        min={min} max={max} step={1}
        value={[val]}
        onValueChange={(v) => onChange(v[0])}
        className="mt-2 w-full"
        style={TONE_VAR[tone]}
        aria-label={label}
      />
    </div>
  );
}

function VarSelect({
  value, vars, onChange,
}: {
  value: string;
  vars: Variable[];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-8 max-w-[140px] bg-secondary text-xs"
        aria-label="Variable"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {vars.map((v) => (
          <SelectItem key={v.id} value={v.id} className="text-xs">
            {v.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NavBtn({ dir, onClick, children }: { dir: "next" | "back"; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      onClick={onClick}
      variant={dir === "next" ? "default" : "secondary"}
      className="gap-2"
    >
      {dir === "back" && <ArrowLeft size={15} />}
      {children}
      {dir === "next" && <ArrowRight size={15} />}
    </Button>
  );
}

/* ----------------------- live system map (SVG) ---------------------------
   Kept as-is per spec — uses fixed SVG palette constants so node/arrow
   semantics (helps-green / hurts-red) stay legible against the chart bg. */
function SystemMapImpl({ variables, influences }: { variables: Variable[]; influences: Influence[] }) {
  const W = 460, H = 320, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 56;
  const pos: Record<string, { x: number; y: number }> = {};
  const n = variables.length;
  variables.forEach((v, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
    pos[v.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
  return (
    <div className="mt-3 rounded-xl" style={{ background: SVG.inset, border: "1px solid " + SVG.border }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="System map">
        <defs>
          <marker id="dl-g" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={SVG.good} />
          </marker>
          <marker id="dl-r" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={SVG.bad} />
          </marker>
        </defs>
        {influences.map((inf, idx) => {
          const a = pos[inf.from], b = pos[inf.to];
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
          const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
          const col = inf.strength >= 0 ? SVG.good : SVG.bad;
          return (
            <path key={idx} d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`} fill="none"
              stroke={col} strokeWidth={1 + Math.abs(inf.strength) / 45} opacity="0.55"
              strokeDasharray={inf.strength < 0 ? "4 3" : undefined}
              markerEnd={`url(#${inf.strength >= 0 ? "dl-g" : "dl-r"})`} />
          );
        })}
        {variables.map((v) => {
          const p = pos[v.id];
          const col = v.weight >= 0 ? SVG.good : SVG.bad;
          const r = 22 + Math.abs(v.weight) / 8;
          return (
            <g key={v.id}>
              <circle cx={p.x} cy={p.y} r={r} fill={col + "22"} stroke={col} strokeWidth="2" />
              <circle cx={p.x} cy={p.y} r={(r - 6) * (v.value / 100)} fill={col + "44"} />
              <text x={p.x} y={p.y + 4} fill="#ffffff" fontSize="11" textAnchor="middle" fontWeight="700">
                {v.weight >= 0 ? "+" : "−"}
              </text>
              <text x={p.x} y={p.y + r + 14} fill={SVG.ink2} fontSize="11" textAnchor="middle">
                {v.name.length > 16 ? v.name.slice(0, 15) + "…" : v.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
const SystemMap = React.memo(SystemMapImpl);

/* ----------------------- trajectory chart (SVG) -------------------------- */
type Run = { option: DecisionOption; color: string; traj: TrajPoint[] };
function TrajectoryChartImpl({
  runs, horizon, focusId, best, mcBands,
}: {
  runs: Run[];
  horizon: number;
  focusId: string | null;
  best?: Run & { score: number };
  mcBands?: Record<string, MCBand[]>;
}) {
  const W = 620, H = 320, pl = 36, pr = 14, pt = 14, pb = 26;
  const ix = (t: number) => pl + (t * (W - pl - pr)) / Math.max(horizon, 1);
  const iy = (v: number) => pt + ((100 - v) * (H - pt - pb)) / 100;
  const grid = [0, 25, 50, 75, 100];
  const bandRun = runs.find((r) => r.option.id === focusId) || (best && runs.find((r) => r.option.id === best.option.id));

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverStep, setHoverStep] = useState<number | null>(null);

  function handleMove(e: { clientX: number }) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xSvg = ((e.clientX - rect.left) / rect.width) * W;
    const t = Math.round(((xSvg - pl) / (W - pl - pr)) * Math.max(horizon, 1));
    const clamped = Math.max(0, Math.min(horizon, t));
    setHoverStep(clamped);
  }
  function handleLeave() { setHoverStep(null); }

  const tipW = 150;
  const tipLineH = 14;
  const tipPad = 8;
  const tipH = hoverStep != null ? tipPad * 2 + tipLineH * (runs.length + 1) : 0;
  let tipX = 0, tipY = pt + 4;
  if (hoverStep != null) {
    const hx = ix(hoverStep);
    tipX = hx + 10;
    if (tipX + tipW > W - pr) tipX = hx - 10 - tipW;
  }

  return (
    <div className="mt-3 rounded-xl" style={{ background: SVG.inset, border: "1px solid " + SVG.border }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Option trajectories"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onTouchStart={(e) => { if (e.touches[0]) handleMove(e.touches[0]); }}
        onTouchMove={(e) => { if (e.touches[0]) handleMove(e.touches[0]); }}
        onTouchEnd={handleLeave}
        style={{ touchAction: "none" }}
      >
        {grid.map((g) => (
          <g key={g}>
            <line x1={pl} y1={iy(g)} x2={W - pr} y2={iy(g)} stroke={SVG.border} strokeWidth="1" />
            <text x={pl - 7} y={iy(g) + 4} fill={SVG.dim} fontSize="10" textAnchor="end">{g}</text>
          </g>
        ))}
        {[0, Math.round(horizon / 2), horizon].map((m) => (
          <text key={m} x={ix(m)} y={H - 8} fill={SVG.dim} fontSize="10" textAnchor="middle">{m}</text>
        ))}
        {bandRun && mcBands && mcBands[bandRun.option.id] && (() => {
          const band = mcBands[bandRun.option.id];
          let top = "", bot = "";
          band.forEach((b, i) => {
            top += `${ix(i)},${iy(b.p90)} `;
            bot = `${ix(i)},${iy(b.p10)} ` + bot;
          });
          return <polygon points={top + bot} fill={bandRun.color + "33"} />;
        })()}
        {runs.map((r) => {
          const focused = !focusId || r.option.id === focusId;
          const d = r.traj.map((p, i) => `${i ? "L" : "M"}${ix(i)},${iy(p.idx)}`).join(" ");
          return (
            <path key={r.option.id} d={d} fill="none" stroke={r.color}
              strokeWidth={focused ? 3.2 : 1.6} opacity={focused ? 1 : 0.35} />
          );
        })}
        {runs.map((r) => (
          <circle key={r.option.id} cx={ix(horizon)} cy={iy(r.traj[r.traj.length - 1].idx)} r="4"
            fill={r.color} stroke={SVG.bgDeep} strokeWidth="2" />
        ))}

        {/* Hover guide + markers + tooltip */}
        {hoverStep != null && (
          <g pointerEvents="none">
            <line
              x1={ix(hoverStep)} y1={pt} x2={ix(hoverStep)} y2={H - pb}
              stroke={SVG.ink2} strokeWidth="1" strokeDasharray="3 3" opacity="0.6"
            />
            {runs.map((r) => {
              const p = r.traj[hoverStep];
              if (!p) return null;
              return (
                <circle key={r.option.id} cx={ix(hoverStep)} cy={iy(p.idx)} r="3.5"
                  fill={r.color} stroke={SVG.bgDeep} strokeWidth="2" />
              );
            })}
            <g transform={`translate(${tipX},${tipY})`}>
              <rect width={tipW} height={tipH} rx="6" ry="6"
                fill={SVG.bgDeep} stroke={SVG.border2} strokeWidth="1" opacity="0.96" />
              <text x={tipPad} y={tipPad + 10} fill={SVG.ink} fontSize="11" fontWeight="600">
                Step {hoverStep}
              </text>
              {runs.map((r, i) => {
                const p = r.traj[hoverStep];
                const val = p ? p.idx.toFixed(1) : "—";
                const y = tipPad + 10 + tipLineH * (i + 1);
                return (
                  <g key={r.option.id}>
                    <rect x={tipPad} y={y - 8} width="8" height="8" rx="2" fill={r.color} />
                    <text x={tipPad + 13} y={y} fill={SVG.ink2} fontSize="11">
                      {r.option.name.length > 16 ? r.option.name.slice(0, 15) + "…" : r.option.name}
                    </text>
                    <text x={tipW - tipPad} y={y} fill={SVG.ink} fontSize="11" textAnchor="end" fontWeight="600">
                      {val}
                    </text>
                  </g>
                );
              })}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
const TrajectoryChart = React.memo(TrajectoryChartImpl);

/* ----------------------------- onboarding parts ------------------------- */

function HelpPopover({ title, body }: { title: string; body: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={"What is " + title + "?"}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 text-xs">
        <div className="font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-muted-foreground">{body}</p>
      </PopoverContent>
    </Popover>
  );
}

function WelcomeDialog({
  open, dontShow, setDontShow, onClose, onDocs, onDescribe, onTemplate, onTour,
}: {
  open: boolean;
  dontShow: boolean;
  setDontShow: (v: boolean) => void;
  onClose: () => void;
  onDocs: () => void;
  onDescribe: () => void;
  onTemplate: () => void;
  onTour: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Compass size={18} className="text-primary" />
            Welcome to Decision Lens
          </DialogTitle>
          <DialogDescription>
            Turn a messy decision into a clear, operational plan. Upload your documents or describe the decision, AI maps the forces and options, Monte-Carlo simulates each one — and you walk away with a sequenced action plan for the winning strategy.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">How it works</div>
          <ol className="mt-2 grid gap-1 text-sm text-foreground">
            <li><b className="text-primary">1. Add your material</b> — drop PDFs or paste links (or just describe it).</li>
            <li><b className="text-primary">2. AI maps the landscape</b> — variables, feedback loops, options, and concrete actions.</li>
            <li><b className="text-primary">3. Tune & critique</b> — adjust anything; ask AI to critique what's missing.</li>
            <li><b className="text-primary">4. Decide with Monte-Carlo</b> — 300 simulated rollouts give each option a win-probability.</li>
            <li><b className="text-primary">5. Get an action plan</b> — sequenced Now / Soon / Ongoing steps you can export as Markdown.</li>
          </ol>
        </div>


        <div className="grid gap-2">
          <Button onClick={onDocs} size="lg" className="justify-start gap-2">
            <FileText size={16} /> Map a decision from my documents
          </Button>
          <Button onClick={onDescribe} variant="outline" className="justify-start gap-2">
            <Sparkles size={15} /> Describe my decision
          </Button>
          <Button onClick={onTemplate} variant="outline" className="justify-start gap-2">
            <GitBranch size={15} /> Start from a template
          </Button>
          <Button onClick={onTour} variant="ghost" className="justify-start gap-2 text-muted-foreground">
            <MousePointerClick size={15} /> Take the 60-second tour
          </Button>
        </div>


        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Don't show again
          </label>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TOUR_COPY = [
  "Start here: drop PDFs or paste links, then click Map my decision — AI reads them and drafts variables, options, and a first cut of actions.",
  "Prefer to type? Describe the decision in your own words and let AI draft the model from scratch.",
  "Review the variables and feedback loops. Click 'Critique my model' to have AI flag missing forces or biased framings.",
  "Shape each option as pushes on the system — then hit ✨ Suggest actions to turn it into concrete, driver-linked steps.",
  "Decide tab: Monte-Carlo runs 300 rollouts to give each option a win-probability, explains why the leader wins, and hands you a Now / Soon / Ongoing action plan you can export.",
];



function TourCoachmark({
  step, anchors, onNext, onSkip,
}: {
  step: number | null;
  anchors: Array<HTMLElement | null>;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (step == null) { setRect(null); return; }
    const el = anchors[step];
    if (!el) return;
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step, anchors]);

  if (step == null || !rect) return null;
  const top = rect.bottom + 10;
  const left = Math.max(12, Math.min(window.innerWidth - 312, rect.left));
  const isLast = step >= TOUR_COPY.length - 1;

  return (
    <div className="fixed inset-0 z-50" aria-live="polite">
      <div className="absolute inset-0 bg-background/40 backdrop-blur-[1px]" onClick={onSkip} />
      <div
        className="absolute rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background pointer-events-none"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      <div
        role="dialog"
        aria-label="Decision Lens tour"
        className="absolute w-[300px] rounded-lg border border-border bg-card p-4 shadow-lg"
        style={{ top, left }}
      >
        <div className="text-xs font-semibold uppercase tracking-wider text-primary">
          Step {step + 1} of {TOUR_COPY.length}
        </div>
        <p className="mt-1 text-sm text-foreground">{TOUR_COPY[step]}</p>
        <div className="mt-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">Skip</Button>
          <Button size="sm" onClick={onNext} className="gap-2">
            {isLast ? "Finish" : "Next"}
            {!isLast && <ArrowRight size={14} />}
          </Button>
        </div>
      </div>
    </div>
  );
}
