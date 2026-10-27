import type { ProofJob, ProofRequest, Translation, VerificationResult } from "@shared/proof";
import { formatImageTranscription, LeanSourceValidationError, sanitizeLeanCode } from "@shared/proof";
import type { LeanVerifier, ProofModel, VerifyOptions } from "./ports";
import { InMemoryJobStore } from "./job-store";
import { safeProviderErrorDetail } from "./safe-error-detail";

const MANUAL_VERIFICATION_NOTE = "用户手动编辑后重新验证。";

export class ProofJobBusyError extends Error {
  constructor() { super("当前任务仍在运行，请完成后再修改验证。"); }
}

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

function sourceRejection(code: string): VerificationResult | undefined {
  try { sanitizeLeanCode(code); return undefined; }
  catch (error) {
    if (!(error instanceof LeanSourceValidationError)) throw error;
    const message = `${error.code}: ${error.message}`;
    return {ok:false,status:"failed",command:"Lean source validation (not compiled)",durationMs:0,output:message,diagnostics:[{severity:"error",message}]};
  }
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

  startVerifyCode(rawCode: string): ProofJob {
    const code=sanitizeLeanCode(rawCode);
    const job=this.start({mode:"latex",latex:"手动提交的 Lean 源码",autoRepair:false});
    this.#store.recordTranslation(job.id,{normalizedSource:"用户提供的 Lean 源码，未经 AI 翻译。",theoremSummary:"直接编译 Lean 源码；请自行核对命题含义。",assumptions:[],imports:[],leanCode:code,notes:["本任务未调用 AI 模型。"]},"manual");
    return this.#store.transition(job.id,"verifying","正在编译手动提交的 Lean 代码");
  }

  async verifyCode(rawCode: string): Promise<ProofJob> {
    return this.runVerification(this.startVerifyCode(rawCode).id);
  }

  async run(id: string): Promise<void> {
    const stored = this.#store.getStored(id);
    if (!stored) throw new Error(`Unknown proof job: ${id}`);
    const { request } = stored;
    let phase: "recognition" | "model" | "verifier" = "model";
    let formalizationSource: ProofRequest = request;

    try {
      if (request.mode === "image") {
        phase = "recognition";
        this.#store.transition(id, "reading", "正在识别题目与已有解答");
        try {
          if (!this.#model.transcribeImage) throw new Error("Image recognition is unavailable");
          const transcription = await this.#model.transcribeImage(request);
          this.#store.recordImageTranscription(id, {...transcription,...(request.context!==undefined?{context:request.context}:{})}, "codex");
          if (!transcription.problemText.trim() && !transcription.problemLatex.trim()) {
            this.#store.fail(id, "Image recognition failed: no readable problem was found. Edit the retained transcription and retry.");
            return;
          }
          const {imageDataUrl: _image, context, mode: _mode, ...options} = request;
          formalizationSource = {mode:"latex",latex:formatImageTranscription(transcription,context),...options};
        } finally {
          this.#store.releaseLargeInput(id);
        }
      } else if (request.imageTranscription) {
        if (!request.imageTranscription.problemText.trim() && !request.imageTranscription.problemLatex.trim()) {
          this.#store.fail(id, "Image recognition failed: no readable problem was found. Edit the retained transcription and retry.");
          return;
        }
        formalizationSource = {
          ...request,
          latex: formatImageTranscription(request.imageTranscription, request.imageTranscription.context),
        };
      }
      phase = "model";
      this.#store.transition(id, "translating", "正在构造 Lean 4 形式化证明");
      let translation: Translation = await this.#model.translate(formalizationSource);
      this.#store.recordTranslation(id, translation, "initial");

      for (let repairs = 0; ; repairs += 1) {
        phase = "verifier";
        const rejected = sourceRejection(translation.leanCode);
        this.#store.transition(id, "verifying", rejected ? "生成源码未通过检查，未发送至编译器" : repairs === 0 ? "正在调用 Lean 验证" : `正在验证第 ${repairs} 次修复`);
        const verification = rejected ?? await this.#verifier.verify(
          sanitizeLeanCode(translation.leanCode),
          verifyOptions(request, this.#verifyDefaults),
        );
        this.#store.recordVerification(id, verification);

        if (verification.ok) {
          this.#store.finish(id, "verified");
          return;
        }
        if (verification.status !== "failed" || !request.autoRepair || repairs >= this.#maxRepairAttempts) {
          this.#store.finish(id, "failed");
          return;
        }

        phase = "model";
        this.#store.transition(id, "repairing", `正在根据编译诊断进行第 ${repairs + 1} 次修复`);
        translation = await this.#model.repair({
          source: formalizationSource,
          translation,
          diagnostics: verification.output,
        });
        this.#store.recordTranslation(id, translation, "repair");
      }
    } catch (error) {
      const message = phase === "recognition"
        ? "Image recognition failed. Check the image and Codex connection, then retry."
        : phase === "model"
        ? "AI translation failed. Check the server configuration and try again."
        : "Lean verification could not be started. Check the Lean project configuration.";
      const detail = phase !== "verifier" ? safeProviderErrorDetail(error) : "";
      this.#store.fail(id, detail ? `${message} ${detail}` : message);
    }
  }

  startReverify(id: string, code: string): ProofJob {
    const stored = this.#store.getStored(id);
    if (stored && stored.status !== "verified" && stored.status !== "failed") throw new ProofJobBusyError();
    if (!stored?.translation) throw new Error("The proof job has no generated Lean source");
    const translation: Translation = {
      ...stored.translation,
      leanCode: sanitizeLeanCode(code),
      notes: stored.translation.notes.includes(MANUAL_VERIFICATION_NOTE)
        ? stored.translation.notes
        : [...stored.translation.notes.slice(0, 63), MANUAL_VERIFICATION_NOTE],
    };
    this.#store.recordTranslation(id, translation, "manual");
    return this.#store.transition(id, "verifying", "正在验证手动编辑的 Lean 代码");
  }

  async reverify(id: string, code: string): Promise<ProofJob> {
    return this.runVerification(this.startReverify(id, code).id);
  }

  async runVerification(id: string): Promise<ProofJob> {
    const stored = this.#store.getStored(id);
    if (!stored?.translation) throw new Error("The proof job has no Lean source");

    try {
      const verification = sourceRejection(stored.translation.leanCode) ?? await this.#verifier.verify(
        sanitizeLeanCode(stored.translation.leanCode),
        verifyOptions(stored.request, this.#verifyDefaults),
      );
      this.#store.recordVerification(id, verification);
      return this.#store.finish(id, verification.ok ? "verified" : "failed");
    } catch {
      return this.#store.fail(id, "Lean verification could not be started. Check the Lean project configuration.");
    }
  }
}
