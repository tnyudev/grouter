import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/proxy/server.ts";

let server: Bun.Server<unknown> | null = null;
let baseUrl = "";

beforeAll(() => {
  server = startServer(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  server = null;
});

describe("server CORS preflight", () => {
  test("returns 204 + CORS headers for known API route without explicit OPTIONS handler", async () => {
    const res = await fetch(`${baseUrl}/api/status`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });

  test("returns 204 + CORS headers for unknown route OPTIONS request", async () => {
    const res = await fetch(`${baseUrl}/__unknown__`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
