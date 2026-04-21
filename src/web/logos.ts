import { createHash } from "node:crypto";
import { LOGO_B64 } from "./logos-embedded.ts";

// Decode once per file and keep binary copies alive for daemon lifetime.
const LOGO_BYTES: Record<string, Uint8Array> = {};
const LOGO_ETAG: Record<string, string> = {};

for (const [name, b64] of Object.entries(LOGO_B64)) {
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  LOGO_BYTES[name] = bytes;
  LOGO_ETAG[name] = `"${createHash("sha1").update(bytes).digest("hex")}"`;
}

function hasMatchingEtag(req: Request | undefined, etag: string): boolean {
  if (!req) return false;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === "*");
}

export function serveLogo(filename: string, req?: Request): Response {
  const bytes = LOGO_BYTES[filename];
  if (!bytes) return new Response("Not found", { status: 404 });

  const etag = LOGO_ETAG[filename];
  const headers: Record<string, string> = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  };
  if (etag) headers.ETag = etag;

  if (etag && hasMatchingEtag(req, etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(bytes, { headers });
}
