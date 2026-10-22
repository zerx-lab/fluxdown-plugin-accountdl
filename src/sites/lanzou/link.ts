// 蓝奏云分享链接识别（纯函数，resolver 与网页脚本共用，不依赖 flux）。
//
// 分享页 `https://<子域>.<域名>/<id>`：文件 id 形如 `iMq6x3jilnqb`，文件夹 id 形如 `b073l8d1e`；
// 旧链接带 `/tp/` 前缀。蓝奏云的风控 Cookie 与域名绑定，所以始终用任务 URL 自己的主机请求，不改写成别的域名。
// 提取码放任务 URL 的 `?pwd=`。

import { parseQuery, parseUrl, type ParsedUrl } from "../../core/url";

/**
 * 分享域名（分享页都有子域名 www / wwi / wwt 等，裸域名不可访问）。
 * 来源：XIU2「蓝奏云网盘增强」的 @match 列表（2026-10 取得）+ 匿名实测能打开分享页的 lanzouc/k/g、lanpw。
 */
export const SHARE_DOMAINS = [
  "lanzoub.com", "lanzouc.com", "lanzoue.com", "lanzouf.com", "lanzoug.com", "lanzouh.com", "lanzoui.com",
  "lanzouj.com", "lanzouk.com", "lanzoul.com", "lanzoum.com", "lanzouo.com", "lanzoup.com", "lanzouq.com",
  "lanzout.com", "lanzouu.com", "lanzouv.com", "lanzouw.com", "lanzoux.com", "lanzouy.com",
  "lanzb.com", "lanze.com", "lanzf.com", "lanzh.com", "lanzi.com", "lanzj.com", "lanzl.com", "lanzm.com",
  "lanzn.com", "lanzo.com", "lanzp.com", "lanzq.com", "lanzt.com", "lanzv.com", "lanzw.com", "lanzx.com",
  "lanzy.com", "lanpw.com",
] as const;

const PATH_RE = /^\/(?:tp\/)?([A-Za-z0-9]{5,32})$/;

export interface ShareLink {
  host: string;
  /** 分享 id（文件 `i…` 或文件夹 `b…`）。 */
  id: string;
  /** 提取码，没有为 ""。 */
  pwd: string;
}

/** 是否蓝奏云分享域名（域名本身或其子域；`www.lanzoub.com.evil.com` 之类仿冒不算）。 */
export function isShareHost(host: string): boolean {
  return SHARE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 分享页链接 → 主机 / id / 提取码；不是返回 null（蓝奏云下载 CDN 的多段路径、登录页 `/u` 都不是）。 */
export function parseShareLink(url: ParsedUrl): ShareLink | null {
  if ((url.scheme !== "https" && url.scheme !== "http") || !isShareHost(url.host)) return null;
  const m = PATH_RE.exec(url.path);
  if (!m) return null;
  return { host: url.host, id: m[1], pwd: (parseQuery(url.query).pwd ?? "").trim() };
}

/** 文本形式的分享链接（网页脚本用当前地址）。 */
export function parseShareText(href: string): ShareLink | null {
  const parsed = parseUrl(href);
  return parsed ? parseShareLink(parsed) : null;
}

/** 规范任务 URL：`https://<主机>/<id>[?pwd=…]`，用户在 FluxDown 里直接粘贴同样适用。 */
export function shareUrl(host: string, id: string, pwd = ""): string {
  return `https://${host}/${id}${pwd ? `?pwd=${encodeURIComponent(pwd)}` : ""}`;
}
