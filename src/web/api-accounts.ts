import { listAccounts, removeAccount, updateAccount, type AccountPatch } from "../db/accounts.ts";
import { getProxyPoolById } from "../db/pools.ts";
import { json } from "./api-http.ts";

export function handleAccountToggle(id: string): Response {
  const accounts = listAccounts();
  const account = accounts.find((item) => item.id === id);
  if (!account) return json({ error: "Account not found" }, 404);

  const newActive = account.is_active === 1 ? 0 : 1;
  updateAccount(id, { is_active: newActive });
  return json({ ok: true, is_active: newActive });
}

export function handleAccountRemove(id: string): Response {
  const ok = removeAccount(id);
  return ok ? json({ ok: true }) : json({ error: "Account not found" }, 404);
}

export async function handleUpdateConnection(id: string, req: Request): Promise<Response> {
  try {
    const accounts = listAccounts();
    const account = accounts.find((item) => item.id === id);
    if (!account) return json({ error: "Connection not found" }, 404);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const unknownFields = Object.keys(body).filter((key) => key !== "proxy_pool_id");
    if (unknownFields.length > 0) {
      return json({ error: `Unknown field(s): ${unknownFields.join(", ")}` }, 400);
    }
    if (!("proxy_pool_id" in body)) {
      return json({ error: "proxy_pool_id is required" }, 400);
    }

    const poolId = body.proxy_pool_id;
    if (poolId !== null && typeof poolId !== "string") {
      return json({ error: "proxy_pool_id must be a string or null" }, 400);
    }

    const patch: AccountPatch = {};
    if (poolId === null) {
      patch.proxy_pool_id = null;
    } else {
      const trimmed = poolId.trim();
      if (!trimmed) return json({ error: "proxy_pool_id must not be empty" }, 400);
      if (!getProxyPoolById(trimmed)) {
        return json({ error: `Proxy pool not found: ${trimmed}` }, 404);
      }
      patch.proxy_pool_id = trimmed;
    }

    updateAccount(id, patch);
    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
