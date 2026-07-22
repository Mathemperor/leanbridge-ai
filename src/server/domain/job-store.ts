import { randomUUID } from "node:crypto";
import type {
  ProofAttempt,
  ProofEvent,
  ProofJob,
  ProofJobStatus,
  ProofRequest,
  Translation,
  VerificationResult,
} from "@shared/proof";

const MAX_RETAINED_ATTEMPTS = 4;
const MAX_RETAINED_EVENTS = 64;

export interface StoredProofJob extends ProofJob {
  request: ProofRequest;
}

function now(): string {
  return new Date().toISOString();
}

function publicSnapshot(job: StoredProofJob): ProofJob {
  const { request: _request, ...visible } = job;
  return structuredClone(visible);
}

export interface InMemoryJobStoreOptions {
  maxJobs?: number;
  terminalTtlMs?: number;
}

export class JobStoreCapacityError extends Error {
  constructor() {
    super("LeanBridge job store is at capacity");
    this.name = "JobStoreCapacityError";
  }
}

export class InMemoryJobStore {
  readonly #jobs = new Map<string, StoredProofJob>();
  readonly #maxJobs: number;
  readonly #terminalTtlMs: number;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.#maxJobs = options.maxJobs ?? 8;
    this.#terminalTtlMs = options.terminalTtlMs ?? 60 * 60 * 1_000;
  }

  create(request: ProofRequest): ProofJob {
    this.#pruneTerminalJobs();
    if (this.#jobs.size >= this.#maxJobs) {
      let oldestTerminal: StoredProofJob | undefined;
      for (const job of this.#jobs.values()) {
        if (job.status === "verified" || job.status === "failed") {
          oldestTerminal = job;
          break;
        }
      }
      if (!oldestTerminal) throw new JobStoreCapacityError();
      this.#jobs.delete(oldestTerminal.id);
    }
    const createdAt = now();
    const job: StoredProofJob = {
      id: randomUUID(),
      mode: request.mode,
      request: structuredClone(request),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      events: [{ at: createdAt, status: "queued", label: "任务已进入队列" }],
      attempts: [],
    };
    this.#jobs.set(job.id, job);
    return publicSnapshot(job);
  }

  get(id: string): ProofJob | undefined {
    this.#pruneTerminalJobs();
    const job = this.#jobs.get(id);
    return job ? publicSnapshot(job) : undefined;
  }

  getStored(id: string): StoredProofJob | undefined {
    this.#pruneTerminalJobs();
    return this.#jobs.get(id);
  }

  releaseLargeInput(id: string): void {
    const job = this.#require(id);
    if (job.request.mode === "image") {
      job.request.imageDataUrl = "data:image/png;base64,";
      job.updatedAt = now();
    }
  }

  transition(id: string, status: ProofJobStatus, label: string, detail?: string): ProofJob {
    const job = this.#require(id);
    const at = now();
    const event: ProofEvent = { at, status, label, ...(detail ? { detail } : {}) };
    job.status = status;
    job.updatedAt = at;
    job.events.push(event);
    if (job.events.length > MAX_RETAINED_EVENTS) {
      job.events.splice(0, job.events.length - MAX_RETAINED_EVENTS);
    }
    return publicSnapshot(job);
  }

  recordTranslation(id: string, translation: Translation, kind: ProofAttempt["kind"]): ProofJob {
    const job = this.#require(id);
    const attempt: ProofAttempt = {
      number: (job.attempts.at(-1)?.number ?? 0) + 1,
      kind,
      translation: structuredClone(translation),
    };
    job.translation = structuredClone(translation);
    job.attempts.push(attempt);
    if (job.attempts.length > MAX_RETAINED_ATTEMPTS) {
      job.attempts.splice(0, job.attempts.length - MAX_RETAINED_ATTEMPTS);
    }
    job.updatedAt = now();
    return publicSnapshot(job);
  }

  recordVerification(id: string, verification: VerificationResult): ProofJob {
    const job = this.#require(id);
    const attempt = job.attempts.at(-1);
    if (!attempt) throw new Error("Cannot record verification without a translation attempt");
    attempt.verification = structuredClone(verification);
    job.verification = structuredClone(verification);
    job.updatedAt = now();
    return publicSnapshot(job);
  }

  finish(id: string, status: "verified" | "failed"): ProofJob {
    return this.transition(
      id,
      status,
      status === "verified" ? "Lean 验证通过" : "已保留未通过的最新代码",
    );
  }

  fail(id: string, message: string): ProofJob {
    const job = this.#require(id);
    job.error = message;
    return this.transition(id, "failed", "任务失败", message);
  }

  #require(id: string): StoredProofJob {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`Unknown proof job: ${id}`);
    return job;
  }

  #pruneTerminalJobs(): void {
    const cutoff = Date.now() - this.#terminalTtlMs;
    for (const [id, job] of this.#jobs) {
      if ((job.status === "verified" || job.status === "failed") && Date.parse(job.updatedAt) < cutoff) {
        this.#jobs.delete(id);
      }
    }
  }
}
