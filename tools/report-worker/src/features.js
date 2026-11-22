/**
 * 功能開關（Neon 的 features：key → data jsonb，後台「功能管理」改，格式見 scripts/lib/features.mjs）。
 *  - GET /v1/features → { ok, jws }：jws 是 compact JWS（ES256，header { alg, typ: "JWT", kid }），
 *    payload = { iat（秒）, features: { <key>: data } }，資料庫裡的每一列原樣放進去；沒有的功能由擴充用自己的預設值。
 *    擴充內建公鑰驗章（src/features.js），storage 或回應被改過就不採用。資料讀 KV 快照（snapshots.js 的 features，後台存檔時寫），
 *    不每個請求都查 Neon；簽好的結果在這個 isolate 的記憶體留 CACHE_S 秒。
 *    簽章私鑰：secret FEATURES_SIGNING_KEY（P-256 私鑰的 JWK JSON；值在 .env.local）。沒設回 503 not_configured。
 *  - featureData(env, h, key)：其他 API 用（例如贊助的 /v1/donate/config、結帳），沒有這一列＝{ enabled: true }
 * 還沒有 features 表時（後台還沒打開過「功能管理」），贊助沿用舊的 settings.donate_enabled。
 */
import { buildSnapshot, readSnapshot } from "./snapshots.js";

export const KID = "f1";

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

let keyCache = null; // { jwk 字串, CryptoKey }
async function signingKey(jwkText) {
  if (keyCache && keyCache.jwk === jwkText) return keyCache.key;
  const jwk = JSON.parse(jwkText);
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  keyCache = { jwk: jwkText, key };
  return key;
}

export async function signJws(payload, jwkText, kid = KID) {
  const input = b64urlText(JSON.stringify({ alg: "ES256", typ: "JWT", kid })) + "." + b64urlText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(jwkText), new TextEncoder().encode(input));
  return input + "." + b64url(new Uint8Array(sig));
}

// { <key>: data }：KV 快照；KV 沒有才查 Neon 一次（還沒有 features 表時沿用 settings.donate_enabled，見 snapshots.js）
export async function featureRows(env, h) {
  return (await readSnapshot(env, "features", (info) => buildSnapshot("features", (q, p) => h.neonSql(env, q, p), info))) || {};
}

export async function featureData(env, h, key) {
  const rows = await featureRows(env, h);
  return { enabled: true, ...(rows[key] || {}) };
}

let signed = null; // { at, body }：簽好的回應，同一個 isolate 內 CACHE_S 秒不重簽
export function _resetFeaturesMemory() { signed = null; }

export async function handleFeatures(request, env, ctx, h) {
  if (!env.FEATURES_SIGNING_KEY) return h.fail(503, "not_configured");
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${h.CACHE_S}`, ...h.CORS };
  if (signed && Date.now() - signed.at < h.CACHE_S * 1000) return new Response(signed.body, { headers });
  let features;
  try { features = await featureRows(env, h); } catch (e) { return h.fail(env.DATABASE_URL ? 502 : 503, env.DATABASE_URL ? "db" : "not_configured"); }
  let jws;
  try { jws = await signJws({ iat: Math.floor(Date.now() / 1000), features }, env.FEATURES_SIGNING_KEY); } catch (e) { return h.fail(503, "not_configured"); }
  signed = { at: Date.now(), body: JSON.stringify({ ok: true, jws }) };
  return new Response(signed.body, { headers });
}
