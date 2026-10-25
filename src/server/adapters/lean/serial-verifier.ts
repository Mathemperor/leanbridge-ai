import type { VerificationResult } from "@shared/proof";
import type { LeanVerifier, VerifyOptions } from "@server/domain/ports";
import type { RuntimeMemoryCoordinator } from "@server/domain/runtime-memory";

export interface SerialLeanVerifierOptions {
  maxPending?: number;
  coordinator?: Pick<RuntimeMemoryCoordinator, "runExclusive"> | undefined;
}

export class SerialLeanVerifier implements LeanVerifier {
  readonly #inner: LeanVerifier;
  readonly #maxPending: number;
  readonly #coordinator: Pick<RuntimeMemoryCoordinator, "runExclusive"> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(inner: LeanVerifier, options: SerialLeanVerifierOptions = {}) {
    this.#inner = inner;
    this.#maxPending = options.maxPending ?? 8;
    this.#coordinator = options.coordinator;
  }

  verify(code: string, options: VerifyOptions): Promise<VerificationResult> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new Error("Lean verification queue is full"));
    }

    this.#pending += 1;
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = started + timeoutMs;
    const executeVerification = () => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return Promise.resolve({
          ok: false,
          status: "timeout",
          command: "queued Lean verification",
          durationMs: Date.now() - started,
          output: `Lean verification timed out after ${timeoutMs} ms while waiting in the queue.`,
          diagnostics: [],
        } satisfies VerificationResult);
      }
      return this.#inner.verify(code, { ...options, timeoutMs: remainingMs });
    };
    const run = this.#tail.then(() =>
      this.#coordinator
        ? this.#coordinator.runExclusive("lean", executeVerification)
        : executeVerification(),
    );
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.#pending -= 1;
    });
  }
}
