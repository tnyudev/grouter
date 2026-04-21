import {
  createClientKey,
  deleteClientKey,
  getClientKey,
  listClientKeys,
  parseAllowedProviders,
  updateClientKey,
} from "../db/client_keys.ts";
import { json } from "./api-http.ts";

function normalizeAllowedProvidersInput(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeExpiresAtInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

export function handleListClientKeys(): Response {
  return json({ keys: listClientKeys() });
}

export async function handleCreateClientKey(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      name?: string;
      allowed_providers?: string[] | null;
      token_limit?: number;
      api_key?: string;
      expires_at?: string | null;
    };

    const name = body.name?.trim();
    if (!name) return json({ error: "Missing name" }, 400);

    const allowedProviders = normalizeAllowedProvidersInput(body.allowed_providers);
    if (allowedProviders === undefined) {
      return json({ error: "allowed_providers must be an array of provider ids or null" }, 400);
    }

    const tokenLimit = Number(body.token_limit ?? 0);
    if (!Number.isInteger(tokenLimit) || tokenLimit < 0) {
      return json({ error: "token_limit must be a non-negative integer" }, 400);
    }

    const expiresAt = normalizeExpiresAtInput(body.expires_at);
    if (expiresAt === undefined) {
      return json({ error: "expires_at must be a valid ISO date or null" }, 400);
    }

    const key = body.api_key?.trim() || "grouter-sk-" + crypto.randomUUID().replace(/-/g, "");
    createClientKey({
      name,
      api_key: key,
      allowed_providers: allowedProviders ?? null,
      token_limit: tokenLimit,
      expires_at: expiresAt ?? null,
    });
    return json({ ok: true, key, client_key: getClientKey(key) });
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      return json({ error: "Client key already exists" }, 409);
    }
    return json({ error: String(err) }, 500);
  }
}

export function handleDeleteClientKey(key: string): Response {
  deleteClientKey(key);
  return json({ ok: true });
}

export async function handleUpdateClientKey(req: Request, key: string): Promise<Response> {
  try {
    const body = await req.json() as {
      name?: string;
      allowed_providers?: string[] | null;
      token_limit?: number;
      expires_at?: string | null;
    };

    const existing = getClientKey(key);
    if (!existing) return json({ error: "Key not found" }, 404);

    const hasAnyField =
      body.name !== undefined ||
      body.allowed_providers !== undefined ||
      body.token_limit !== undefined ||
      body.expires_at !== undefined;
    if (!hasAnyField) {
      return json({ error: "No fields provided for update" }, 400);
    }

    const name = body.name !== undefined ? body.name.trim() : existing.name;
    if (!name) return json({ error: "Missing name" }, 400);

    const allowedProvidersRaw = normalizeAllowedProvidersInput(body.allowed_providers);
    if (body.allowed_providers !== undefined && allowedProvidersRaw === undefined) {
      return json({ error: "allowed_providers must be an array of provider ids or null" }, 400);
    }
    const allowedProviders =
      body.allowed_providers !== undefined
        ? (allowedProvidersRaw ?? null)
        : (parseAllowedProviders(existing.allowed_providers) ?? null);

    const tokenLimit = body.token_limit !== undefined ? Number(body.token_limit) : existing.token_limit;
    if (!Number.isInteger(tokenLimit) || tokenLimit < 0) {
      return json({ error: "token_limit must be a non-negative integer" }, 400);
    }

    const expiresAtRaw = normalizeExpiresAtInput(body.expires_at);
    if (body.expires_at !== undefined && expiresAtRaw === undefined) {
      return json({ error: "expires_at must be a valid ISO date or null" }, 400);
    }
    const expiresAt = body.expires_at !== undefined ? (expiresAtRaw ?? null) : existing.expires_at;

    updateClientKey(key, {
      name,
      allowed_providers: allowedProviders,
      token_limit: tokenLimit,
      expires_at: expiresAt,
    });
    return json({ ok: true, client_key: getClientKey(key) });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
