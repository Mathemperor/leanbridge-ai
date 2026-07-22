import type { ProofJob, ProofJobStatus } from "@shared/proof";

interface VerificationPanelProps {
  job: ProofJob | undefined;
}

const stageLabels: Array<{ statuses: ProofJobStatus[]; label: string }> = [
  { statuses: ["queued", "reading"], label: "读取证明" },
  { statuses: ["translating"], label: "构造形式化陈述" },
  { statuses: ["verifying"], label: "Lean 编译验证" },
  { statuses: ["repairing"], label: "诊断自动修复" },
  { statuses: ["verified"], label: "验证完成" },
];

function stageState(job: ProofJob | undefined, index: number): "done" | "active" | "waiting" | "failed" {
  if (!job) return "waiting";
  const activeIndex = stageLabels.findIndex(({ statuses }) => statuses.includes(job.status));
  if (job.status === "failed" && index === Math.min(job.events.length > 2 ? 3 : 1, 3)) return "failed";
  if (activeIndex === -1) return "waiting";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return job.status === "verified" ? "done" : "active";
  return "waiting";
}

export function VerificationPanel({ job }: VerificationPanelProps) {
  const diagnostics = job?.verification?.diagnostics ?? [];

  return (
    <section className="panel verification-panel" aria-labelledby="verification-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">03 · KERNEL CHECK</span>
          <h2 id="verification-title">验证轨迹</h2>
        </div>
        <span className={`status-dot ${job?.status ?? "idle"}`} aria-label={job?.status ?? "等待任务"} />
      </div>

      <div className="stage-list">
        {stageLabels.map((stage, index) => {
          const state = stageState(job, index);
          return (
            <div className={`stage ${state}`} key={stage.label}>
              <span className="stage-marker" aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
              <div>
                <strong>{stage.label}</strong>
                <span>{state === "done" ? "完成" : state === "active" ? "进行中…" : state === "failed" ? "未通过" : "等待"}</span>
              </div>
            </div>
          );
        })}
      </div>

      {job?.events.length ? (
        <div className="latest-event" aria-live="polite">
          <span className="pulse-ring" aria-hidden="true" />
          <div>
            <small>最新状态</small>
            <strong>{job.events.at(-1)?.label}</strong>
          </div>
        </div>
      ) : (
        <div className="empty-verification">
          <span aria-hidden="true">λ</span>
          <p>提交证明后，这里会显示每一步形式化与编译结果。</p>
        </div>
      )}

      {job?.verification ? (
        <div className={`compiler-card ${job.verification.ok ? "success" : "error"}`}>
          <div className="compiler-heading">
            <div>
              <span className="compiler-icon" aria-hidden="true">{job.verification.ok ? "✓" : "!"}</span>
              <strong>{job.verification.ok ? "内核接受此证明" : "Lean 返回编译诊断"}</strong>
            </div>
            <span>{job.verification.durationMs} ms</span>
          </div>
          <pre>{job.verification.output}</pre>
          {diagnostics.map((diagnostic, index) => (
            <div className={`diagnostic ${diagnostic.severity}`} key={`${diagnostic.line}-${index}`}>
              <span>{diagnostic.line ? `${diagnostic.line}:${diagnostic.column ?? 1}` : diagnostic.severity}</span>
              <p>{diagnostic.message}</p>
            </div>
          ))}
        </div>
      ) : null}

      {job?.attempts.length ? (
        <div className="attempt-summary">
          <span>尝试记录</span>
          <strong>{job.attempts.length}</strong>
          <span>次生成 / 编辑</span>
        </div>
      ) : null}
    </section>
  );
}
