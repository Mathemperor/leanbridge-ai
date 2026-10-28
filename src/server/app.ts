import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import { proofRequestSchema } from "@shared/proof";
import { resolveCodexSettings } from "@shared/codex-options";
import type { ProofPipeline } from "./domain/proof-pipeline";
import { ProofJobBusyError } from "./domain/proof-pipeline";
import type { LeanVerifier, VerifyOptions } from "./domain/ports";
import { JobStoreCapacityError } from "./domain/job-store";
import type { PublicRuntimeConfig } from "./config";
import { browserAccess } from "./browser-access";
import type { CodexSession } from "./adapters/model/codex-proof-model";
import type { ChatGPTPlanSession } from "./adapters/model/chatgpt-plan-session";

const manualVerificationSchema = z.object({
  code: z.string().trim().min(1, "Lean 代码不能为空").max(200_000),
});

export interface CreateAppOptions {
  pipeline: ProofPipeline;
  publicConfig: PublicRuntimeConfig;
  clientDirectory?: string;
  backendToken?: string;
  accessPassword?: string;
  cloudMode?: boolean;
  readinessVerifier?: LeanVerifier;
  readinessOptions?: VerifyOptions;
  readinessCacheTtlMs?: number;
  codexSession?: Pick<CodexSession, "status" | "startLogin">;
  subscriptionSession?: Pick<ChatGPTPlanSession, "inspectLogin" | "completeLogin">;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  if (options.subscriptionSession) {
    const router = express.Router();
    router.use(express.json({limit:"24kb"}));
    const fields={ticket:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),state:z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)};
    const inspectSchema=z.object(fields).strict();
    const callbackSchema=z.object({...fields,code:z.string().min(1).max(8192),clientId:z.string().regex(/^oaiapp_[A-Za-z0-9_-]{1,160}$/).optional()}).strict();
    router.post("/inspect",async(request,response)=>{
      response.set("Cache-Control","no-store");
      const input=inspectSchema.safeParse(request.body);
      if(!input.success){response.status(400).json({error:"授权入口无效"});return;}
      try{const result=await options.subscriptionSession!.inspectLogin(input.data);response.json({authorizationUrl:result.authorizationUrl});}
      catch{response.status(400).json({error:"授权入口已使用、无效或过期"});}
    });
    router.post("/callback",async(request,response)=>{
      response.set("Cache-Control","no-store");
      const input=callbackSchema.safeParse(request.body);
      if(!input.success){response.status(400).json({error:"授权回调无效"});return;}
      try{const result=await options.subscriptionSession!.completeLogin({ticket:input.data.ticket,state:input.data.state,code:input.data.code,...(input.data.clientId?{clientId:input.data.clientId}:{})});response.json({connected:result.connected,state:result.state,transport:"chatgpt-plan"});}
      catch{response.status(400).json({error:"授权未完成，请查看工作台中的订阅状态"});}
    });
    app.use("/api/subscription",router);
  }
  app.use(express.json({ limit: "15mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "leanbridge", timestamp: new Date().toISOString() });
  });

  app.use("/api", browserAccess(options));

  if (options.readinessVerifier) {
    let cachedReadyAt = 0;
    const readinessCacheTtlMs = options.readinessCacheTtlMs ?? 5 * 60 * 1_000;
    app.get("/api/ready", async (_request, response) => {
      if (cachedReadyAt > 0 && Date.now() - cachedReadyAt < readinessCacheTtlMs) {
        response.json({ ok: true, lean: "ready" });
        return;
      }
      try {
        const result = await options.readinessVerifier!.verify(
          "theorem leanBridgeReady : True := by\n  trivial",
          options.readinessOptions ?? {},
        );
        if (!result.ok) {
          response.status(503).json({
            ok: false,
            lean: "unavailable",
            diagnostic: {
              status: result.status,
              command: result.command,
              output: result.output.slice(0, 4_096),
            },
          });
          return;
        }
        cachedReadyAt = Date.now();
        response.json({ ok: true, lean: "ready" });
      } catch {
        response.status(503).json({ ok: false, lean: "unavailable" });
      }
    });
  }

  app.get("/api/config", (_request, response) => {
    response.json(options.publicConfig);
  });

  if (options.codexSession) {
    app.get("/api/codex/status", async (_request,response) => {response.set("Cache-Control","no-store").json(await options.codexSession!.status());});
    app.post("/api/codex/login", async (_request,response) => {response.set("Cache-Control","no-store").json(await options.codexSession!.startLogin());});
  }
  app.post("/api/proofs/manual", async (request,response) => {
    const parsed=manualVerificationSchema.safeParse(request.body);
    if(!parsed.success){response.status(400).json({error:"Lean 代码无效"});return;}
    try {
      const job=options.pipeline.startVerifyCode(parsed.data.code);
      setImmediate(()=>void options.pipeline.runVerification(job.id));
      response.status(202).json(job);
    }
    catch(error){response.status(error instanceof JobStoreCapacityError?429:400).json({error:error instanceof JobStoreCapacityError?"当前证明任务过多，请稍后重试":"代码包含不允许的命令或证明占位符"});}
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
    if (options.publicConfig.provider === "codex") {
      try { Object.assign(parsed.data, resolveCodexSettings(parsed.data, options.publicConfig)); }
      catch (error) { response.status(400).json({ error: (error as Error).message }); return; }
    } else if (parsed.data.model || parsed.data.reasoningEffort) {
      response.status(400).json({ error: "模型选择仅适用于 Codex 订阅模式。" }); return;
    }
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
      const job=options.pipeline.startReverify(request.params.id, parsed.data.code);
      setImmediate(()=>void options.pipeline.runVerification(job.id));
      response.status(202).json(job);
    } catch (error) {
      response.status(error instanceof ProofJobBusyError ? 409 : 400).json({ error: error instanceof Error ? error.message : "无法重新验证" });
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

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ error: request.path.startsWith("/api/subscription/") ? "授权数据超过限制" : "上传内容超过 15 MiB 限制" });
      return;
    }
    response.status(500).json({ error: "服务器处理请求时发生错误" });
  };
  app.use(errorHandler);

  return app;
}
