import { describe, expect, it, vi } from "vitest";
import type { Translation } from "@shared/proof";
import { NebiusProofModel } from "./nebius-proof-model";

const baseTranslation: Translation = {
  normalizedSource: "For every natural number n, n = n.",
  theoremSummary: "Reflexivity on natural numbers",
  assumptions: ["n is a natural number"],
  imports: ["Mathlib"],
  leanCode: "```lean\nimport Mathlib\ntheorem reflNat (n : Nat) : n = n := by rfl\n```",
  notes: [],
};

function createHarness(output: Translation | null = baseTranslation) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: output ? JSON.stringify(output) : null } }],
  });
  const model = new NebiusProofModel(
    {
      apiKey: "test-key",
      model: "nvidia/nemotron-3-super-120b-a12b",
      baseURL: "https://api.tokenfactory.us-central1.nebius.com/v1/",
    },
    { chat: { completions: { create } } },
  );
  return { model, create };
}

describe("NebiusProofModel", () => {
  it("uses Token Factory chat completions with JSON output", async () => {
    const { model, create } = createHarness();

    await model.translate({
      mode: "latex",
      latex: "n=n by reflexivity",
      autoRepair: true,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "nvidia/nemotron-3-super-120b-a12b",
      response_format: { type: "json_object" },
      messages: [
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("n=n by reflexivity"),
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
    const { model, create } = createHarness();

    await model.repair({
      source: { mode: "latex", latex: "n=n", autoRepair: true },
      translation: {
        ...baseTranslation,
        leanCode: "theorem reflNat (n : Nat) : n = n := by exact unknown",
      },
      diagnostics: "Main.lean:1:48: error: unknown identifier 'unknown'",
    });

    expect(JSON.stringify(create.mock.calls[0]?.[0])).toContain("unknown identifier 'unknown'");
  });

  it("fails clearly when Token Factory returns no JSON body", async () => {
    const { model } = createHarness(null);

    await expect(model.translate({ mode: "latex", latex: "n=n", autoRepair: true }))
      .rejects.toThrow(/structured translation/i);
  });

  it("rejects image input for the default text-only Nemotron model", async () => {
    const { model, create } = createHarness();

    await expect(model.translate({
      mode: "image",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
      autoRepair: true,
    })).rejects.toThrow(/text input/i);
    expect(create).not.toHaveBeenCalled();
  });
});
