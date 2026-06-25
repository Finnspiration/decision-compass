# Make outlook trajectories readable + flag suspicious model setup

Two UI-only changes in `src/components/DecisionLens.tsx`. No engine, type, or server-function changes.

## 1. Self-explanatory chart on the Decide tab

Goal: a non-technical reader instantly understands *which direction is good*, *where each option starts and ends*, and that the ranking is **relative**.

Changes to the "How each option plays out" panel:

- **Y-axis label** on the left edge of the SVG: "Outlook score (higher = better)". Small, muted.
- **Caption line** under the existing description: "Lines show the most likely path. Shaded bands show the range of plausible futures."
- **Per-option delta chips** rendered under the legend, one per option:
  - Format: `<color dot> {Option name} — starts {S}, ends {E} ({±Δ})`
  - Δ rendered with ▲/▼ glyph and a status color (green if Δ ≥ +2, red if Δ ≤ −2, muted otherwise).
  - Source: first and last point of each option's p50 series already computed in `simulateMonteCarlo`.
- **Relative-ranking note** beneath the win-probability list (right column), shown only when the top option's end value is below its start value:
  - "All options trend downward in this model — 'comes out ahead' means **loses the least**. To find options that *improve* the outlook, revisit the Model tab."
  - Render as a small `Alert`-style block with the existing warning token.

All copy uses the established plain-language glossary (driver / outlook / how it plays out). No new tokens.

## 2. Flag suspicious model setup on the Model tab

Goal: surface obvious modelling mistakes that produce misleading Decide-tab results — without prescribing answers.

Add a single `ModelSanityPanel` rendered at the top of the Model tab when any check fires. Each finding is one short sentence + the driver/option it refers to. Checks (pure functions over the current model, recomputed via `useMemo`):

- **Counter-intuitive weight sign**: a driver whose name contains hurt-words (depletion, burn, risk, cost, churn, saturation, debt, loss, attrition, drag) has a **positive** weight, OR a driver whose name contains help-words (growth, advantage, moat, reach, trust, quality, retention, momentum) has a **negative** weight. Message: "'{name}' is set as **helping** your goal — does that match reality?" (or *hurting* in the inverse case).
- **No option moves the dominant driver**: identify the driver with the largest `|weight|`. If every option's push on it is `|push| < 5`, flag: "No option meaningfully moves '{name}', which is the strongest driver in your model."
- **All options trend down**: if every option's p50 end < p50 start (computed from the same `simulateMonteCarlo` results the Decide tab already uses, lifted via `useMemo` so it isn't recomputed), flag: "Every option's outlook gets worse over time. Either a driver's sign is wrong, or no option pushes hard enough on what matters."

Panel UI:
- shadcn `Card` with a muted-warning surface (reuse the existing warning token, do not introduce new colors).
- Heading: "Worth a second look".
- List of findings, each with a small `AlertTriangle` icon and the offending driver/option name highlighted.
- Dismissable per-session (state only, no persistence).

## Files touched

- `src/components/DecisionLens.tsx` — add `ModelSanityPanel`, delta chips, axis label, caption, relative-ranking note. Lift Monte-Carlo results so both the chart and the sanity panel read the same series (no extra simulation runs).

## Out of scope

- Simulation engine, types, server functions, AI prompts, share-URL codec, templates, onboarding copy — all unchanged.
