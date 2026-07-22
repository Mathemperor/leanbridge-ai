import { useEffect, useState } from "react";
import type { ProofJob, ProofMode, ProofRequest } from "@shared/proof";
import { browserApi, type ClientRuntimeConfig, type LeanBridgeApi } from "./api";
import { SourcePanel } from "./components/SourcePanel";
import { LeanEditor } from "./components/LeanEditor";
import { VerificationPanel } from "./components/VerificationPanel";
import "./styles.css";

interface AppProps {
  api?: LeanBridgeApi;
  pollIntervalMs?: number;
}

const terminalStatuses = new Set(["verified", "failed"]);

export function App({ api = browserApi, pollIntervalMs = 850 }: AppProps) {
  const [config, setConfig] = useState<ClientRuntimeConfig>();
  const [mode, setMode] = useState<ProofMode>("latex");
  const [latex, setLatex] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [imageName, setImageName] = useState("");
  const [context, setContext] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [autoRepair, setAutoRepair] = useState(true);
  const [job, setJob] = useState<ProofJob>();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.getConfig()
      .then((value) => { if (active) setConfig(value); })
      .catch(() => { if (active) setError("无法读取服务端配置"); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!job || terminalStatuses.has(job.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.getProof(job.id)
        .then((next) => { if (active) setJob(next); })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : "无法更新任务状态");
        });
    }, pollIntervalMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, job, pollIntervalMs]);

  useEffect(() => {
    if (job?.translation?.leanCode) setCode(job.translation.leanCode);
    if (job && terminalStatuses.has(job.status)) setSubmitting(false);
  }, [job]);

  const submit = async () => {
    setError("");
    if (mode === "latex" && !latex.trim()) {
      setError("请输入 LaTeX 或文字证明");
      return;
    }
    if (mode === "image" && !imageDataUrl) {
      setError("请先上传手写证明图片");
      return;
    }

    const cloudMode = config?.lean.mode === "cloud";
    const common = {
      autoRepair,
      ...(!cloudMode && projectPath.trim() ? { projectPath: projectPath.trim() } : {}),
    };
    const request: ProofRequest = mode === "latex"
      ? { mode, latex: latex.trim(), ...common }
      : { mode, imageDataUrl, ...(context.trim() ? { context: context.trim() } : {}), ...common };
    setSubmitting(true);
    setCode("");
    try {
      setJob(await api.createProof(request));
    } catch (reason) {
      setSubmitting(false);
      setError(reason instanceof Error ? reason.message : "无法创建证明任务");
    }
  };

  const reverify = async () => {
    if (!job) return;
    setError("");
    setSubmitting(true);
    try {
      setJob(await api.reverify(job.id, code));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法重新验证");
    } finally {
      setSubmitting(false);
    }
  };

  const providerLabel = config?.provider === "demo" ? "演示模式" : config ? "OpenAI 已连接" : "连接中";
  const leanLabel = config?.lean.mode === "demo"
    ? "Lean 模拟验证"
    : config?.lean.mode === "cloud"
      ? "云端 Lean 已就绪"
      : config?.lean.projectConfigured ? "Lean 工程已配置" : "使用输入路径";

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="LeanBridge AI 首页">
          <span className="brand-mark">λ</span>
          <span><strong>LeanBridge</strong><small>AI PROOF WORKBENCH</small></span>
        </a>
        <div className="runtime-status" aria-label="运行时状态">
          <span><i className={`runtime-light ${config?.provider ?? "loading"}`} />{providerLabel}</span>
          <span>{config?.model ?? "gpt-5.6"} · {config?.reasoningEffort ?? "high"}</span>
          <span>{leanLabel}</span>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div>
            <span className="hero-index">FORMAL MATHEMATICS · LEAN 4</span>
            <h1>把证明交给 Lean，<br />而不是交给运气。</h1>
          </div>
          <p>
            从手写推导或 LaTeX 出发，经 AI 形式化、Lean 内核验证与诊断修复，
            得到一份可以编译、可以编辑、也可以追溯的证明。
          </p>
        </section>

        {error ? (
          <div className="error-banner" role="alert">
            <span aria-hidden="true">!</span>
            <p>{error}</p>
            <button type="button" onClick={() => setError("")} aria-label="关闭错误提示">×</button>
          </div>
        ) : null}

        <div className="workbench-grid">
          <SourcePanel
            mode={mode}
            latex={latex}
            imageDataUrl={imageDataUrl}
            imageName={imageName}
            context={context}
            projectPath={projectPath}
            autoRepair={autoRepair}
            busy={submitting}
            cloudMode={config?.lean.mode === "cloud"}
            onModeChange={setMode}
            onLatexChange={setLatex}
            onImageChange={(dataUrl, name) => { setImageDataUrl(dataUrl); setImageName(name); setError(""); }}
            onContextChange={setContext}
            onProjectPathChange={setProjectPath}
            onAutoRepairChange={setAutoRepair}
            onInputError={setError}
            onSubmit={() => void submit()}
          />
          <LeanEditor
            code={code}
            busy={submitting}
            hasJob={Boolean(job)}
            onCodeChange={setCode}
            onReverify={() => void reverify()}
          />
          <VerificationPanel job={job} />
        </div>
      </main>

      <footer>
        <span>LEANBRIDGE / LOCAL-FIRST FORMALIZATION</span>
        <span>模型提出证明 · Lean 决定证明是否成立</span>
      </footer>
    </div>
  );
}
