// WBI 签名（`/x/player/wbi/playurl` 等接口）。算法来源：SocialSisterYi/bilibili-API-collect `docs/misc/sign/wbi.md`。
// 密钥取自 `/x/web-interface/nav` 的 `data.wbi_img`（匿名也有，nav 返回 -101 时 data 里仍带 wbi_img）。

import { md5 } from "../../core/hash";

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16,
  24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

/** `https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`；形状不对返回 ""。 */
export function wbiKeyFromUrl(url: string): string {
  const m = /\/([0-9a-f]{32})\.[A-Za-z0-9]+(?:$|\?)/i.exec(url);
  return m ? m[1] : "";
}

export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  if (raw.length < 64) return "";
  return MIXIN_TAB.map((i) => raw[i])
    .join("")
    .slice(0, 32);
}

/** 加 `wts` 时间戳、按键名排序、剔除值里的 `!'()*`，追加 `w_rid`；返回完整查询串。 */
export function signWbi(params: Record<string, string>, mixin: string, nowSeconds: number): string {
  const all: Record<string, string> = { ...params, wts: String(nowSeconds) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k].replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${md5(query + mixin)}`;
}
