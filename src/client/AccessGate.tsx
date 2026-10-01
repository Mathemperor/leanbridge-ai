import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { requestJson } from "./api";
export interface SessionState { required: boolean; available: boolean; authenticated: boolean }
export interface SessionApi { state(): Promise<SessionState>; login(password: string): Promise<SessionState>; logout(): Promise<unknown> }
const browserSessionApi: SessionApi = {
  state: () => requestJson<SessionState>("/api/session"),
  login: (password) => requestJson<SessionState>("/api/session", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => requestJson("/api/session", { method: "DELETE" }),
};

export function AccessGate({ children, api = browserSessionApi }: { children: ReactNode; api?: SessionApi }) {
  const [session, setSession] = useState<SessionState>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.state().then((state) => { if (active) setSession(state); })
      .catch(() => { if (active) setError("连接失败，请刷新重试 / Connection failed; reload to retry"); });
    const expired = () => {
      setSession((state) => state ? { ...state, authenticated: false } : state);
      setPassword("");
      setError("会话已过期，请重新登录 / Session expired; sign in again");
    };
    window.addEventListener("leanbridge:session-expired", expired);
    return () => { active = false; window.removeEventListener("leanbridge:session-expired", expired); };
  }, [api]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try { setSession(await api.login(password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败 / Sign-in failed"); }
    finally { setPassword(""); setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError("");
    try { await api.logout(); setSession((state) => state ? { ...state, authenticated: false } : state); }
    catch { setError("退出失败，请重试 / Sign-out failed; try again"); }
    finally { setBusy(false); }
  };

  if (session?.authenticated) return <>
    {session.required ? <div className="session-bar"><span>共享演示工作台 / Shared demo workspace</span><button type="button" disabled={busy} onClick={() => void logout()}>退出 / Sign out</button></div> : null}
    {error ? <p className="access-error" role="alert">{error}</p> : null}
    {children}
  </>;
  return <main className="access-shell"><section className="access-card">
    <span className="eyebrow">LEANBRIDGE AI · PROOF WORKBENCH</span>
    <h1>进入证明工作台<br /><small>Sign in to LeanBridge</small></h1>
    {error ? <p className="access-error" role="alert">{error}</p> : null}
    {!session ? <p>正在连接 / Connecting…</p> : session.available ? <form onSubmit={(event) => void login(event)}>
      <p>使用作品提供的访问密码。<br />Use the access password supplied with this demo.</p>
      <label htmlFor="access-password">访问密码 / Access password</label>
      <input id="access-password" type="password" value={password} autoComplete="current-password" maxLength={256} required onChange={(event) => setPassword(event.target.value)} />
      <button className="primary-button" type="submit" disabled={busy || !password}>{busy ? "连接中 / Signing in…" : "进入工作台 / Sign in"}</button>
      <small>仅供受邀体验者使用；工作台内的证明记录由体验者共享。<br />For invited reviewers; proof history is shared within this workspace.</small>
    </form> : <p role="alert">网页访问尚未配置，请联系作品维护者。<br />Browser access is not configured. Contact the project owner.</p>}
  </section></main>;
}
