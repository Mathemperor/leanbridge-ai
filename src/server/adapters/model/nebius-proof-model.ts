import OpenAI from "openai";
import type { ProofRequest, Translation } from "@shared/proof";
import { sanitizeLeanCode, translationSchema } from "@shared/proof";
import type { ProofModel, RepairContext } from "@server/domain/ports";
import { LEAN_SYSTEM_PROMPT, repairInstruction, sourceInstruction } from "./prompt";

export interface NebiusProofModelConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

export interface ChatClient {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<ChatCompletionResponse>;
    };
  };
}

const JSON_INSTRUCTION = `Return exactly one JSON object with these keys:
normalizedSource (string), theoremSummary (string), assumptions (string array), imports (string array), leanCode (string), notes (string array).
Do not wrap the JSON in Markdown fences.`;

function sanitizeTranslation(translation: Translation): Translation {
  return { ...translation, leanCode: sanitizeLeanCode(translation.leanCode) };
}

export class NebiusProofModel implements ProofModel {
  readonly #client: ChatClient;
  readonly #config: NebiusProofModelConfig;

  constructor(config: NebiusProofModelConfig, client?: ChatClient) {
    this.#config = config;
    this.#client = client ?? (new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    }) as unknown as ChatClient);
  }

  async translate(source: ProofRequest): Promise<Translation> {
    if (source.mode === "image") {
      throw new Error("The Nebius Nemotron provider currently supports text input only");
    }

    return this.#request([
      { role: "system", content: `${LEAN_SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` },
      { role: "user", content: sourceInstruction(source) },
    ]);
  }

  async repair(context: RepairContext): Promise<Translation> {
    return this.#request([
      { role: "system", content: `${LEAN_SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` },
      { role: "user", content: repairInstruction(context.translation, context.diagnostics) },
    ]);
  }

  async #request(messages: Array<Record<string, unknown>>): Promise<Translation> {
    const response = await this.#client.chat.completions.create({
      model: this.#config.model,
      messages,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error("The model returned no structured translation");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The model returned invalid structured translation JSON");
    }

    const translation = translationSchema.parse(parsed);
    return sanitizeTranslation(translation);
  }
}
