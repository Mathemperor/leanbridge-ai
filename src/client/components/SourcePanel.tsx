import { useRef, type DragEvent, type FormEvent } from "react";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES, type ProofMode } from "@shared/proof";

interface SourcePanelProps {
  mode: ProofMode;
  latex: string;
  imageDataUrl: string;
  imageName: string;
  context: string;
  projectPath: string;
  autoRepair: boolean;
  busy: boolean;
  cloudMode: boolean;
  onModeChange(mode: ProofMode): void;
  onLatexChange(value: string): void;
  onImageChange(dataUrl: string, name: string): void;
  onContextChange(value: string): void;
  onProjectPathChange(value: string): void;
  onAutoRepairChange(value: boolean): void;
  onInputError(message: string): void;
  onSubmit(): void;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取该图片"));
    reader.readAsDataURL(file);
  });
}

export function SourcePanel(props: SourcePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      props.onInputError("仅支持 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      props.onInputError("图片不能超过 10 MiB");
      return;
    }
    try {
      props.onImageChange(await readAsDataUrl(file), file.name);
    } catch (error) {
      props.onInputError(error instanceof Error ? error.message : "无法读取该图片");
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void selectFile(event.dataTransfer.files[0]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };

  return (
    <section className="panel source-panel" aria-labelledby="source-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">01 · SOURCE</span>
          <h2 id="source-title">原始证明</h2>
        </div>
        <span className="panel-kicker">输入</span>
      </div>

      <form onSubmit={submit}>
        <div className="mode-tabs" role="tablist" aria-label="证明输入格式">
          <button
            type="button"
            role="tab"
            aria-selected={props.mode === "latex"}
            className={props.mode === "latex" ? "active" : ""}
            onClick={() => props.onModeChange("latex")}
          >
            <span className="tab-icon" aria-hidden="true">TeX</span>
            LaTeX / 文字
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.mode === "image"}
            className={props.mode === "image" ? "active" : ""}
            onClick={() => props.onModeChange("image")}
          >
            <span className="tab-icon" aria-hidden="true">⌁</span>
            手写图片
          </button>
        </div>

        {props.mode === "latex" ? (
          <div className="field-stack">
            <label htmlFor="latex-proof">LaTeX 证明</label>
            <textarea
              id="latex-proof"
              className="source-textarea"
              value={props.latex}
              onChange={(event) => props.onLatexChange(event.target.value)}
              placeholder={"例如：设 $n\\in\\mathbb{N}$，证明 $n+0=n$。\n\n\\begin{proof}\n由自然数加法单位元可得……\n\\end{proof}"}
              spellCheck={false}
            />
            <div className="field-meta">
              <span>支持 LaTeX、中文或英文自然语言</span>
              <button
                type="button"
                className="text-button"
                onClick={() => props.onLatexChange("设 a, b 为自然数，证明 a + b = b + a。")}
              >
                填入示例
              </button>
            </div>
          </div>
        ) : (
          <div className="field-stack">
            <label htmlFor="proof-image">上传手写证明图片</label>
            <div
              className={`drop-zone ${props.imageDataUrl ? "has-image" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
            >
              <input
                ref={fileInput}
                id="proof-image"
                className="visually-hidden"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void selectFile(event.target.files?.[0])}
              />
              {props.imageDataUrl ? (
                <>
                  <img src={props.imageDataUrl} alt="待识别的手写证明预览" />
                  <div>
                    <strong>{props.imageName}</strong>
                    <span>点击或拖入新图片以替换</span>
                  </div>
                </>
              ) : (
                <>
                  <span className="upload-mark" aria-hidden="true">＋</span>
                  <strong>拖入证明图片</strong>
                  <span>或点击选择 · 最大 10 MiB</span>
                </>
              )}
            </div>
            <label htmlFor="image-context">补充背景（可选）</label>
            <textarea
              id="image-context"
              className="context-textarea"
              value={props.context}
              onChange={(event) => props.onContextChange(event.target.value)}
              placeholder="例如：这是群论中的拉格朗日定理，符号 G/H 表示商群。"
            />
          </div>
        )}

        <div className="settings-block">
          <div className="settings-title">
            <span>Lean 环境</span>
            <span className="settings-rule" />
          </div>
          {props.cloudMode ? (
            <p className="cloud-environment-note">云端使用固定的 Lean 4 / mathlib 环境</p>
          ) : (
            <>
              <label htmlFor="project-path">Lean / mathlib 工程路径</label>
              <div className="path-input-wrap">
                <span aria-hidden="true">⌘</span>
                <input
                  id="project-path"
                  value={props.projectPath}
                  onChange={(event) => props.onProjectPathChange(event.target.value)}
                  placeholder="使用服务端 LEAN_PROJECT_PATH"
                />
              </div>
            </>
          )}
          <label className="switch-row">
            <span>
              <strong>编译失败后自动修复</strong>
              <small>把 Lean 诊断反馈给模型，最多执行配置的修复次数</small>
            </span>
            <input
              type="checkbox"
              checked={props.autoRepair}
              onChange={(event) => props.onAutoRepairChange(event.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        </div>

        <button className="primary-button" type="submit" disabled={props.busy}>
          <span>{props.busy ? "形式化处理中" : "生成并验证"}</span>
          <span className="button-arrow" aria-hidden="true">→</span>
        </button>
      </form>
    </section>
  );
}
