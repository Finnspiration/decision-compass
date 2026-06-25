## Goal
When the user adds sources, let the AI propose 2–3 candidate decision questions to pick from — same UX feel as the suggested outcome label. Also stop truncating the decision/outcome text so it's fully readable.

## Changes

### 1. New server function — `suggestDecisions`
New file: `src/lib/suggest-decisions.functions.ts` (TanStack `createServerFn`).

Input: `{ files?: [{name, dataBase64}], urls?: string[], hint?: string }` (hint = whatever the user already typed, optional).

Reuses the existing PDF/URL extraction helpers from `ingest-sources.functions.ts` (factor `extractFromFiles` / `extractFromUrls` out into `src/lib/source-extract.server.ts`, or import via dynamic `import()` to avoid duplicating the SSRF/rate-limit guards).

Sends extracted excerpts to `google/gemini-3-flash-preview` with a plain-language system prompt:
- Return JSON `{ "decisions": [{ "question": string, "rationale": string }] }` with 2–3 items.
- Each `question` is one sentence, phrased as a real choice ("Should we …?"), ≤ 140 chars.
- One-sentence `rationale` ("Because your sources keep returning to X.").
- Plain-language glossary, no jargon.

Same `rateLimit` + `validateAndClampModel`-style guards as `ingestSources`.

### 2. Frame stage UI
In `src/components/DecisionLens.tsx`, Frame panel:

- After the sources list, add a secondary action **"Suggest decisions from these sources"**, enabled once at least one PDF or URL is attached. Disabled while running, with the same staged loading messages pattern (`Reading documents…`, `Spotting the real choice…`).
- On success, render a small "Pick a decision to frame" card with 2–3 selectable rows (radio-style). Each row shows the suggested question (full text, wrapped) and the rationale in muted text. A "Use this" button writes the question into the `decision` textarea, clears the suggestions, and focuses the textarea.
- A "Write my own" link dismisses the suggestion panel.
- Errors use the existing `describeAiError` toast helper, branded `Decision Lens · …`.

No change to the existing "Map decision from sources" primary CTA — suggesting decisions is an optional pre-step.

### 3. Readability fix (full visibility of decision + outcome label)
- Header in `src/components/DecisionLens.tsx` line ~1483: drop `truncate` from the `<h1>`; allow it to wrap to two lines (`line-clamp-2` with `break-words`), keep the `title` tooltip as fallback. Adjust the header to `items-start` so the wrapped title doesn't collide with the save button.
- Outcome label input (line ~1764) already shows full text; verify no parent `truncate` clips it and widen the input to `w-full` if needed.
- Stage subheading on the Model tab that interpolates `outcomeName` already wraps — no change.

### 4. Branding
All new toasts prefixed with `Decision Lens · …` per workspace rule.

## Out of scope
- Engine, scoring, saved model shape — untouched.
- AI prompts for `draftModel` / `ingestSources` — untouched (only the new `suggestDecisions` prompt is added).