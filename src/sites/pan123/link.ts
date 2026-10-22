// 123 云盘分享页识别与任务 URL。纯函数、不依赖 `flux`：网页脚本与 resolver 共用。
//
// 分享路径：`/s/<key>`、`/s/<key>.html`、`/ps/<key>`、`/123pan/<key>`（站点 404 页脚本同款正则），
// key 形如 `<part1>-<part2>`。分享页实际在 `<uid>.share.123pan.cn`（`www.123pan.com/s/…` 会跳过去），
// 提取码在 `?pwd=`，或验证后存进 localStorage `sharePwd_<key>`。

import { asObject } from "../../core/json";
import { hostIn } from "../../core/site";
import { parseTaskUrl, taskUrl } from "../../core/task";
import { parseQuery, parseUrl, type ParsedUrl } from "../../core/url";

export const SITE_ID = "pan123";
export const SITE_NAME = "123 云盘";

/** 分享页域名（含子域名，如 `<uid>.share.123pan.cn`）。 */
export const SHARE_DOMAINS = [
  "123pan.com",
  "123pan.cn",
  "123684.com",
  "123865.com",
  "123912.com",
  "123592.com",
  "123295.com",
  "123278.com",
] as const;

const PATH_RE = /^\/(?:s|ps|123pan)\/([A-Za-z0-9]+-[A-Za-z0-9]+)(?:\.html)?(?:[/&]|$)/;
const KEY_RE = /^[A-Za-z0-9]{1,32}-[A-Za-z0-9]{1,32}$/;
const PWD_RE = /^[A-Za-z0-9]{1,32}$/;

export function isShareHost(host: string): boolean {
  return hostIn(host, SHARE_DOMAINS);
}

/** 分享链接的标识：key 与（URL 里带的）提取码；不是 123 云盘分享页返回 null。 */
export function parseSharePage(href: string): { host: string; key: string; pwd: string } | null {
  const url = parseUrl(href);
  if (!url || !isShareHost(url.host)) return null;
  const m = PATH_RE.exec(url.path);
  if (!m) return null;
  return { host: url.host, key: m[1]!, pwd: normalizePwd(parseQuery(url.query).pwd ?? "") };
}

/** 提取码规整：去空白与引号；不合规范返回 ""。 */
export function normalizePwd(raw: string): string {
  const s = raw.trim().replace(/^"(.*)"$/, "$1").trim();
  return PWD_RE.test(s) ? s : "";
}

/** localStorage `sharePwd_<key>` 的值 → 提取码：站点存的是 JSON 字符串（diskdirect 实测），兼容 `{value}` 包装与裸文本。 */
export function storedPwd(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "string") return normalizePwd(v);
    const inner = asObject(v)?.value;
    return typeof inner === "string" ? normalizePwd(inner) : "";
  } catch {
    return normalizePwd(raw);
  }
}

/** 任务 URL：`https://<分享页主机>/__accountdl/pan123?key=…&pwd=…`；主机必须是分享页自己的主机（扩展按它取 Cookie）。 */
export function shareTaskUrl(host: string, key: string, pwd: string): string {
  return taskUrl(host, SITE_ID, pwd ? { key, pwd } : { key });
}

/** 本站点的任务 URL → 分享标识；主机、站点 id 或参数不合规返回 null。 */
export function parseShareTask(url: ParsedUrl): { key: string; pwd: string } | null {
  if (!isShareHost(url.host)) return null;
  const task = parseTaskUrl(url);
  if (!task || task.siteId !== SITE_ID) return null;
  const key = task.params.key ?? "";
  if (!KEY_RE.test(key)) return null;
  const pwd = task.params.pwd ?? "";
  if (pwd !== "" && !PWD_RE.test(pwd)) return null;
  return { key, pwd };
}
