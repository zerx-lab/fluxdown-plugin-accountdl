// 登录令牌在插件存储（`flux.storage`，main 与 resolver 共享）里的读写。
// 123 云盘网页把登录令牌放在 localStorage 而不是 Cookie，扩展带不过来：网页脚本经 RPC `pan123.syncToken`
// 交给 main 存下，resolver 解析时读取。只存令牌与过期时间；令牌落在 FluxDown 插件存储里（明文）。

import { asObject } from "../../core/json";
import { checkToken } from "./jwt";

const KEY = "pan123.auth";

export type AuthState = "none" | "expired" | "ok";

export interface Auth {
  /** state 为 "ok" 时才非空。 */
  token: string;
  /** none = 从没同步过（或网页已退出登录）；expired = 同步过但令牌已过期。 */
  state: AuthState;
}

export async function saveToken(token: string, exp: number): Promise<void> {
  await flux.storage.set(KEY, JSON.stringify({ token, exp }));
}

/** 清除；`flux.storage` 没有删除接口，写空串。 */
export async function clearToken(): Promise<void> {
  await flux.storage.set(KEY, "");
}

export async function loadAuth(nowSec: number): Promise<Auth> {
  const raw = await flux.storage.get(KEY);
  if (!raw) return { token: "", state: "none" };
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { token: "", state: "none" };
  }
  const token = asObject(record)?.token;
  if (typeof token !== "string") return { token: "", state: "none" };
  // 存储内容当作不可信：重新按令牌本身校验形状与过期。
  const checked = checkToken(token, nowSec);
  if (checked.kind === "ok") return { token: checked.token, state: "ok" };
  return { token: "", state: checked.kind === "expired" ? "expired" : "none" };
}
