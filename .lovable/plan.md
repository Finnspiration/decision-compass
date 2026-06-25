## Bug
In `src/components/DecisionLens.tsx` (lines 1239–1240):

```ts
useEffect(() => { setModelSuggestions(null); }, [variables, influences]);
useEffect(() => { setOptionSuggestions(null); }, [options, variables]);
```

These effects wipe the entire suggestion list whenever the underlying model changes. Accepting a suggestion mutates `variables` / `influences` / `options`, which triggers these effects and clears every remaining card — even though `acceptSuggestion` already removes just the accepted item from the list.

## Fix
Remove those two auto-clear `useEffect`s. Suggestion list lifecycle is already correctly handled by:
- `acceptSuggestion` — filters out the accepted suggestion.
- `dismissSuggestion` — filters out the dismissed one.
- `improveModel` fetch — overwrites the list with a fresh batch when the user clicks "Get more suggestions".

After accepting a driver, the remaining suggestions stay visible. Stale suggestions referencing now-existing drivers/influences/options are already guarded inside `acceptSuggestion` (duplicate checks emit a neutral toast).

No engine, AI prompt, or saved-model changes. Single-file edit, ~2 lines removed.