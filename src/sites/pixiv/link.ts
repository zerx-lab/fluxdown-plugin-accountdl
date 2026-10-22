// Pixiv 作品页链接识别（纯函数，网页脚本与 resolver 共用，不依赖 flux）。

import { hostIn } from "../../core/site";
import type { ParsedUrl } from "../../core/url";

export const PIXIV_HOSTS = ["pixiv.net"] as const;

/** 作品页：`/artworks/<id>`，可带语言前缀 `/en`、`/zh`、`/zh_tw` 等。 */
const ARTWORK_PATH = /^(?:\/[a-z]{2}(?:[-_][a-z]{2,4})?)?\/artworks\/(\d{1,12})\/?$/;

/** 作品 id；不是 Pixiv 作品页返回 null。 */
export function parseArtworkId(url: ParsedUrl): string | null {
  if (url.scheme !== "https" && url.scheme !== "http") return null;
  if (!hostIn(url.host, PIXIV_HOSTS)) return null;
  const m = ARTWORK_PATH.exec(url.path);
  return m ? m[1] : null;
}

/** 规范作品页 URL（无语言前缀、无查询串）。 */
export function artworkUrl(id: string): string {
  return `https://www.pixiv.net/artworks/${id}`;
}
