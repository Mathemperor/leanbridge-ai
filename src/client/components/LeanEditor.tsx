interface LeanEditorProps {
  code: string;
  busy: boolean;
  hasJob: boolean;
  onCodeChange(value: string): void;
  onReverify(): void;
}

function downloadLean(code: string) {
  const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "LeanBridgeProof.lean";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LeanEditor(props: LeanEditorProps) {
  const copy = async () => {
    if (navigator.clipboard) await navigator.clipboard.writeText(props.code);
  };

  return (
    <section className="panel editor-panel" aria-labelledby="editor-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">02 · FORMALIZATION</span>
          <h2 id="editor-title">Lean 4 证明</h2>
        </div>
        <div className="editor-actions">
          <button type="button" onClick={() => void copy()} disabled={!props.code} aria-label="复制 Lean 代码">复制</button>
          <button type="button" onClick={() => downloadLean(props.code)} disabled={!props.code}>下载 .lean</button>
        </div>
      </div>

      <div className="code-shell">
        <div className="code-toolbar">
          <div className="traffic-lights" aria-hidden="true"><span /><span /><span /></div>
          <span>Main.lean</span>
          <span className="language-pill">LEAN 4</span>
        </div>
        <label className="visually-hidden" htmlFor="lean-code">Lean 4 代码</label>
        <textarea
          id="lean-code"
          className="code-editor"
          value={props.code}
          onChange={(event) => props.onCodeChange(event.target.value)}
          placeholder={"-- 生成的 Lean 4 代码会出现在这里\n\nimport Mathlib\n\ntheorem example : True := by\n  trivial"}
          spellCheck={false}
        />
        <div className="code-footer">
          <span>{props.code ? `${props.code.split("\n").length} 行 · ${props.code.length} 字符` : "等待形式化"}</span>
          <span>UTF-8</span>
        </div>
      </div>

      <div className="editor-bottom">
        <p>可直接编辑模型生成的代码，然后只运行 Lean 验证，不会再次调用模型。</p>
        <button
          type="button"
          className="secondary-button"
          disabled={!props.hasJob || !props.code || props.busy}
          onClick={props.onReverify}
        >
          重新验证
          <span aria-hidden="true">↻</span>
        </button>
      </div>
    </section>
  );
}
