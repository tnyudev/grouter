import { getAdapter } from "../auth/providers/index.ts";
import {
  addApiKeyConnection,
  getConnectionCountByProvider,
  listConnectionsByProvider,
} from "../db/accounts.ts";
import {
  createProxyPool,
  deleteProxyPool,
  getConnectionCountForPool,
  getProxyPoolById,
  listProxyPools,
  testProxyPool,
  updateProxyPool,
  type ProxyPoolPatch,
} from "../db/pools.ts";
import { getProviderPort } from "../db/ports.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { clearModelsCache, ensureProviderServer } from "../proxy/server.ts";
import { fetchAndSaveProviderModels, getModelsForProvider } from "../providers/model-fetcher.ts";
import {
  getProviderLock,
  getTopFreeProviderRank,
  providerHasFreeModelsById,
  PROVIDERS,
  saveCustomProvider,
  type Provider,
} from "../providers/registry.ts";
import { json } from "./api-http.ts";

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

export function handleGetProviders(): Response {
  const counts = getConnectionCountByProvider();
  const list = Object.values(PROVIDERS).map((provider) => {
    const adapter = getAdapter(provider.id);
    const models = getModelsForProvider(provider.id);
    const freeModelsCount = models.filter((model) => model.is_free).length;
    const totalModelsCount = models.length;
    const hasFreeModels = totalModelsCount > 0
      ? freeModelsCount > 0
      : providerHasFreeModelsById(provider.id);
    const topFreeRank = getTopFreeProviderRank(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      category: provider.category,
      authType: provider.authType,
      oauthFlow: adapter?.flow ?? null,
      color: provider.color,
      logo: provider.logo ?? null,
      apiKeyUrl: provider.apiKeyUrl ?? null,
      deprecated: provider.deprecated ?? false,
      deprecationReason: provider.deprecationReason ?? null,
      underConstruction: provider.underConstruction ?? false,
      underConstructionReason: provider.underConstructionReason ?? null,
      models: provider.models,
      connections: counts[provider.id] ?? 0,
      port: getProviderPort(provider.id),
      requiresMeta: provider.requiresMeta ?? null,
      freeTier: hasFreeModels ? (provider.freeTier ?? null) : null,
      hasFreeModels,
      freeModelsCount,
      totalModelsCount,
      topFreeRank,
    };
  });
  return json({ providers: list });
}

export function handleGetProviderConnections(id: string): Response {
  const provider = PROVIDERS[id];
  if (!provider) return json({ error: `Unknown provider: ${id}` }, 404);
  const connections = listConnectionsByProvider(id).map((connection) => ({
    id: connection.id,
    display_name: connection.display_name,
    email: connection.email,
    auth_type: connection.auth_type,
    api_key_mask: connection.api_key ? maskApiKey(connection.api_key) : null,
    is_active: connection.is_active,
    test_status: connection.test_status,
    priority: connection.priority,
    proxy_pool_id: connection.proxy_pool_id ?? null,
    created_at: connection.created_at,
  }));
  return json({
    provider: { id: provider.id, name: provider.name, color: provider.color, logo: provider.logo ?? null, port: getProviderPort(provider.id) },
    connections,
  });
}

export async function handleCreateCustomProvider(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { name?: string; url?: string };
    if (!body.name) return json({ error: "name is required" }, 400);
    if (!body.url) return json({ error: "url is required" }, 400);

    const safeId = "custom_" + crypto.randomUUID().slice(0, 8) + "_" + body.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const provider: Provider = {
      id: safeId,
      name: body.name,
      description: "Custom provider",
      category: "apikey",
      authType: "apikey",
      color: "#94a3b8",
      baseUrl: body.url,
      models: [{ id: "default", name: "Default" }],
    };

    saveCustomProvider(provider);
    return json(provider);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function handleAddConnection(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; display_name?: string };
    if (!body.provider) return json({ error: "provider is required" }, 400);
    if (!body.api_key) return json({ error: "api_key is required" }, 400);

    const provider = PROVIDERS[body.provider];
    if (!provider) return json({ error: `Unknown provider: ${body.provider}` }, 400);
    const addLock = getProviderLock(provider);
    if (addLock) return json({ error: addLock.reason }, addLock.kind === "deprecated" ? 410 : 503);
    if (provider.authType !== "apikey") return json({ error: "Use OAuth flow for this provider" }, 400);

    const connection = addApiKeyConnection({
      provider: body.provider,
      api_key: body.api_key.trim(),
      display_name: body.display_name ?? null,
    });
    const port = getProviderPort(body.provider);

    fetchAndSaveProviderModels(body.provider, body.api_key.trim()).catch(() => {});
    ensureProviderServer(body.provider);

    return json({ ok: true, connection, port });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export function handleGetProviderModels(id: string): Response {
  const provider = PROVIDERS[id];
  if (!provider) return json({ error: `Unknown provider: ${id}` }, 404);
  const models = getModelsForProvider(id);
  const freeOnly = getSetting(`provider_free_only_${id}`) === "true";
  return json({ provider: id, models, free_only: freeOnly });
}

export async function handleProviderConfig(id: string, req: Request): Promise<Response> {
  const provider = PROVIDERS[id];
  if (!provider) return json({ error: `Unknown provider: ${id}` }, 404);
  try {
    const body = (await req.json()) as { free_only?: boolean };
    if (typeof body.free_only === "boolean") {
      setSetting(`provider_free_only_${id}`, body.free_only ? "true" : "false");
      clearModelsCache();
    }
    return json({ ok: true, free_only: body.free_only });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function handleRefreshProviderModels(id: string): Promise<Response> {
  const provider = PROVIDERS[id];
  if (!provider) return json({ error: `Unknown provider: ${id}` }, 404);
  try {
    const result = await fetchAndSaveProviderModels(id);
    clearModelsCache();
    return json({ provider: id, models: result.models, source: result.source });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function handleRefreshProviderModelsBatch(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { providers?: string[] };
    const requested = Array.isArray(body.providers) ? body.providers : null;
    const targets = (requested && requested.length > 0 ? requested : Object.keys(PROVIDERS))
      .map((providerId) => providerId.trim().toLowerCase())
      .filter((providerId, idx, arr) => providerId.length > 0 && arr.indexOf(providerId) === idx);

    const results = await Promise.all(targets.map(async (providerId) => {
      if (!PROVIDERS[providerId]) {
        return { provider: providerId, ok: false, error: `Unknown provider: ${providerId}` };
      }
      try {
        const refreshed = await fetchAndSaveProviderModels(providerId);
        return {
          provider: providerId,
          ok: true,
          source: refreshed.source,
          model_count: refreshed.models.length,
        };
      } catch (err) {
        return { provider: providerId, ok: false, error: String(err) };
      }
    }));

    clearModelsCache();
    const success = results.filter((result) => result.ok).length;
    return json({
      ok: success === results.length,
      summary: { total: results.length, success, failed: results.length - success },
      results,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export function handleListProxyPools(): Response {
  const pools = listProxyPools().map((pool) => ({
    ...pool,
    connections: getConnectionCountForPool(pool.id),
  }));
  return json({ pools });
}

export async function handleCreateProxyPool(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { name?: string; proxy_url?: string; no_proxy?: string };
    if (!body.name) return json({ error: "name is required" }, 400);
    if (!body.proxy_url) return json({ error: "proxy_url is required" }, 400);
    const pool = createProxyPool({ name: body.name, proxy_url: body.proxy_url, no_proxy: body.no_proxy ?? null });
    return json({ ok: true, pool });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export function handleDeleteProxyPool(id: string): Response {
  const pool = getProxyPoolById(id);
  if (!pool) return json({ error: "Pool not found" }, 404);
  const bound = getConnectionCountForPool(id);
  if (bound > 0) return json({ error: `Cannot delete - ${bound} connection(s) still use this pool` }, 409);
  deleteProxyPool(id);
  return json({ ok: true });
}

export async function handleUpdateProxyPool(id: string, req: Request): Promise<Response> {
  try {
    const pool = getProxyPoolById(id);
    if (!pool) return json({ error: "Pool not found" }, 404);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const allowed = new Set(["name", "proxy_url", "no_proxy", "is_active"]);
    const unknownFields = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknownFields.length > 0) {
      return json({ error: `Unknown field(s): ${unknownFields.join(", ")}` }, 400);
    }

    const patch: ProxyPoolPatch = {};
    if ("name" in body) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return json({ error: "name must be a non-empty string" }, 400);
      }
      patch.name = body.name.trim();
    }
    if ("proxy_url" in body) {
      if (typeof body.proxy_url !== "string" || !body.proxy_url.trim()) {
        return json({ error: "proxy_url must be a non-empty string" }, 400);
      }
      patch.proxy_url = body.proxy_url.trim();
    }
    if ("no_proxy" in body) {
      if (body.no_proxy !== null && typeof body.no_proxy !== "string") {
        return json({ error: "no_proxy must be a string or null" }, 400);
      }
      patch.no_proxy = body.no_proxy === null ? null : body.no_proxy.trim();
    }
    if ("is_active" in body) {
      const value = Number(body.is_active);
      if (!Number.isInteger(value) || (value !== 0 && value !== 1)) {
        return json({ error: "is_active must be 0 or 1" }, 400);
      }
      patch.is_active = value;
    }

    if (Object.keys(patch).length === 0) {
      return json({ error: "No valid fields provided for update" }, 400);
    }

    updateProxyPool(id, patch);
    return json({ ok: true, pool: getProxyPoolById(id) });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

export async function handleTestProxyPool(id: string): Promise<Response> {
  const pool = getProxyPoolById(id);
  if (!pool) return json({ error: "Pool not found" }, 404);
  const result = await testProxyPool(pool);
  return json(result);
}
