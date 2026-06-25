## What's actually happening

The AI Gateway is healthy (3/3 success, 0 errors in the last week). The user's failing request **never reached the gateway** — the server function threw earlier, or the response was rejected by client-side validation. Today the catch blocks discard the real error and show a generic, slightly wrong toast ("couldn't reach the AI"), making this look like a connectivity issue when it isn't.

Three concrete suspects, all introduced or made worse by the recent security hardening:

1. **PDF extraction can throw on Cloudflare Workers.** `unpdf` is dynamically imported inside the handler and any failure (worker init, malformed PDF, oversized buffer) propagates up and turns into an opaque 500.
2. **Server-side clamping can produce an empty `options` array.** `validateAndClampModel` slugifies option-push keys and drops any that don't resolve to a known variable id. If the AI returns `options` with no recognizable variable ids, the array survives but `pushes` is `{}`; in some shapes the array itself empties. The client's `validateDraftedModel` requires `options.length > 0` and returns `null` → "Invalid model JSON".
3. **Bad client UX on failure.** When PDFs are rejected by zod (over the base64 size cap) the server returns 500 and the client just toasts a generic message; there's no signal that the file was simply too large.

## Fix

### Server: make failures observable and recoverable
`src/lib/ingest-sources.functions.ts`
- Wrap `extractPdfText` and `fetchUrlText` in per-source try/catch that collects a structured `skipped: [{ name, reason }]` list instead of silently dropping. Reasons: `oversized`, `not_pdf`, `pdf_parse_failed`, `private_host`, `non_https`, `timeout`, `bad_content_type`.
- If **all** sources fail but `decisionText` is present, still call the gateway with no source excerpts (degrade to plain draft) rather than throwing.
- Add `console.error("ingestSources", { stage, name, message })` at every failure point so the existing `server-function-logs` tool surfaces something.
- Return `{ model, skipped, degraded }` instead of a bare model so the UI can explain what was dropped.

`src/lib/ai-guard.server.ts`
- In `validateAndClampModel`, if `options.length === 0` after filtering, synthesize a single neutral "Status quo" option with empty pushes so downstream validation never trips. Same for `variables.length === 0` → return a sentinel that the handler can detect and treat as "no usable model" with a specific error code.
- Distinguish three throw classes: `RATE_LIMITED`, `AI_BAD_JSON`, `AI_HTTP_ERROR` — throw `Error` instances with these as `.message` prefixes so the client can branch.

### Client: real error messages, smarter routing
`src/components/DecisionLens.tsx`
- In `runIngest` and `runAutoDraft`, read `err?.message` and map known prefixes to specific toasts:
  - `RATE_LIMITED` → "Too many requests — wait a minute".
  - `AI_BAD_JSON` / `AI_HTTP_ERROR` → "AI returned an unusable result — try again or rephrase".
  - everything else → "Couldn't reach the AI" (the current copy, but only as a true fallback).
- Show the server's `skipped[]` list in the toast description, e.g. `"report.pdf: too large"`.
- Make `validateDraftedModel` accept `options.length === 0` by synthesizing a "Status quo" option client-side too, so a partially-valid AI response still lands on the Model stage instead of being rejected wholesale.
- Surface file rejection synchronously: enforce the 10MB / PDF-only / 5-file caps before encoding, with per-file toast lines.

### Verify `unpdf` actually runs on workerd
- Add a tiny `/api/public/health/pdf` route that decodes a built-in 1-page PDF and returns `{ ok: true, chars }`. If it 500s, swap `unpdf` for an alternative (or fall back to text-only ingestion) — out of scope for this plan but the health route makes the next step obvious.

### Validate the fix
1. Re-invoke `ingestSources` via `stack_modern--invoke-server-function` with: (a) no sources, (b) one valid small PDF, (c) one 12MB PDF, (d) an `http://` URL, (e) a private-IP URL. Expect a 200 with `skipped[]` entries for c/d/e and a usable model for a/b.
2. Check `ai_gateway_logs--list_ai_gateway_requests` to confirm the gateway is hit exactly when expected.
3. Check `stack_modern--server-function-logs` to confirm the new `console.error` lines appear for each skipped source.

## Files touched

- `src/lib/ingest-sources.functions.ts` — per-source try/catch, structured skipped list, degraded-mode call, logging, new return shape.
- `src/lib/ai-guard.server.ts` — empty-options safety net, typed error prefixes.
- `src/components/DecisionLens.tsx` — error-prefix routing in toasts, eager client-side file validation, accept synthesized options in `validateDraftedModel`, render `skipped[]`.
- `src/routes/api/public/health/pdf.ts` — new diagnostic route (small, optional).

## Out of scope

- Replacing `unpdf` (only if the health route confirms it's broken).
- Switching ingestion to a background job (`EdgeRuntime.waitUntil`-style) — only needed if duration becomes the failure mode; current 2.5s gateway latency says it isn't.
