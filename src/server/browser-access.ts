import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { backendAuth } from "./backend-auth";

const COOKIE = "leanbridge_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_LOGIN_CLIENTS = 1024;

function isLoopback(request: Request): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(request.hostname.toLowerCase());
}

function sameOriginWrite(request: Request): boolean {
  if (request.header("X-LeanBridge-Request") !== "browser") return false;
  try {
    const origin = new URL(request.header("Origin") ?? "");
    return origin.host === request.get("host") &&
      (origin.protocol === "https:" || (origin.protocol === "http:" && isLoopback(request)));
  } catch {
    return false;
  }
}

function sessionId(request: Request): string {
  return (request.header("cookie") ?? "").split(";")
    .map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
}

export function browserAccess(options: { backendToken?: string; accessPassword?: string }): Router {
  const router = Router();
  const required = Boolean(options.backendToken || options.accessPassword);
  const passwordHash = options.accessPassword
    ? createHash("sha256").update(options.accessPassword).digest() : undefined;
  const bearerAuth = options.backendToken ? backendAuth(options.backendToken) : undefined;
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const authenticated = (request: Request) => {
    const id = sessionId(request);
    const expires = sessions.get(id);
    if (!expires) return false;
    if (expires <= Date.now()) { sessions.delete(id); return false; }
    return true;
  };
  const cookieOptions = (request: Request) => ({
    httpOnly: true, sameSite: "strict" as const, secure: !isLoopback(request), path: "/api",
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  router.get("/session", (request, response) => {
    response.json({ required, available: Boolean(passwordHash), authenticated: !required || authenticated(request) });
  });
  router.post("/session", (request, response) => {
    if (!sameOriginWrite(request)) { response.status(403).json({ error: "请从本站登录 / Use this site's login page" }); return; }
    if (!passwordHash) { response.status(503).json({ error: "网页访问尚未配置 / Browser access is not configured" }); return; }
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    const client = request.ip ?? "unknown";
    const attempts = failures.get(client);
    if ((attempts?.count ?? 0) >= 10 || (!attempts && failures.size >= MAX_LOGIN_CLIENTS)) {
      response.set("Retry-After", String(Math.max(1, Math.ceil(((attempts?.until ?? now + LOGIN_WINDOW_MS) - now) / 1000))));
      response.status(429).json({ error: "尝试次数过多，请稍后重试 / Too many attempts; try later" });
      return;
    }
    const password: unknown = request.body?.password;
    if (typeof password !== "string" || password.length > 256 ||
      !timingSafeEqual(createHash("sha256").update(password).digest(), passwordHash)) {
      failures.set(client, { count: (attempts?.count ?? 0) + 1, until: attempts?.until ?? now + LOGIN_WINDOW_MS });
      response.status(401).json({ error: "访问密码不正确 / Incorrect access password" });
      return;
    }
    failures.delete(client);
    sessions.delete(sessionId(request));
    for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, now + SESSION_MS);
    response.cookie(COOKIE, id, { ...cookieOptions(request), maxAge: SESSION_MS });
    response.json({ required, available: true, authenticated: true });
  });
  router.delete("/session", (request, response) => {
    if (!sameOriginWrite(request)) { response.status(403).json({ error: "请从本站退出 / Use this site's logout button" }); return; }
    sessions.delete(sessionId(request));
    response.clearCookie(COOKIE, cookieOptions(request));
    response.json({ ok: true });
  });
  router.use((request, response, next) => {
    if (!required) { next(); return; }
    if (request.header("authorization") && bearerAuth) { bearerAuth(request, response, next); return; }
    if (!authenticated(request)) { response.status(401).json({ error: "请先登录 / Sign in to continue" }); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOriginWrite(request)) {
      response.status(403).json({ error: "请求来源无效 / Invalid request origin" }); return;
    }
    next();
  });
  return router;
}
