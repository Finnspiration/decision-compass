import React, { useState, useMemo } from "react";
import {
  Plus, X, Sparkles, ArrowRight, ArrowLeft, Trash2,
  Target, Network, GitBranch, Telescope, RotateCcw,
} from "lucide-react";

/* ============================================================================
   DECISION LENS — a generally-applicable, decision-focused world model.

   The world-model lens, made into a tool:
     · STATE      latent variables that actually drive the decision's outcome
     · DYNAMICS   influence edges between variables = the feedback loops
     · ACTIONS    the options you're choosing between (each pushes the state)
     · ROLLOUT    simulate each option forward; compare trajectories, not vibes
     · DISCIPLINE name model error and what you'd watch to update

   The engine below is fully domain-agnostic. Org change, a market-entry call,
   a career move, a treatment plan — all are just {variables, influences,
   options}. Nothing here is hardcoded to a domain.

   >>> LOVABLE / AI SEAM <<<
   `autoDraftModel(decisionText)` is where a real LLM call goes. In this
   prototype it keyword-matches to a starter template. In Lovable, replace its
   body with a call that returns the same {outcomeName, horizon, variables,
   influences, options} shape, and the whole UI lights up generatively.
============================================================================ */

/* --------------------------------------------------------------------------
   THEME — "Midnight Signal" (custom, via theme-factory)
   Single source of truth for the shell. Ports to Lovable as index.css
   :root vars + tailwind.config tokens (see the handoff doc for the mapping).
   NOTE: OPT_COLORS and the per-variable green/red are *semantic* — they encode
   meaning (which option / helps vs. hurts), so they are theme-independent.
-------------------------------------------------------------------------- */
const T = {
  bgDeep: "#0f1117",
  bgGlow: "#1a2030",
  surface1: "#161a23",
  surface2: "#1d222e",
  inset: "#11141c",
  border: "#2a3140",
  border2: "#3a455c",
  ink: "#e9ecf3",
  ink2: "#cdd5e4",
  muted: "#9aa3b5",
  dim: "#6c7689",
  primary: "#6ea8fe",
  good: "#7ee787",
  bad: "#ff6b81",
};
const FONT_BODY = "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
const FONT_DISPLAY = "Georgia,serif";

/* ----------------------------- engine ----------------------------------- */
const clamp = (x) => Math.max(0, Math.min(100, x));
const uid = () => Math.random().toString(36).slice(2, 9);

function outcomeOf(vars, vals) {
  let num = 0, den = 0;
  vars.forEach((v) => {
    const w = v.weight / 100;
    den += Math.abs(w);
    num += w >= 0 ? w * vals[v.id] : Math.abs(w) * (100 - vals[v.id]);
  });
  return den ? clamp(num / den) : 50;
}

// transition function: next = f(state, influences, option-push)
function simulate(vars, influences, pushes, horizon) {
  const cur = {};
  vars.forEach((v) => (cur[v.id] = v.value));
  const base = { ...cur };
  const traj = [{ t: 0, vals: { ...cur }, idx: outcomeOf(vars, cur) }];
  for (let t = 1; t <= horizon; t++) {
    const next = {};
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

function blankStarter() {
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

// >>> Replace this body with an LLM call in Lovable. <<<
function autoDraftModel(decisionText) {
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

/* ------------------------------- palette --------------------------------- */
// Semantic option colors (theme-independent — they identify each option).
const OPT_COLORS = ["#6ea8fe", "#7ee787", "#ffb454", "#ff6b81", "#9d7bff"];
const STAGES = [
  { id: "frame", label: "Frame", icon: Target },
  { id: "model", label: "Model", icon: Network },
  { id: "options", label: "Options", icon: GitBranch },
  { id: "decide", label: "Decide", icon: Telescope },
];

// Responsive grid + control theming, driven by the theme tokens above.
const DL_CSS = `
.dl-root{
  --dl-border:${T.border}; --dl-primary:${T.primary};
}
.dl-frame,.dl-model,.dl-decide,.dl-2{display:grid;gap:20px;grid-template-columns:1fr}
.dl-2{gap:14px}
@media(min-width:560px){.dl-2{grid-template-columns:1fr 1fr}}
@media(min-width:880px){
  .dl-frame{grid-template-columns:1.1fr 0.9fr}
  .dl-model{grid-template-columns:0.95fr 1.05fr}
  .dl-decide{grid-template-columns:1.2fr 0.8fr}
}
.dl-root input[type=range]{-webkit-appearance:none;appearance:none;height:6px;border-radius:6px;background:var(--dl-border);outline:none}
.dl-root input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--dl-primary);border:none;cursor:pointer;box-shadow:0 0 0 4px rgba(110,168,254,.16)}
.dl-root input[type=range]::-moz-range-thumb{width:15px;height:15px;border:none;border-radius:50%;background:var(--dl-primary);cursor:pointer}
.dl-root button:focus-visible,.dl-root input:focus-visible,.dl-root textarea:focus-visible,.dl-root select:focus-visible{outline:2px solid var(--dl-primary);outline-offset:2px}
`;

/* =============================== component ================================ */
export default function DecisionLens() {
  const [stage, setStage] = useState("frame");
  const [decision, setDecision] = useState(
    "Should we enter the new market now, wait and build, or partner in?"
  );
  const seed = useMemo(() => autoDraftModel(decision), []); // initial demo model
  const [outcomeName, setOutcomeName] = useState(seed.outcomeName);
  const [horizon, setHorizon] = useState(seed.horizon);
  const [variables, setVariables] = useState(seed.variables);
  const [influences, setInfluences] = useState(seed.influences);
  const [options, setOptions] = useState(seed.options);
  const [focusOpt, setFocusOpt] = useState(null);

  function loadModel(m) {
    setOutcomeName(m.outcomeName);
    setHorizon(m.horizon);
    setVariables(m.variables);
    setInfluences(m.influences);
    setOptions(m.options);
    setFocusOpt(null);
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
  const ranked = useMemo(
    () =>
      [...runs]
        .map((r) => ({ ...r, score: r.traj[r.traj.length - 1].idx }))
        .sort((a, b) => b.score - a.score),
    [runs]
  );
  const best = ranked[0];

  /* --------------------------- shared UI bits --------------------------- */



  /* ============================== render =============================== */
  return (
    <div
      className="dl-root min-h-screen w-full"
      style={{
        background: `radial-gradient(1200px 700px at 70% -10%,${T.bgGlow} 0,${T.bgDeep} 60%)`,
        color: T.ink,
        fontFamily: FONT_BODY,
      }}
    >
      <style>{DL_CSS}</style>
      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* header */}
        <div className="mb-5">
          <div className="text-xs font-semibold" style={{ color: T.primary, letterSpacing: "0.18em" }}>
            DECISION LENS · WORLD-MODEL THINKING
          </div>
          <h1 className="mt-1 text-3xl font-semibold" style={{ fontFamily: FONT_DISPLAY, letterSpacing: "-0.01em" }}>
            Model the system. Roll the options forward. Then choose.
          </h1>
          <p className="mt-1 text-sm" style={{ color: T.muted, maxWidth: 720 }}>
            Any decision is a small system: a few latent variables, the feedback loops between them, and the
            options you're weighing. Build it once, then compare trajectories instead of arguing about vibes.
          </p>
        </div>

        <div className="mb-6">
          <Stepper />
        </div>

        {/* ---------------------------- FRAME ---------------------------- */}
        {stage === "frame" && (
          <div className="dl-frame">
            <Panel>
              <SectionTag icon={Target} text="The decision" />
              <label className="mt-3 block text-sm" style={{ color: T.muted }}>
                What decision are you facing?
              </label>
              <textarea
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
                rows={3}
                className="mt-2 w-full rounded-xl p-3 text-sm"
                style={{ background: T.inset, border: "1px solid " + T.border, color: T.ink, resize: "vertical" }}
              />
              <div className="mt-4 dl-2">
                <div>
                  <label className="block text-sm" style={{ color: T.muted }}>
                    What does success mean? (outcome label)
                  </label>
                  <input
                    value={outcomeName}
                    onChange={(e) => setOutcomeName(e.target.value)}
                    className="mt-2 w-full rounded-xl p-2.5 text-sm"
                    style={{ background: T.inset, border: "1px solid " + T.border, color: T.ink }}
                  />
                </div>
                <div>
                  <label className="block text-sm" style={{ color: T.muted }}>
                    Horizon: <span style={{ color: T.primary }}>{horizon} steps</span>
                  </label>
                  <input
                    type="range" min={4} max={36} value={horizon}
                    onChange={(e) => setHorizon(+e.target.value)}
                    className="mt-3 w-full"
                  />
                </div>
              </div>

              <button
                onClick={() => { loadModel(autoDraftModel(decision)); setStage("model"); }}
                className="mt-5 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
                style={{ background: T.primary, color: T.bgDeep }}
              >
                <Sparkles size={16} /> Auto-draft the model
              </button>
              <p className="mt-2 text-xs" style={{ color: T.dim }}>
                Prototype: matches a starter template. In Lovable, wire this button to an LLM that returns the
                model from your decision text.
              </p>
            </Panel>

            <Panel>
              <SectionTag icon={GitBranch} text="Or start from a template" />
              <div className="mt-3 grid gap-2">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    onClick={() => { setDecision(tpl.decision); loadModel(autoDraftModel(tpl.key[0])); setStage("model"); }}
                    className="flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm"
                    style={{ background: T.inset, border: "1px solid " + T.border }}
                  >
                    <span>{tpl.label}</span>
                    <ArrowRight size={15} style={{ color: T.primary }} />
                  </button>
                ))}
                <button
                  onClick={() => { loadModel(blankStarter()); setStage("model"); }}
                  className="flex items-center justify-between rounded-xl px-4 py-3 text-left text-sm"
                  style={{ background: "transparent", border: "1px dashed " + T.border2, color: T.muted }}
                >
                  <span>Start blank</span>
                  <Plus size={15} />
                </button>
              </div>
            </Panel>
          </div>
        )}

        {/* ---------------------------- MODEL ---------------------------- */}
        {stage === "model" && (
          <div className="dl-model">
            <Panel>
              <div className="flex items-center justify-between">
                <SectionTag icon={Network} text="State variables" />
                <button
                  onClick={() =>
                    setVariables([...variables, { id: uid(), name: "New driver", value: 50, weight: 40 }])
                  }
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                  style={{ background: T.surface2, border: "1px solid " + T.border, color: T.ink }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
              <p className="mt-2 text-xs" style={{ color: T.muted }}>
                The few things that actually drive {outcomeName.toLowerCase()}. Set where each stands today and
                whether it helps or hurts.
              </p>
              <div className="mt-3 grid gap-3">
                {variables.map((v) => (
                  <div key={v.id} className="rounded-xl p-3" style={{ background: T.inset, border: "1px solid " + T.border }}>
                    <div className="flex items-center gap-2">
                      <input
                        value={v.name}
                        onChange={(e) => upd(setVariables, variables, v.id, { name: e.target.value })}
                        className="flex-1 rounded-md px-2 py-1 text-sm font-medium"
                        style={{ background: "transparent", border: "1px solid " + T.border, color: T.ink }}
                      />
                      <button onClick={() => removeVar(v.id)} aria-label={"Remove " + v.name} style={{ color: T.dim }}>
                        <X size={15} />
                      </button>
                    </div>
                    <div className="mt-2 dl-2">
                      <SliderRow
                        label="Today" val={v.value} min={0} max={100} color={T.primary}
                        onChange={(x) => upd(setVariables, variables, v.id, { value: x })}
                      />
                      <SliderRow
                        label={v.weight >= 0 ? "Helps outcome" : "Hurts outcome"}
                        val={v.weight} min={-100} max={100}
                        color={v.weight >= 0 ? T.good : T.bad}
                        onChange={(x) => upd(setVariables, variables, v.id, { weight: x })}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex items-center justify-between">
                <SectionTag icon={GitBranch} text="Influences (the loops)" />
                <button
                  onClick={addInfluence}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                  style={{ background: T.surface2, border: "1px solid " + T.border, color: T.ink }}
                >
                  <Plus size={13} /> Add
                </button>
              </div>
              <div className="mt-3 grid gap-2">
                {influences.length === 0 && (
                  <p className="text-xs" style={{ color: T.dim }}>
                    No links yet. Add how one variable pushes another — that's what creates feedback loops.
                  </p>
                )}
                {influences.map((inf, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-xl p-2" style={{ background: T.inset, border: "1px solid " + T.border }}>
                    <VarSelect value={inf.from} vars={variables} onChange={(val) => updInf(idx, { from: val })} />
                    <ArrowRight size={14} style={{ color: inf.strength >= 0 ? T.good : T.bad }} />
                    <VarSelect value={inf.to} vars={variables} onChange={(val) => updInf(idx, { to: val })} />
                    <input
                      type="range" min={-100} max={100} value={inf.strength}
                      onChange={(e) => updInf(idx, { strength: +e.target.value })}
                      className="flex-1" style={{ minWidth: 60 }}
                      aria-label="Influence strength"
                    />
                    <button onClick={() => setInfluences(influences.filter((_, i) => i !== idx))} aria-label="Remove influence" style={{ color: T.dim }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </Panel>

            {/* live system map — transforms as you add variables & links */}
            <Panel>
              <SectionTag icon={Network} text="System map" />
              <p className="mt-2 text-xs" style={{ color: T.muted }}>
                Your model, live. Nodes are state variables (green helps, red hurts); arrows are influences.
              </p>
              <SystemMap variables={variables} influences={influences} />
              <div className="mt-3 flex justify-end">
                <NavBtn dir="next" onClick={() => setStage("options")}>Define options</NavBtn>
              </div>
            </Panel>
          </div>
        )}

        {/* ---------------------------- OPTIONS ---------------------------- */}
        {stage === "options" && (
          <div className="grid gap-5">
            <Panel>
              <div className="flex items-center justify-between">
                <SectionTag icon={GitBranch} text="The options you're choosing between" />
                <button
                  onClick={() =>
                    setOptions([...options, { id: uid(), name: "Option " + (options.length + 1), pushes: {} }])
                  }
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium"
                  style={{ background: T.surface2, border: "1px solid " + T.border, color: T.ink }}
                >
                  <Plus size={13} /> Add option
                </button>
              </div>
              <p className="mt-2 text-xs" style={{ color: T.muted }}>
                Each option is an action that pushes the state every step. Drag a variable up if the option lifts
                it, down if it drags it.
              </p>

              <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
                {options.map((o, i) => (
                  <div key={o.id} className="rounded-xl p-3" style={{ background: T.inset, border: "1px solid " + OPT_COLORS[i % OPT_COLORS.length] + "66" }}>
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: OPT_COLORS[i % OPT_COLORS.length] }} />
                      <input
                        value={o.name}
                        onChange={(e) => upd(setOptions, options, o.id, { name: e.target.value })}
                        className="flex-1 rounded-md px-2 py-1 text-sm font-medium"
                        style={{ background: "transparent", border: "1px solid " + T.border, color: T.ink }}
                      />
                      {options.length > 1 && (
                        <button onClick={() => setOptions(options.filter((x) => x.id !== o.id))} aria-label={"Remove " + o.name} style={{ color: T.dim }}>
                          <X size={15} />
                        </button>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2">
                      {variables.map((v) => (
                        <div key={v.id} className="flex items-center gap-2">
                          <span className="text-xs" style={{ color: T.muted, width: 92 }}>{v.name}</span>
                          <input
                            type="range" min={-60} max={60} value={o.pushes[v.id] || 0}
                            onChange={(e) =>
                              upd(setOptions, options, o.id, { pushes: { ...o.pushes, [v.id]: +e.target.value } })
                            }
                            className="flex-1"
                            aria-label={o.name + " effect on " + v.name}
                          />
                          <span className="text-xs" style={{ color: T.dim, width: 26, textAlign: "right" }}>
                            {o.pushes[v.id] > 0 ? "+" : ""}{o.pushes[v.id] || 0}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-between">
                <NavBtn dir="back" onClick={() => setStage("model")}>Back to model</NavBtn>
                <NavBtn dir="next" onClick={() => setStage("decide")}>Roll forward &amp; decide</NavBtn>
              </div>
            </Panel>
          </div>
        )}

        {/* ---------------------------- DECIDE ---------------------------- */}
        {stage === "decide" && (
          <div className="dl-decide">
            <Panel>
              <SectionTag icon={Telescope} text={"Rollout · " + outcomeName} />
              <p className="mt-2 text-xs" style={{ color: T.muted }}>
                Each line is one option's {outcomeName.toLowerCase()} over {horizon} steps. The shaded band on the
                leading option is model error — it widens with the horizon, so trust the near term.
              </p>
              <TrajectoryChart runs={runs} horizon={horizon} focusId={focusOpt} best={best} />
              <div className="mt-3 flex flex-wrap gap-3 text-xs" style={{ color: T.muted }}>
                {runs.map((r) => (
                  <span key={r.option.id} className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: r.color }} />
                    {r.option.name}
                  </span>
                ))}
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
                      className="flex items-center gap-3 rounded-xl p-3 text-left"
                      style={{
                        background: i === 0 ? "rgba(126,231,135,0.08)" : T.inset,
                        border: "1px solid " + (i === 0 ? "#7ee78766" : T.border),
                      }}
                    >
                      <span className="text-sm font-semibold" style={{ color: T.dim, width: 18 }}>{i + 1}</span>
                      <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: r.color }} />
                      <span className="flex-1 text-sm">{r.option.name}</span>
                      <span className="text-lg font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
                        {Math.round(r.score)}
                      </span>
                      {i === 0 && <span className="text-xs font-semibold" style={{ color: T.good }}>best</span>}
                    </button>
                  ))}
                </div>
              </Panel>

              <Panel>
                <SectionTag icon={Telescope} text="Respect the model error" />
                <ul className="mt-3 grid gap-2 text-xs" style={{ color: T.muted, listStyle: "none", padding: 0 }}>
                  <li><b style={{ color: T.ink }}>Load-bearing:</b> the gap between #1 and #2 is {Math.round(best.score - (ranked[1]?.score ?? best.score))} pts. If that's thin, this is a near-tie — don't over-trust the ranking.</li>
                  <li><b style={{ color: T.ink }}>Decays with horizon:</b> reliability falls off after a few steps. Re-run as reality comes in.</li>
                  <li><b style={{ color: T.ink }}>Cheapest probe:</b> measure whichever upstream variable feeds the most arrows before committing.</li>
                </ul>
                <button
                  onClick={() => setStage("model")}
                  className="mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
                  style={{ background: T.surface2, border: "1px solid " + T.border, color: T.ink }}
                >
                  <RotateCcw size={13} /> Adjust the model
                </button>
              </Panel>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* ---------------------------- mutators ------------------------------- */
  function upd(setter, list, id, patch) {
    setter(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function removeVar(id) {
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
  function updInf(idx, patch) {
    setInfluences(influences.map((i, k) => (k === idx ? { ...i, ...patch } : i)));
  }
}

/* ----------------------------- small parts ------------------------------- */
function SectionTag({ icon: Icon, text }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase" style={{ color: T.muted, letterSpacing: "0.12em" }}>
      <Icon size={14} style={{ color: T.primary }} /> {text}
    </div>
  );
}

function SliderRow({ label, val, min, max, color, onChange }) {
  return (
    <div>
      <div className="flex justify-between text-xs" style={{ color: T.muted }}>
        <span>{label}</span>
        <span style={{ color }}>{val}</span>
      </div>
      <input type="range" min={min} max={max} value={val} onChange={(e) => onChange(+e.target.value)}
        className="mt-1 w-full" aria-label={label} />
    </div>
  );
}

function VarSelect({ value, vars, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md px-2 py-1 text-xs"
      style={{ background: T.surface2, border: "1px solid " + T.border, color: T.ink, maxWidth: 110 }}
      aria-label="Variable"
    >
      {vars.map((v) => (
        <option key={v.id} value={v.id}>{v.name}</option>
      ))}
    </select>
  );
}

function NavBtn({ dir, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
      style={{ background: dir === "next" ? T.primary : T.surface2, color: dir === "next" ? T.bgDeep : T.ink, border: "1px solid " + (dir === "next" ? T.primary : T.border) }}
    >
      {dir === "back" && <ArrowLeft size={15} />}
      {children}
      {dir === "next" && <ArrowRight size={15} />}
    </button>
  );
}

/* ----------------------- live system map (SVG) --------------------------- */
function SystemMap({ variables, influences }) {
  const W = 460, H = 320, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 56;
  const pos = {};
  const n = variables.length;
  variables.forEach((v, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
    pos[v.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
  return (
    <div className="mt-3 rounded-xl" style={{ background: T.inset, border: "1px solid " + T.border }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="System map">
        <defs>
          <marker id="dl-g" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={T.good} />
          </marker>
          <marker id="dl-r" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={T.bad} />
          </marker>
        </defs>
        {influences.map((inf, idx) => {
          const a = pos[inf.from], b = pos[inf.to];
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
          const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
          const col = inf.strength >= 0 ? T.good : T.bad;
          return (
            <path key={idx} d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`} fill="none"
              stroke={col} strokeWidth={1 + Math.abs(inf.strength) / 45} opacity="0.55"
              markerEnd={`url(#${inf.strength >= 0 ? "dl-g" : "dl-r"})`} />
          );
        })}
        {variables.map((v) => {
          const p = pos[v.id];
          const col = v.weight >= 0 ? T.good : T.bad;
          const r = 22 + Math.abs(v.weight) / 8;
          return (
            <g key={v.id}>
              <circle cx={p.x} cy={p.y} r={r} fill={col + "22"} stroke={col} strokeWidth="2" />
              <circle cx={p.x} cy={p.y} r={(r - 6) * (v.value / 100)} fill={col + "44"} />
              <text x={p.x} y={p.y + r + 14} fill={T.ink2} fontSize="11" textAnchor="middle">
                {v.name.length > 16 ? v.name.slice(0, 15) + "…" : v.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ----------------------- trajectory chart (SVG) -------------------------- */
function TrajectoryChart({ runs, horizon, focusId, best }) {
  const W = 620, H = 320, pl = 36, pr = 14, pt = 14, pb = 26;
  const ix = (t) => pl + (t * (W - pl - pr)) / Math.max(horizon, 1);
  const iy = (v) => pt + ((100 - v) * (H - pt - pb)) / 100;
  const grid = [0, 25, 50, 75, 100];
  const bandRun = runs.find((r) => r.option.id === focusId) || (best && runs.find((r) => r.option.id === best.option.id));

  return (
    <div className="mt-3 rounded-xl" style={{ background: T.inset, border: "1px solid " + T.border }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Option trajectories">
        {grid.map((g) => (
          <g key={g}>
            <line x1={pl} y1={iy(g)} x2={W - pr} y2={iy(g)} stroke={T.border} strokeWidth="1" />
            <text x={pl - 7} y={iy(g) + 4} fill={T.dim} fontSize="10" textAnchor="end">{g}</text>
          </g>
        ))}
        {[0, Math.round(horizon / 2), horizon].map((m) => (
          <text key={m} x={ix(m)} y={H - 8} fill={T.dim} fontSize="10" textAnchor="middle">{m}</text>
        ))}
        {bandRun && (() => {
          let top = "", bot = "";
          bandRun.traj.forEach((p, i) => {
            const s = 1.4 * i;
            top += `${ix(i)},${iy(Math.min(100, p.idx + s))} `;
            bot = `${ix(i)},${iy(Math.max(0, p.idx - s))} ` + bot;
          });
          return <polygon points={top + bot} fill={bandRun.color + "22"} />;
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
            fill={r.color} stroke={T.bgDeep} strokeWidth="2" />
        ))}
      </svg>
    </div>
  );
}
