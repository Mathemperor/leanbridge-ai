import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ProofRequest, Translation } from "@shared/proof";
import { sanitizeLeanCode, translationSchema } from "@shared/proof";
import type { ProofModel, RepairContext } from "@server/domain/ports";
import { LEAN_SYSTEM_PROMPT, repairInstruction, sourceInstruction } from "./prompt";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface OpenAIProofModelConfig {
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

interface StructuredResponse {
  output_parsed: Translation | null;
}

export interface ResponsesClient {
  responses: {
    parse(request: Record<string, unknown>): Promise<StructuredResponse>;
  };
}

function sanitizeTranslation(translation: Translation): Translation {
  return { ...translation, leanCode: sanitizeLeanCode(translation.leanCode) };
}

export class OpenAIProofModel implements ProofModel {
  readonly #client: ResponsesClient;
  readonly #config: OpenAIProofModelConfig;

  constructor(config: OpenAIProofModelConfig, client?: ResponsesClient) {
    this.#config = config;
    this.#client = client ?? (new OpenAI({ apiKey: config.apiKey }) as unknown as ResponsesClient);
  }

  async translate(source: ProofRequest): Promise<Translation> {
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: sourceInstruction(source) },
    ];
    if (source.mode === "image") {
      content.push({
        type: "input_image",
        image_url: source.imageDataUrl,
        detail: "original",
      });
    }

    return this.#request([
      { role: "system", content: LEAN_SYSTEM_PROMPT },
      { role: "user", content },
    ]);
  }

  async repair(context: RepairContext): Promise<Translation> {
    return this.#request([
      { role: "system", content: LEAN_SYSTEM_PROMPT },
      { role: "user", content: repairInstruction(context.translation, context.diagnostics) },
    ]);
  }

  async #request(input: Array<Record<string, unknown>>): Promise<Translation> {
    const response = await this.#client.responses.parse({
      model: this.#config.model,
      reasoning: { effort: this.#config.reasoningEffort },
      input,
      text: { format: zodTextFormat(translationSchema, "lean_translation") },
    });

    if (!response.output_parsed) {
      throw new Error("The model returned no structured translation");
    }
    return sanitizeTranslation(response.output_parsed);
  }
}
