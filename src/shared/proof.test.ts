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
  it("accepts proof comments including nested block comments without treating their words as declarations", () => {
    const code = "-- The derivative is constant; no sorry is used.\n/- A constant function /- no new axiom -/ has zero derivative. -/\nexample : True := by trivial";
    expect(sanitizeLeanCode(code)).toBe(code);
  });
  it("does not interpret quoted interpolation examples inside comments as code", () => {
    const code='-- s!"sorry" is a comment\n/- dbg_trace "axiom" is also a comment -/\nexample : True := by trivial';
    expect(sanitizeLeanCode(code)).toBe(code);
  });

  it("identifies a source rejection without calling it a subscription failure", () => {
    expect(() => sanitizeLeanCode("example : False := by sorry"))
      .toThrow(expect.objectContaining({name:"LeanSourceValidationError",code:"LEAN_PROOF_PLACEHOLDER"}));
  });

  it.each([
    'def label := "--"; axiom forged : False',
    'def label := "/-"; axiom forged : False',
    'def label := r#"-- /-"#; axiom forged : False',
    'def «--label» := 1; axiom forged : False',
    'def label := s!"{ "--" }"; axiom forged : False',
    'def marker : Nat := dbg_trace "{ "/-" }"; 0\nexample : False := by sorry',
    'def marker : Nat := dbg_trace "{ "/-" }"; 0\n#eval IO.println "scanner-bypass"',
    "def quote : Char := '\\\"'; def label := \"--\"; axiom forged : False",
    '-- comment\raxiom forged : False',
    '/- an outer /- nested -/ comment -/\nexample : False := by sorry',
  ])("does not hide executable tokens behind a comment-looking literal: %s", (code) => {
    expect(() => sanitizeLeanCode(code)).toThrow();
  });

  it("removes a single Markdown code fence", () => {
    expect(sanitizeLeanCode("```lean\ntheorem t : True := by trivial\n```"))
      .toBe("theorem t : True := by trivial");
  });

  it.each(["sorry", "admit", "sorryAx"])("rejects the %s proof placeholder", (placeholder) => {
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
