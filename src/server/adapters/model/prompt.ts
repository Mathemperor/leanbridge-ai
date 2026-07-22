import type { ProofRequest, Translation } from "@shared/proof";

export const LEAN_SYSTEM_PROMPT = `You are a Lean 4 and mathlib formalization engineer.
Convert the supplied human mathematical proof into one self-contained Lean 4 source file.

Hard requirements:
- Preserve the mathematical meaning; never silently strengthen, weaken, or replace the claim.
- Make every necessary domain, variable, and hypothesis explicit.
- Use Lean 4 syntax and current mathlib names.
- Include the imports required by the proof and keep them reasonably small.
- The leanCode field must be raw Lean source, ready to compile, with no Markdown fences.
- Never use sorry, admit, new axioms, or other proof placeholders.
- Never use compile-time IO or metaprogramming commands such as #eval, run_cmd, run_tac, initialize, include_str, custom syntax, macros, elaborators, externs, or unsafe declarations.
- Prefer readable tactic or term proofs over brittle generated noise.
- If the source is ambiguous, choose the narrowest faithful formalization and record the ambiguity in notes.
- For an image, first transcribe the handwritten proof into normalizedSource, including symbols and quantifiers.

Return only the requested structured object.`;

export const LEAN_REPAIR_PROMPT = `Repair the Lean 4 source using the exact compiler diagnostics.
Keep the theorem statement mathematically equivalent to the supplied normalized source.
Change imports or proof terms when required, but do not hide the error with sorry, admit, axioms, or weakened claims.
Return a complete compilable source file in leanCode and briefly record material changes in notes.`;

export function sourceInstruction(source: ProofRequest): string {
  if (source.mode === "latex") {
    return `Formalize this LaTeX or natural-language proof:\n\n${source.latex}`;
  }
  return [
    "Transcribe and formalize the handwritten mathematical proof in the attached image.",
    source.context ? `Additional context from the user:\n${source.context}` : "",
  ].filter(Boolean).join("\n\n");
}

export function repairInstruction(translation: Translation, diagnostics: string): string {
  return [
    LEAN_REPAIR_PROMPT,
    `Normalized source:\n${translation.normalizedSource}`,
    `Current Lean source:\n${translation.leanCode}`,
    `Lean compiler diagnostics:\n${diagnostics}`,
  ].join("\n\n");
}
