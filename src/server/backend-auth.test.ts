import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { backendAuth } from "./backend-auth";

describe("backendAuth", () => {
  function makeApp() {
    const app = express();
    app.use(backendAuth("correct-token"));
    app.get("/protected", (_request, response) => response.json({ ok: true }));
    return app;
  }

  it("rejects missing and incorrect bearer tokens", async () => {
    expect((await request(makeApp()).get("/protected")).status).toBe(401);
    expect((await request(makeApp()).get("/protected").set("Authorization", "Bearer wrong-token")).status).toBe(401);
  });

  it("accepts the exact bearer token", async () => {
    const response = await request(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer correct-token");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
