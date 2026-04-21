import chalk from "chalk";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { listAccounts } from "../db/accounts.ts";
import { getSetting } from "../db/index.ts";
import { getProviderPort, listProviderPorts } from "../db/ports.ts";
import { getModelsForProvider } from "../providers/model-fetcher.ts";
import { CURRENT_VERSION, fetchAndCacheVersion } from "../update/checker.ts";
import {
  handleAccountRemove,
  handleAccountToggle,
  handleAddConnection,
  handleAuthAuthorize,
  handleAuthCallback,
  handleAuthImport,
  handleAuthPoll,
  handleAuthStart,
  handleCreateClientKey,
  handleCreateCustomProvider,
  handleCreateProxyPool,
  handleDeleteClientKey,
  handleDeleteProxyPool,
  handleGetConfig,
  handleGetProviderConnections,
  handleGetProviderModels,
  handleGetProviders,
  handleListClientKeys,
  handleListProxyPools,
  handleProviderConfig,
  handleProxyStop,
  handleRefreshProviderModels,
  handleRefreshProviderModelsBatch,
  handleSetConfig,
  handleSetupDone,
  handleSetupStatus,
  handleStatus,
  handleTestProxyPool,
  handleUnlockAll,
  handleUpdateClientKey,
  handleUpdateConnection,
  handleUpdateProxyPool,
} from "../web/api.ts";
import { serveLogo } from "../web/logos.ts";
import { handleChatCompletions } from "./chat-handler.ts";
import { clearModelsCache, fetchModels } from "./models.ts";
import { SERVER_IDLE_TIMEOUT_SECONDS, corsHeaders, jsonResponse } from "./server-helpers.ts";
import type { BunRequest } from "./server-helpers.ts";

// HTML pages and static assets embedded at build time.
// @ts-ignore
import ANIMATION_JS from "../public/animation.js" with { type: "text" };
// @ts-ignore
import DASHBOARD_HTML from "../web/dashboard.html" with { type: "text" };
// @ts-ignore
import WIZARD_HTML from "../web/wizard.html" with { type: "text" };

function serveWizard(): Response {
  return new Response(WIZARD_HTML as unknown as string, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function serveDashboard(): Response {
  return new Response(DASHBOARD_HTML as unknown as string, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const ANIMATION_TEXT = ANIMATION_JS as unknown as string;
const ANIMATION_BYTES = Buffer.from(ANIMATION_TEXT, "utf8");
const ANIMATION_GZIP_BYTES = gzipSync(ANIMATION_BYTES, { level: 9 });
const ANIMATION_ETAG = `"${createHash("sha1").update(ANIMATION_BYTES).digest("hex")}"`;

function hasMatchingEtag(req: Request, etag: string): boolean {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === "*");
}

function serveAnimation(req: Request): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
    ETag: ANIMATION_ETAG,
    Vary: "Accept-Encoding",
  };
  if (hasMatchingEtag(req, ANIMATION_ETAG)) {
    return new Response(null, { status: 304, headers });
  }
  const acceptEncoding = req.headers.get("accept-encoding") ?? "";
  if (acceptEncoding.includes("gzip")) {
    return new Response(ANIMATION_GZIP_BYTES, {
      headers: { ...headers, "Content-Encoding": "gzip" },
    });
  }
  return new Response(ANIMATION_BYTES, { headers });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export { clearModelsCache };

export function startServer(port: number) {
  return Bun.serve({
    port,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    routes: {
      // Dashboard.
      "/": {
        GET: () => {
          if (getSetting("setup_done") === "1") {
            return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
          }
          return serveWizard();
        },
      },
      "/setup": { GET: () => serveWizard() },
      "/public/animation.js": {
        GET: (req: Request) => serveAnimation(req),
      },
      "/public/logos/:file": {
        GET: (req: BunRequest) => serveLogo(req.params.file!, req),
      },
      "/dashboard": { GET: () => serveDashboard() },

      // Dashboard API.
      "/api/status": { GET: () => handleStatus(), OPTIONS: preflight },
      "/api/auth/start": { POST: (req: Request) => handleAuthStart(req), OPTIONS: preflight },
      "/api/auth/poll": { POST: (req: Request) => handleAuthPoll(req), OPTIONS: preflight },
      "/api/auth/authorize": { POST: (req: Request) => handleAuthAuthorize(req), OPTIONS: preflight },
      "/api/auth/callback": { GET: (req: Request) => handleAuthCallback(req), OPTIONS: preflight },
      "/api/auth/import": { POST: (req: Request) => handleAuthImport(req), OPTIONS: preflight },
      "/api/accounts/:id/toggle": { POST: (req: BunRequest) => handleAccountToggle(req.params.id!), OPTIONS: preflight },
      "/api/accounts/:id": { DELETE: (req: BunRequest) => handleAccountRemove(req.params.id!), OPTIONS: preflight },
      "/api/setup-status": { GET: () => handleSetupStatus(), OPTIONS: preflight },
      "/api/setup-done": { POST: () => handleSetupDone(), OPTIONS: preflight },
      "/api/client-keys": {
        GET: () => handleListClientKeys(),
        POST: (req: Request) => handleCreateClientKey(req),
        OPTIONS: preflight,
      },
      "/api/client-keys/:key": {
        PATCH: (req: BunRequest) => handleUpdateClientKey(req, req.params.key!),
        DELETE: (req: BunRequest) => handleDeleteClientKey(req.params.key!),
        OPTIONS: preflight,
      },
      "/api/config": {
        GET: () => handleGetConfig(),
        POST: (req: Request) => handleSetConfig(req),
        OPTIONS: preflight,
      },
      "/api/unlock": { POST: () => handleUnlockAll(), OPTIONS: preflight },
      "/api/providers": { GET: () => handleGetProviders(), OPTIONS: preflight },
      "/api/providers/custom": { POST: (req: Request) => handleCreateCustomProvider(req), OPTIONS: preflight },
      "/api/providers/:id/connections": { GET: (req: BunRequest) => handleGetProviderConnections(req.params.id!), OPTIONS: preflight },
      "/api/providers/:id/models": { GET: (req: BunRequest) => handleGetProviderModels(req.params.id!), OPTIONS: preflight },
      "/api/providers/:id/refresh-models": { POST: (req: BunRequest) => handleRefreshProviderModels(req.params.id!), OPTIONS: preflight },
      "/api/providers/refresh-models": { POST: (req: Request) => handleRefreshProviderModelsBatch(req), OPTIONS: preflight },
      "/api/providers/:id/config": { POST: (req: BunRequest) => handleProviderConfig(req.params.id!, req), OPTIONS: preflight },
      "/api/providers/:id/wake": {
        POST: (req: BunRequest) => {
          const id = req.params.id!;
          ensureProviderServer(id);
          const providerPort = getProviderPort(id);
          return jsonResponse({ ok: true, provider: id, port: providerPort });
        },
        OPTIONS: preflight,
      },
      "/api/connections": { POST: (req: Request) => handleAddConnection(req), OPTIONS: preflight },
      "/api/proxy-pools": {
        GET: () => handleListProxyPools(),
        POST: (req: Request) => handleCreateProxyPool(req),
        OPTIONS: preflight,
      },
      "/api/proxy-pools/:id": {
        PATCH: (req: BunRequest) => handleUpdateProxyPool(req.params.id!, req),
        DELETE: (req: BunRequest) => handleDeleteProxyPool(req.params.id!),
        OPTIONS: preflight,
      },
      "/api/proxy-pools/:id/test": { POST: (req: BunRequest) => handleTestProxyPool(req.params.id!), OPTIONS: preflight },
      "/api/connections/:id": { PATCH: (req: BunRequest) => handleUpdateConnection(req.params.id!, req), OPTIONS: preflight },
      "/api/proxy/stop": { POST: () => handleProxyStop(), OPTIONS: preflight },

      // Proxy API.
      "/health": {
        GET: async () => {
          const accounts = listAccounts();
          const active = accounts.filter((account) => account.is_active && account.test_status !== "unavailable").length;
          return jsonResponse({ status: "ok", accounts: accounts.length, active });
        },
      },
      "/v1/models": {
        GET: async (req: Request) => jsonResponse({ object: "list", data: await fetchModels(req) }),
        OPTIONS: preflight,
      },
      "/api/version": {
        GET: async () => {
          const remote = await fetchAndCacheVersion();
          return jsonResponse({ current: CURRENT_VERSION, latest: remote ?? CURRENT_VERSION });
        },
        OPTIONS: preflight,
      },
      "/v1/chat/completions": {
        POST: (req: Request) => handleChatCompletions(req),
        OPTIONS: preflight,
      },
    },
    fetch(req) {
      if (req.method === "OPTIONS") return preflight();
      return jsonResponse({ error: { message: "Not found", type: "grouter_error", code: 404 } }, 404);
    },
  });
}

/**
 * Start a provider-pinned server on `port`. Requests to /v1/chat/completions
 * are forced to use `provider`, ignoring any provider prefix in the model name.
 */
export function startProviderServer(provider: string, port: number) {
  return Bun.serve({
    port,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    routes: {
      "/health": {
        GET: () => jsonResponse({ status: "ok", provider, port }),
      },
      "/v1/models": {
        GET: () => {
          const models = getModelsForProvider(provider);
          const freeOnly = getSetting(`provider_free_only_${provider}`) === "true";
          const data = models
            .filter((model) => (freeOnly ? model.is_free : true))
            .map((model) => ({ id: model.id, object: "model", created: 1720000000, owned_by: provider }));
          return jsonResponse({ object: "list", data });
        },
        OPTIONS: preflight,
      },
      "/v1/chat/completions": {
        POST: (req: Request) => handleChatCompletions(req, provider),
        OPTIONS: preflight,
      },
    },
    fetch(req) {
      if (req.method === "OPTIONS") return preflight();
      return jsonResponse({ error: { message: "Not found", type: "grouter_error", code: 404 } }, 404);
    },
  });
}

// Track which providers already have a running dedicated server.
const runningProviderServers = new Set<string>();

/**
 * Start a provider server only if one isn't already running.
 * Safe to call at any time, e.g. right after a new connection is added.
 */
export function ensureProviderServer(provider: string): void {
  if (runningProviderServers.has(provider)) return;
  const port = getProviderPort(provider);
  if (!port) return;
  try {
    startProviderServer(provider, port);
    runningProviderServers.add(provider);
  } catch (err) {
    console.error(`  ${chalk.yellow("WARN")} Failed to bind ${provider} on :${port} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Starts the main server plus one dedicated listener per configured provider port. */
export function startAllServers(mainPort: number) {
  const main = startServer(mainPort);
  const providerServers = [] as Array<{ provider: string; port: number }>;
  for (const row of listProviderPorts()) {
    try {
      startProviderServer(row.provider, row.port);
      runningProviderServers.add(row.provider);
      providerServers.push({ provider: row.provider, port: row.port });
    } catch (err) {
      console.error(`  ${chalk.yellow("WARN")} Failed to bind ${row.provider} on :${row.port} - ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { main, providerServers };
}
