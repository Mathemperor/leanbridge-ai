import { describe, expect, it } from "vitest";
import { DemoProofModel } from "./demo-proof-model";

describe("DemoProofModel", () => {
  it("returns deterministic Lean for LaTeX input", async () => {
    const model = new DemoProofModel();
    const result = await model.translate({
      mode: "latex",
      latex: "证明自然数加法交换律",
      autoRepair: true,
    });

    expect(result.leanCode).toContain("Nat.add_comm");
    expect(result.normalizedSource).toContain("证明自然数加法交换律");
    expect(result.leanCode).not.toMatch(/\b(?:sorry|admit)\b/);
  });

  it("marks image transcription as a demonstration", async () => {
    const model = new DemoProofModel();
    const result = await model.translate({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      context: "group theory",
      autoRepair: true,
    });

    expect(result.normalizedSource).toMatch(/演示|demo/i);
  });
});
