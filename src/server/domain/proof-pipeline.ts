import type { ProofJob, ProofRequest, Translation } from "@shared/proof";
import { sanitizeLeanCode } from "@shared/proof";
import type { LeanVerifier, ProofModel, VerifyOptions } from "./ports";
import { InMemoryJobStore } from "./job-store";

const MANUAL_VERIFICATION_NOTE = "用户手动编辑后重新验证。";

export interface ProofPipelineDependencies {
  model: ProofModel;
  verifier: LeanVerifier;
  store?: InMemoryJobStore;
  maxRepairAttempts?: number;
  verifyDefaults?: VerifyOptions;
}

function verifyOptions(request: ProofRequest, defaults: VerifyOptions): VerifyOptions {
  return {
    ...defaults,
    ...(request.projectPath ? { projectPath: request.projectPath } : {}),
  };
}

export class ProofPipeline {
  readonly #model: ProofModel;
  readonly #verifier: LeanVerifier;
  readonly #store: InMemoryJobStore;
  readonly #maxRepairAttempts: number;
  readonly #verifyDefaults: VerifyOptions;

  constructor(dependencies: ProofPipelineDependencies) {
    this.#model = dependencies.model;
    this.#verifier = dependencies.verifier;
    this.#store = dependencies.store ?? new InMemoryJobStore();
    this.#maxRepairAttempts = dependencies.maxRepairAttempts ?? 3;
    this.#verifyDefaults = dependencies.verifyDefaults ?? {};
  }

  start(request: ProofRequest): ProofJob {
    return this.#store.create(request);
  }

  get(id: string): ProofJob | undefined {
    return this.#store.get(id);
  }

  async run(id: string): Promise<void> {
    const stored = this.#store.getStored(id);
    if (!stored) throw new Error(`Unknown proof job: ${id}`);
    const { request } = stored;
    let phase: "model" | "verifier" = "model";

    try {
      if (request.mode === "image") {
        this.#store.transition(id, "reading", "正在识别手写证明");
      }
      this.#store.transition(id, "translating", "正在构造 Lean 4 形式化证明");
      let translation: Translation;
      try {
        translation = await this.#model.translate(request);
      } finally {
        this.#store.releaseLargeInput(id);
      }
      this.#store.recordTranslation(id, translation, "initial");

      for (let repairs = 0; ; repairs += 1) {
        phase = "verifier";
        this.#store.transition(id, "verifying", repairs === 0 ? "正在调用 Lean 验证" : `正在验证第 ${repairs} 次修复`);
        const verification = await this.#verifier.verify(
          translation.leanCode,
          verifyOptions(request, this.#verifyDefaults),
        );
        this.#store.recordVerification(id, verification);

        if (verification.ok) {
          this.#store.finish(id, "verified");
          return;
        }
        if (!request.autoRepair || repairs >= this.#maxRepairAttempts) {
          this.#store.finish(id, "failed");
          return;
        }

        phase = "model";
        this.#store.transition(id, "repairing", `正在根据编译诊断进行第 ${repairs + 1} 次修复`);
        translation = await this.#model.repair({
          source: request,
          translation,
          diagnostics: verification.output,
        });
        this.#store.recordTranslation(id, translation, "repair");
      }
    } catch {
      this.#store.fail(
        id,
        phase === "model"
          ? "AI translation failed. Check the server configuration and try again."
          : "Lean verification could not be started. Check the Lean project configuration.",
      );
    }
  }

  async reverify(id: string, code: string): Promise<ProofJob> {
    const stored = this.#store.getStored(id);
    if (!stored?.translation) throw new Error("The proof job has no generated Lean source");
    const translation: Translation = {
      ...stored.translation,
      leanCode: sanitizeLeanCode(code),
      notes: stored.translation.notes.includes(MANUAL_VERIFICATION_NOTE)
        ? stored.translation.notes
        : [...stored.translation.notes.slice(0, 63), MANUAL_VERIFICATION_NOTE],
    };
    this.#store.recordTranslation(id, translation, "manual");
    this.#store.transition(id, "verifying", "正在验证手动编辑的 Lean 代码");

    try {
      const verification = await this.#verifier.verify(
        translation.leanCode,
        verifyOptions(stored.request, this.#verifyDefaults),
      );
      this.#store.recordVerification(id, verification);
      return this.#store.finish(id, verification.ok ? "verified" : "failed");
    } catch {
      return this.#store.fail(id, "Lean verification could not be started. Check the Lean project configuration.");
    }
  }
}
