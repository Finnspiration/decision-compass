## Problem

The root route fails to load with `Failed to fetch dynamically imported module: /src/routes/index.tsx?tsr-split=component`. The TanStack code-splitter's transformed output still references `/src/components/DecisionLens.jsx`, but that file was renamed to `DecisionLens.tsx` in the shadcn refactor. The cached split chunk 404s, so the whole page errors.

## Fix

1. Restart the Vite dev server so the code-splitter re-resolves `@/components/DecisionLens` to the new `.tsx` file and invalidates the stale `.jsx` chunk.
2. Verify the preview loads (no console "Failed to fetch dynamically imported module" error) and the Frame → Model → Options → Decide tabs render.

No source changes needed — `src/routes/index.tsx` already imports `@/components/DecisionLens` (extensionless), and `src/components/DecisionLens.tsx` exists and typechecks clean.