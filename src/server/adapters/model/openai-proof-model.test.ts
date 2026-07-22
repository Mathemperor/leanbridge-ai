import { describe, expect, it, vi } from "vitest";
import type { Translation } from "@shared/proof";
import { OpenAIProofModel } from "./openai-proof-model";

const baseTranslation: Translation = {
  normalizedSource: "For every natural number n, n = n.",
  theoremSummary: "Reflexivity on natural numbers",
  assumptions: ["n is a natural number"],
  imports: ["Mathlib"],
  leanCode: "```lean\nimport Mathlib\ntheorem reflNat (n : Nat) : n = n := by rfl\n```",
  notes: [],
};

function createHarness(output: Translation | null = baseTranslation) {
  const parse = vi.fn().mockResolvedValue({ output_parsed: output });
  const model = new OpenAIProofModel(
    { apiKey: "test-key", model: "gpt-5.6", reasoningEffort: "high" },
    { responses: { parse } },
  );
  return { model, parse };
}

describe("OpenAIProofModel", () => {
  it("sends handwriting as original-detail image input", async () => {
    const { model, parse } = createHarness();

    await model.translate({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      context: "An elementary algebra proof",
      autoRepair: true,
    });

    const request = parse.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "gpt-5.6",
      reasoning: { effort: "high" },
      input: [
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "original",
            }),
          ]),
        }),
      ],
    });
  });

  it("sanitizes fenced Lean output", async () => {
    const { model } = createHarness();

    const translation = await model.translate({
      mode: "latex",
      latex: "n=n by reflexivity",
      autoRepair: true,
    });

    expect(translation.leanCode).toBe("import Mathlib\ntheorem reflNat (n : Nat) : n = n := by rfl");
  });

  it("includes compiler diagnostics in a repair request", async () => {
    const { model, parse } = createHarness();

    await model.repair({
      source: { mode: "latex", latex: "n=n", autoRepair: true },
      translation: { ...baseTranslation, leanCode: "theorem reflNat (n : Nat) : n = n := by exact unknown" },
      diagnostics: "Main.lean:1:48: error: unknown identifier 'unknown'",
    });

    expect(JSON.stringify(parse.mock.calls[0]?.[0])).toContain("unknown identifier 'unknown'");
  });

  it("fails clearly when structured output is absent", async () => {
    const { model } = createHarness(null);

    await expect(model.translate({ mode: "latex", latex: "n=n", autoRepair: true }))
      .rejects.toThrow(/structured translation/i);
  });
});
