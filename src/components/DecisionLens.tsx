import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import {
  Plus, X, Sparkles, ArrowRight, ArrowLeft, Trash2, Share2, Loader2,
  Target, Network, GitBranch, Telescope, RotateCcw,
  HelpCircle, Upload, FileText, Compass, MousePointerClick,
} from "lucide-react";

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
type Variable = { id: string; name: string; value: number; weight: number };
type Influence = { from: string; to: string; strength: number };
type DecisionOption = { id: string; name: string; pushes: Record<string, number> };
type Model = {
  outcomeName: string;
  horizon: number;
  variables: Variable[];
  influences: Influence[];
  options: DecisionOption[];
};

/* --------------------------- URL hash codec ----------------------------- */
function encodeModel(m: Model): string {
  // Compact JSON; URL-safe via encodeURIComponent. Correctness over cleverness.
  const compact = {
    o: m.outcomeName,
    h: m.horizon,
    v: m.variables.map((v) => ({ i: v.id, n: v.name, v: v.value, w: v.weight })),
    e: m.influences.map((i) => ({ f: i.from, t: i.to, s: i.strength })),
    p: m.options.map((o) => ({ i: o.id, n: o.name, p: o.pushes })),
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
      return { id: String(o.i), name: String(o.n ?? ""), pushes };
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
function simulateMonteCarlo(
  vars: Variable[],
  influences: Influence[],
  pushes: Record<string, number> | undefined,
  horizon: number,
  runs = 300
): MCBand[] {
  const samples: number[][] = Array.from({ length: horizon + 1 }, () => []);
  const SIG = 0.15;
  for (let r = 0; r < runs; r++) {
    const infNoise = influences.map(() => 1 + SIG * gaussSample());
    const pushNoise: Record<string, number> = {};
    if (pushes) for (const k of Object.keys(pushes)) pushNoise[k] = 1 + SIG * gaussSample();

    const cur: Record<string, number> = {};
    vars.forEach((v) => (cur[v.id] = v.value));
    const base = { ...cur };
    samples[0].push(outcomeOf(vars, cur));
    for (let t = 1; t <= horizon; t++) {
      const next: Record<string, number> = {};
      vars.forEach((v) => {
        let e = 0;
        influences.forEach((i, ii) => {
          if (i.to !== v.id) return;
          const s = i.strength * infNoise[ii];
          e += (s / 100) * ((cur[i.from] - 50) / 50) * 6;
        });
        const rawPush = (pushes && pushes[v.id]) || 0;
        const push = (rawPush * (pushNoise[v.id] ?? 1)) / 100 * 4;
        const decay = 0.08 * (cur[v.id] - base[v.id]);
        next[v.id] = clamp(cur[v.id] + push + e - decay);
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
  const SIG = 0.15;
  const wins: Record<string, number> = {};
  options.forEach((o) => (wins[o.id] = 0));
  for (let r = 0; r < runs; r++) {
    const infNoise = influences.map(() => 1 + SIG * gaussSample());
    const optPushNoise = options.map((o) => {
      const m: Record<string, number> = {};
      if (o.pushes) for (const k of Object.keys(o.pushes)) m[k] = 1 + SIG * gaussSample();
      return m;
    });
    let bestIdx = 0, bestVal = -Infinity;
    options.forEach((o, oi) => {
      const cur: Record<string, number> = {};
      vars.forEach((v) => (cur[v.id] = v.value));
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
          const push = (rawPush * (optPushNoise[oi][v.id] ?? 1)) / 100 * 4;
          const decay = 0.08 * (cur[v.id] - base[v.id]);
          next[v.id] = clamp(cur[v.id] + push + e - decay);
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
      { id: uid(), name: "Enter now", pushes: { demand: 30, moat: 20, runway: -40, focus: -30, risk: 40 } },
      { id: uid(), name: "Wait & build", pushes: { demand: -5, moat: 35, runway: 10, focus: 25, risk: -20 } },
      { id: uid(), name: "Partner in", pushes: { demand: 20, moat: 40, runway: -10, focus: 10, risk: -10 } },
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
      { id: uid(), name: "Stay & shape role", pushes: { growth: 15, income: 5, meaning: 20, network: 10, stress: -15 } },
      { id: uid(), name: "Switch company", pushes: { growth: 35, income: 10, meaning: 15, network: 30, stress: 15 } },
      { id: uid(), name: "Go independent", pushes: { growth: 40, income: -35, meaning: 35, network: 20, stress: 35 } },
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
      { id: uid(), name: "Co-create", pushes: { trust: 25, momentum: 15, coalition: 40, capability: 25, threat: -35 } },
      { id: uid(), name: "Mandate & push", pushes: { trust: -25, momentum: 35, coalition: -15, capability: 5, threat: 45 } },
      { id: uid(), name: "Quick wins first", pushes: { trust: 15, momentum: 45, coalition: 20, capability: 25, threat: -5 } },
    ],
  },
];

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
      { id: uid(), name: "Option 1", pushes: {} },
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
    options: tpl.options.map((o) => ({ id: uid(), name: o.name, pushes: { ...o.pushes } })),
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
      return {
        id,
        name: String(v?.name ?? id),
        value: clampN(v?.value, 0, 100),
        weight: clampN(v?.weight, -100, 100),
      };
    })
    .filter(Boolean) as Variable[];
  if (variables.length === 0) return null;
  const ids = new Set(variables.map((v) => v.id));

  const influences: Influence[] = (Array.isArray(raw.influences) ? raw.influences : [])
    .map((i: any) => ({
      from: String(i?.from ?? ""),
      to: String(i?.to ?? ""),
      strength: clampN(i?.strength, -100, 100),
    }))
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
      return { id: uid(), name: String(o?.name ?? "Option"), pushes };
    });
  if (options.length === 0) return null;

  return {
    outcomeName: String(raw.outcomeName ?? "Outcome"),
    horizon: Math.round(clampN(raw.horizon, 4, 36)),
    variables,
    influences,
    options,
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

  // Onboarding state
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const decisionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
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
    requestAnimationFrame(() => uploadInputRef.current?.click());
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
    setTourStep(0);
    setStage(STAGES[0].id);
  }

  async function handleUpload(file: File | null) {
    if (!file) return;
    try {
      const text = await file.text();
      const trimmed = text.trim().slice(0, 4000);
      if (trimmed) {
        setDecision(trimmed);
        toast.success("Document loaded", { description: "Decision Lens · ready to auto-draft." });
        decisionTextareaRef.current?.focus();
      }
    } catch {
      toast.error("Couldn't read file", { description: "Decision Lens · try a .txt or .md file." });
    }
  }


  async function runAutoDraft(text: string) {
    setDrafting(true);
    try {
      const m = await autoDraftModel(text);
      loadModel(m);
      setStage("model");
      toast.success("Model drafted", { description: "Decision Lens · AI-built your starting system." });
    } catch {
      loadModel(keywordTemplate(text));
      setStage("model");
      toast.error("Couldn't reach the AI", { description: "Decision Lens · loaded a template instead." });
    } finally {
      setDrafting(false);
    }
  }

  function loadModel(m: Model) {
    setOutcomeName(m.outcomeName);
    setHorizon(m.horizon);
    setVariables(m.variables);
    setInfluences(m.influences);
    setOptions(m.options);
    setFocusOpt(null);
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
              Model the system. Roll the options forward. Then choose.
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Any decision is a small system: a few latent variables, the feedback loops between them, and the
              options you're weighing. Build it once, then compare trajectories instead of arguing about vibes.
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

                <div className="mt-3 flex items-center gap-2">
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    className="hidden"
                    onChange={(e) => { void handleUpload(e.target.files?.[0] ?? null); e.target.value = ""; }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => uploadInputRef.current?.click()}
                    className="gap-2"
                  >
                    <Upload size={14} /> Upload a document
                  </Button>
                  <span className="text-xs text-dim">.txt or .md — we'll use its text as the decision brief.</span>
                </div>

                <div className="mt-4 dl-2">
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

                <Button
                  onClick={() => { void runAutoDraft(decision); }}
                  disabled={drafting}
                  className="mt-5 gap-2"
                >
                  {drafting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  {drafting ? "Drafting…" : "Auto-draft the model"}
                </Button>
                <p className="mt-2 text-xs text-dim">
                  Lovable AI builds a starter system from your decision text. Falls back to a template if the AI is unreachable.
                </p>
              </Panel>

              <div ref={templatesPanelRef}>
                <Panel>
                  <SectionTag icon={GitBranch} text="Or start from a template" />
                  <div className="mt-3 grid gap-2">
                    {TEMPLATES.map((tpl) => (
                      <Button
                        key={tpl.label}
                        variant="secondary"
                        disabled={drafting}
                        onClick={() => { setDecision(tpl.decision); void runAutoDraft(tpl.key[0]); }}
                        className="h-auto justify-between bg-muted px-4 py-3 text-left text-sm font-normal"
                      >
                        <span>{tpl.label}</span>
                        <ArrowRight size={15} className="text-primary" />
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() => { loadModel(blankStarter()); setStage("model"); }}
                      className="h-auto justify-between border-dashed bg-transparent px-4 py-3 text-left text-sm font-normal text-muted-foreground"
                    >
                      <span>Start blank</span>
                      <Plus size={15} />
                    </Button>
                  </div>
                </Panel>
              </div>

            </div>
          </TabsContent>

          {/* ---------------------------- MODEL ---------------------------- */}
          <TabsContent value="model" className="mt-0">
            <div className="dl-model">
              <Panel>
                <div className="flex items-center justify-between">
                  <SectionTag icon={Network} text="State variables" />
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
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <SectionTag icon={GitBranch} text="Influences (the loops)" />
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
                    <p className="text-xs text-dim">
                      No links yet. Add how one variable pushes another — that's what creates feedback loops.
                    </p>
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
                </Panel>

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
                      <b className="text-foreground">Cheapest probe:</b> measure whichever upstream variable feeds
                      the most arrows before committing.
                    </li>
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
    </div>
  );
}

/* ----------------------------- small parts ------------------------------- */
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
  label, val, min, max, tone, onChange,
}: {
  label: string;
  val: number;
  min: number;
  max: number;
  tone: Tone;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
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
