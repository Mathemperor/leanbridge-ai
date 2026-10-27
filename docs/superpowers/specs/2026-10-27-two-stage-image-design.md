# Two-stage image recognition

The user requests image → text/LaTeX → Lean → real compilation, using their Codex subscription. They explicitly selected automatic continuation with a retained, editable transcription.

## Approach

Replace the production Codex one-call image formalization path with two serialized CLI calls. The first transcribes visible problem and supplied solution without solving or writing Lean. The second receives only the formatted transcription and existing user context. Keep the same selected model/effort and existing bounded repair flow. A manual confirmation gate was considered; the user chose automatic continuation instead.

## Contract

`ImageTranscription` has `problemText`, `problemLatex`, `solutionText`, `solutionLatex` (strings, at most 8,000 characters each), and `uncertainties` (at most 20 strings, 200 characters each). Empty solution is valid; both problem fields empty must stop generation after retaining the transcription.

`ProofJob.imageTranscription?` adds the same fields plus `source: "codex" | "edited"`, `createdAt: string`, optional `modelConfig: CodexSettings`, and optional `context: string` (at most 10,000 characters) preserving user-supplied assumptions after history reopening. `EditedImageTranscription` extends the five OCR fields with this optional context; OCR model output itself remains exactly five fields. For edited retries only, the LaTeX request may contain `imageTranscription?: EditedImageTranscription`; the server always labels this metadata `edited`, never trusts client provenance, and derives the authoritative text from these fields and context. No database migration is needed because Sites saves the complete job JSON.

`formatImageTranscription(value, context?)` creates the textual Lean-generation input. Four labelled sections, then uncertainties and user context, stay below the existing 50,000-character text limit. The same formatting is mirrored in the Site.

## Behavior

- Record `reading` while Codex reads the image. Save transcription immediately, free image bytes, then record `translating` and run text-only formalization automatically.
- Preserve transcription on formalization/compile failure and in history/export. Clearly distinguish recognition errors from formalization or Lean errors.
- Show an accessible mobile editor for all four fields and uncertainty lines. Edits do not mutate an in-flight job. A retry creates a new text job, preserves edited transcription, and uses current model/effort settings.
- Recognition has a separate 180-second default deadline, configurable within 30–300 seconds. Formalization retains its existing 15-minute default.
- Keep Codex-only inference, official device login, original auth volume, owner access, model selector, history deletion, and true LeanWeb validation. Do not publish credentials or image payloads in history.
- Existing records without transcription remain readable. User-visible colors, navigation and hosting identity stay intact.

## Implementation decisions

Reuse the current TypeScript services and CLI queue. No extra OCR provider or dependency. Root owns the shared schema and integration; separate workers own backend orchestration and Site UI after the contract is fixed. Publication remains with root. Real original-photo acceptance must show a retained transcription before Lean translation; unit tests and independent manual proofs are not substitutes.
