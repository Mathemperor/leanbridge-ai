import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function backendAuth(expectedToken: string): RequestHandler {
  const expected = Buffer.from(expectedToken);
  return (request, response, next) => {
    const value = request.header("authorization") ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.status(401).json({ error: "后端认证失败" });
      return;
    }
    next();
  };
}
