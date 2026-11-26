// ES256 的 compact JWS 簽章（header { alg: "ES256", typ: "JWT", kid }）。節點清單發布（scripts/lib/cdn-list.mjs）與測試用。
// 擴充用內建公鑰驗章（src/cdn-list.js、src/features.js）。私鑰是 P-256 的 JWK JSON（.env.local 的 FEATURES_SIGNING_KEY，kid f1）。
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
