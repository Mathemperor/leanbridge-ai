import { describe, expect, it } from "vitest";
import { proofRequestSchema, sanitizeLeanCode, translationSchema } from "./proof";

describe("proof request validation", () => {
  it("requires source for the selected mode", () => {
    const result = proofRequestSchema.safeParse({
      mode: "latex",
      latex: "",
      autoRepair: true,
    });

    expect(result.success).toBe(false);
  });

  it("accepts PNG image data URLs", () => {
    const result = proofRequestSchema.safeParse({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      autoRepair: true,
    });

    expect(result.success).toBe(true);
  });

  it("rejects unsupported image formats", () => {
    const result = proofRequestSchema.safeParse({
      mode: "image",
      imageDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      autoRepair: true,
    });

    expect(result.success).toBe(false);
  });
});

describe("Lean source sanitization", () => {
  it("removes a single Markdown code fence", () => {
    expect(sanitizeLeanCode("```lean\ntheorem t : True := by trivial\n```"))
      .toBe("theorem t : True := by trivial");
  });

  it.each(["sorry", "admit"])("rejects the %s proof placeholder", (placeholder) => {
    expect(() => sanitizeLeanCode(`theorem t : True := by ${placeholder}`))
      .toThrow(/placeholder/i);
  });

  it.each([
    "#eval IO.getEnv \"OPENAI_API_KEY\"",
    "run_cmd IO.println \"unsafe\"",
    "theorem t : True := by run_tac Lean.Elab.Tactic.closeMainGoalUsing `True.intro",
    "initialize payload : IO Unit ← IO.println \"unsafe\"",
    "include_str \"/proc/self/environ\"",
    "axiom forged : False",
    "def payload : Nat := by_elab liftIO (IO.println \"compile-time side effect\"); return Lean.mkNatLit 0",
  ])("rejects compile-time or axiom-capable source: %s", (source) => {
    expect(() => sanitizeLeanCode(source)).toThrow(/unsafe Lean construct/i);
  });
});

describe("translation validation", () => {
  it("bounds generated Lean source retained in a job", () => {
    const result = translationSchema.safeParse({
      normalizedSource: "P",
      theoremSummary: "P",
      assumptions: [],
      imports: ["Mathlib"],
      leanCode: "x".repeat(200_001),
      notes: [],
    });

    expect(result.success).toBe(false);
  });
});
