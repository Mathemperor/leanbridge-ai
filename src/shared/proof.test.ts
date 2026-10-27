import { describe, expect, it } from "vitest";
import { formatImageTranscription, imageTranscriptionSchema, proofRequestSchema, sanitizeLeanCode, translationSchema } from "./proof";

describe("proof request validation", () => {
  it("retains an edited image transcription when regenerating as text", () => {
    const imageTranscription={problemText:"题目",problemLatex:"x=x",solutionText:"由自反性",solutionLatex:"x=x",uncertainties:[]};
    expect(proofRequestSchema.parse({mode:"latex",latex:"识别稿",autoRepair:true,imageTranscription})).toMatchObject({imageTranscription});
  });

  it("bounds edited transcription fields before accepting a retry", () => {
    const imageTranscription={problemText:"x".repeat(8001),problemLatex:"",solutionText:"",solutionLatex:"",uncertainties:[]};
    expect(proofRequestSchema.safeParse({mode:"latex",latex:"识别稿",imageTranscription}).success).toBe(false);
  });
  it("retains and bounds user context for an edited transcription reopened from history", () => {
    const imageTranscription={problemText:"题目",problemLatex:"",solutionText:"",solutionLatex:"",uncertainties:[],context:"所有变量均为实数"};
    expect(proofRequestSchema.parse({mode:"latex",latex:"识别稿",imageTranscription})).toMatchObject({imageTranscription});
    expect(proofRequestSchema.safeParse({mode:"latex",latex:"识别稿",imageTranscription:{...imageTranscription,context:"x".repeat(10001)}}).success).toBe(false);
  });

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

describe("image transcription contract", () => {
  const transcript={problemText:"题目",problemLatex:"\\forall x, x=x",solutionText:"解答",solutionLatex:"x=x",uncertainties:["一个字符不清晰"]};
  it("keeps problem, solution and LaTeX distinct in the formalization source", () => {
    const text=formatImageTranscription(transcript,"用户说明");
    for (const value of Object.values(transcript).flat()) expect(text).toContain(value);
    expect(text).toContain("用户说明");
    expect(text).toContain("题目（LaTeX）");
    expect(text).toContain("解答（LaTeX）");
  });
  it("accepts a missing solution and an unreadable problem for retention", () => {
    expect(imageTranscriptionSchema.safeParse({problemText:"",problemLatex:"",solutionText:"",solutionLatex:"",uncertainties:["无法辨识题目"]}).success).toBe(true);
  });
  it("fits all permitted transcription data and image context within the text request limit", () => {
    const value={problemText:"p".repeat(8000),problemLatex:"q".repeat(8000),solutionText:"s".repeat(8000),solutionLatex:"t".repeat(8000),uncertainties:Array(20).fill("u".repeat(200))};
    expect(imageTranscriptionSchema.safeParse(value).success).toBe(true);
    expect(formatImageTranscription(value,"c".repeat(10000)).length).toBeLessThan(50000);
    expect(imageTranscriptionSchema.safeParse({...value,uncertainties:["u".repeat(201)]}).success).toBe(false);
    expect(imageTranscriptionSchema.safeParse({...value,uncertainties:Array(21).fill("u")}).success).toBe(false);
  });
  it("does not trust client-supplied transcription provenance", () => {
    const parsed=proofRequestSchema.parse({mode:"latex",latex:"识别稿",imageTranscription:{...transcript,source:"codex",createdAt:"forged"}});
    expect(parsed).toMatchObject({imageTranscription:transcript});
    expect(JSON.stringify(parsed)).not.toMatch(/forged|"source"/);
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
