import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import { proofRequestSchema } from "@shared/proof";
import type { ProofPipeline } from "./domain/proof-pipeline";
import type { LeanVerifier, VerifyOptions } from "./domain/ports";
import { JobStoreCapacityError } from "./domain/job-store";
import type { PublicRuntimeConfig } from "./config";
import { backendAuth } from "./backend-auth";

const manualVerificationSchema = z.object({
  code: z.string().trim().min(1, "Lean 代码不能为空").max(200_000),
});

export interface CreateAppOptions {
  pipeline: ProofPipeline;
  publicConfig: PublicRuntimeConfig;
  clientDirectory?: string;
  backendToken?: string;
  cloudMode?: boolean;
  readinessVerifier?: LeanVerifier;
  readinessOptions?: VerifyOptions;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "15mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "leanbridge", timestamp: new Date().toISOString() });
  });

  if (options.backendToken) app.use("/api", backendAuth(options.backendToken));

  if (options.readinessVerifier) {
    app.get("/api/ready", async (_request, response) => {
      try {
        const result = await options.readinessVerifier!.verify(
          "theorem leanBridgeReady : True := by\n  trivial",
          options.readinessOptions ?? {},
        );
        if (!result.ok) {
          response.status(503).json({ ok: false, lean: "unavailable" });
          return;
        }
        response.json({ ok: true, lean: "ready" });
      } catch {
        response.status(503).json({ ok: false, lean: "unavailable" });
      }
    });
  }

  app.get("/api/config", (_request, response) => {
    response.json(options.publicConfig);
  });

  app.post("/api/proofs", (request, response) => {
    const parsed = proofRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "输入内容无效",
        issues: z.flattenError(parsed.error).fieldErrors,
      });
      return;
    }
    if (options.cloudMode && parsed.data.projectPath) {
      response.status(400).json({ error: "云端模式不接受自定义 Lean 工程路径" });
      return;
    }

    let job;
    try {
      job = options.pipeline.start(parsed.data);
    } catch (error) {
      if (error instanceof JobStoreCapacityError) {
        response.status(429).json({ error: "当前证明任务过多，请稍后重试" });
        return;
      }
      throw error;
    }
    setImmediate(() => void options.pipeline.run(job.id));
    response.status(202).json(job);
  });

  app.get("/api/proofs/:id", (request, response) => {
    const job = options.pipeline.get(request.params.id);
    if (!job) {
      response.status(404).json({ error: "未找到该证明任务" });
      return;
    }
    response.json(job);
  });

  app.post("/api/proofs/:id/verify", async (request, response) => {
    if (!options.pipeline.get(request.params.id)) {
      response.status(404).json({ error: "未找到该证明任务" });
      return;
    }
    const parsed = manualVerificationSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Lean 代码无效", issues: z.flattenError(parsed.error).fieldErrors });
      return;
    }
    try {
      response.json(await options.pipeline.reverify(request.params.id, parsed.data.code));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法重新验证" });
    }
  });

  const clientDirectory = options.clientDirectory ? resolve(options.clientDirectory) : undefined;
  if (clientDirectory && existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory, { index: false }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api/")) {
        next();
        return;
      }
      response.sendFile(resolve(clientDirectory, "index.html"));
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ error: "上传内容超过 15 MiB 限制" });
      return;
    }
    response.status(500).json({ error: "服务器处理请求时发生错误" });
  };
  app.use(errorHandler);

  return app;
}
