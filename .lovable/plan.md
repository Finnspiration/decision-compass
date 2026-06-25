## Diagnosis

The 100% / 0% / 0% split is not a UI bug — the Monte-Carlo math is doing what it's told, but the noise model is too weak to ever flip a winner.

Current noise in both `simulateMonteCarlo` and `winProbabilities` (DecisionLens.tsx lines 194–288):

- 15% multiplicative noise on **influence strengths** (drawn once per run).
- 15% multiplicative noise on **option pushes** (drawn once per run).
- No noise on initial variable values.
- No per-step (process) noise on the variable updates themselves.

Because the noise multiplies fixed coefficients drawn **once per run**, each rollout is essentially a near-deterministic trajectory shifted by a small constant. With the example model the medians are 62 / 47 / 40 — gaps of 15 and 22 points. Final-outcome variance from ±15% on coefficients is far smaller than that gap, so the same option wins all 300 runs. Hence "100% / 0% / 0%" every time the gap is wider than a couple of points.

This also explains why the p10–p90 fan in the chart looks like a thin ribbon hugging the median — same root cause.

## Fix

Make the noise actually compound over the horizon so realistic uncertainty grows with time, without changing the deterministic `simulate` / `outcomeOf` engine the user asked us to leave alone.

Changes confined to `simulateMonteCarlo` (≈ lines 194–234) and `winProbabilities` (≈ lines 241–288) in `src/components/DecisionLens.tsx`:

1. **Add per-step process noise** to each variable update: a small Gaussian shock added inside the `for (let t = ...)` loop, e.g. `cur[v.id] += PROCESS_SIG * gaussSample()` with `PROCESS_SIG ≈ 2.5` (in the same 0–100 scale `outcomeOf` operates on). This compounds across the horizon and is the dominant source of realistic spread.
2. **Add initial-condition noise**: jitter each starting `cur[v.id]` by a small Gaussian (σ ≈ 3) so two runs don't start identically.
3. **Bump coefficient noise** from `SIG = 0.15` to `SIG = 0.25` so influence/push uncertainty is non-trivial but still secondary to process noise.
4. **Share the same noise scheme and constants** between `simulateMonteCarlo` (the band on the chart) and `winProbabilities` (the ranking) so the chart's fan and the win-% agree visually. Extract the three constants to module-scope so they can't drift apart.
5. Keep `MC_RUNS = 300` and the existing `clamp` to `[0, 100]`. No changes to `simulate`, `outcomeOf`, the model shape, the chart rendering, or any UI copy.

Expected effect on the user's current model (medians 62 / 47 / 40): the leader still wins most runs but no longer 100% — typical win shares land somewhere like ~70 / ~25 / ~5, and the p10–p90 fan visibly widens with horizon. Genuinely close models (gap ≲ 5 pts) will show near-50/50 splits as expected.

## Files touched

- `src/components/DecisionLens.tsx` — only `simulateMonteCarlo`, `winProbabilities`, and three module-scope noise constants.

No other files, no engine changes, no UI/style changes.
