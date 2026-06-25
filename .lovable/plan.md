## Why you see 100 / 0 / 0

This isn't a UI glitch — it's the Monte Carlo doing exactly what we told it to, and the result happens to be honest for this model.

In `winProbabilities` (lines 247–303 of `src/components/DecisionLens.tsx`) every run **shares** its randomness across the three options:

- one set of influence-strength noise (`infNoise`)
- one set of initial-value jitter (`initJitter`)
- one set of per-step process shocks (`shocks[t]`)

Only the per-option **push** noise (`optPushNoise`, ±25%) differs between options inside a run. That sharing is deliberate — it's the "common random numbers" trick, which makes paired comparisons fairer and reduces variance. The side effect: if one option is better than another in the *deterministic* model by more than push-noise can erase, it wins **every** run.

In your current model the medians are 66 / 53 / 38. Academic Bilingual beats #2 by 13 points and #3 by 28. The only thing that can flip the ranking is ±25% noise on the option's own pushes — and that's nowhere near enough to close a 13-point gap. So Academic Bilingual wins 300/300 = 100%. Mathematically correct, but useless as a confidence signal.

The chart shows the same story: the blue p10–p90 fan widens with horizon, but the orange and green lines barely have a fan — `simulateMonteCarlo` is called once per option independently, and each option's spread doesn't overlap the others.

## Stable solution

Split the noise into two layers — keep "common random numbers" for fairness, but add **per-option idiosyncratic execution noise** so two options in the same world realize differently. This is how real decisions work: the same market conditions hit two strategies differently because execution, timing, and second-order effects vary.

Changes confined to `simulateMonteCarlo` and `winProbabilities` (no engine, no UI):

1. **Add a per-option, per-step execution shock**: inside the variable update, add `EXEC_SIG * gauss()` drawn fresh for each `(run, option, t, variable)`. Suggested `EXEC_SIG ≈ 2.0` (same 0–100 scale).
2. **Add per-option push-realization noise per step** (small): replace the once-per-run `optPushNoise` constant with a per-step multiplier `1 + PUSH_STEP_SIG * gauss()` (≈ 0.10) on top of the existing per-run factor. Models "this option's nudge lands harder some steps than others."
3. **Keep** shared world noise (`infNoise`, `initJitter`, `shocks`) — that's what makes the ranking fair instead of a coin flip. Just lower `MC_PROCESS_SIG` from 2.5 → 1.5 so shared shocks don't dominate.
4. **Use the same scheme in `simulateMonteCarlo`** so the per-option fan on the chart widens too, and the chart visually agrees with the win-%.
5. Expose the four constants at module scope: `MC_COEF_SIG = 0.25`, `MC_INIT_SIG = 3`, `MC_PROCESS_SIG = 1.5`, `MC_EXEC_SIG = 2.0`, `MC_PUSH_STEP_SIG = 0.10`. Keep `MC_RUNS = 300`.

Expected effect on your current model: Academic Bilingual still wins most runs (it genuinely dominates in the deterministic model), but typical shares land near ~80 / ~17 / ~3 instead of 100 / 0 / 0. Models with a <5-point gap will show near-50/50 splits. The orange/green fans on the chart will visibly fan out instead of hugging the line.

### Honest caveat shown in the UI

Even with this, a 28-point gap (yours vs. #3) *should* produce ~0% — that's the model talking. The remaining ask is to make sure the user reads "0%" as "robustly dominated in this model" rather than "the simulator is broken." The existing "Respect the model error" panel already says this, but we can tighten one line: when the leader's win-% is ≥ 95% AND the median gap to #2 is ≥ 10, add "**Robust lead:** in this model, #1 wins in essentially every plausible world. Stress-test by lowering its strongest variable weight or strengthening a competing influence."

## Files touched

- `src/components/DecisionLens.tsx` — `simulateMonteCarlo`, `winProbabilities`, noise constants, and one extra sentence in the "Respect the model error" Card when the lead is robust.

No engine changes (`simulate`, `outcomeOf` untouched), no model-shape changes, no styling changes.
