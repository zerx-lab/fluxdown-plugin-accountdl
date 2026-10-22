// 登录令牌（网页 localStorage / sessionStorage 的 `authorToken`）的规整与校验。纯函数、不依赖 `flux`。
// 网页端 `save("authorToken", t)` 写入 `JSON.stringify(t)`（带引号），读取时去引号与 `Bearer ` 前缀
// （statics.123pan.com 分享页 bundle 的 F / D 函数），所以这里同样先规整。

import { base64Decode, utf8Decode } from "../../core/hash";
import { asNumber, asObject } from "../../core/json";

export const MAX_TOKEN_CHARS = 4096;
/** 临近过期的令牌当作已过期（直链解析要花几秒）。 */
const EXPIRY_SKEW_SEC = 60;

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** 去空白、JSON 引号与 `Bearer ` 前缀。 */
export function normalizeToken(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).trim();
  return s.replace(/^bearer\s+/i, "").trim();
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(utf8Decode(base64Decode(seg))));
  } catch {
    return null;
  }
}

/** JWT 形状：三段 base64url，头与载荷都是 JSON 对象；返回载荷里的 `exp`（秒），不合规返回 null。 */
export function jwtExpiry(token: string): number | null {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT_RE.test(p))) return null;
  if (!decodeSegment(parts[0]!)) return null;
  const payload = decodeSegment(parts[1]!);
  const exp = payload ? asNumber(payload.exp) : null;
  return exp !== null && exp > 0 ? Math.floor(exp) : null;
}

export type TokenCheck =
  | { kind: "ok"; token: string; exp: number }
  | { kind: "shape" }
  | { kind: "expired" };

/** 规整并校验：形状不对 → shape；没有 `exp` 或已（将）过期 → expired / shape。 */
export function checkToken(raw: string, nowSec: number): TokenCheck {
  const token = normalizeToken(raw);
  const exp = jwtExpiry(token);
  if (exp === null) return { kind: "shape" };
  if (exp <= nowSec + EXPIRY_SKEW_SEC) return { kind: "expired" };
  return { kind: "ok", token, exp };
}
