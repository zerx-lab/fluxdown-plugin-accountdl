// 夸克网盘分享页识别与任务 URL（纯函数，不依赖 flux；网页脚本与 resolver 共用）。
//
// 分享页：`https://pan.quark.cn/s/<pwd_id>`；提取码 `?pwd=`；当前目录在片段里：
// `#/list/share/<fid>-<目录名>/<子目录 fid>-<目录名>`（逐级 `<fid>-<名>`，根目录为 `#/list/share`）。
// 任务 URL：`https://pan.quark.cn/__accountdl/quark?key=<pwd_id>[&pwd=<提取码>][&dir=<fid>]`。

import { taskUrl } from "../../core/task";
import { parseQuery, parseUrl } from "../../core/url";

export const QUARK_HOST = "pan.quark.cn";
export const SITE_ID = "quark";

// 与 ops quarkShareKeyRe / quarkFidRe 一致：分享标识 6~40 位字母数字；fid 为 32 位十六进制，根目录为 "0"。
const SHARE_KEY_RE = /^[A-Za-z0-9]{6,40}$/;
const FID_RE = /^[A-Za-z0-9]{1,64}$/;
const SHARE_PATH_RE = /^\/s\/([A-Za-z0-9]{6,40})\/?$/;
const MAX_PASSWORD_CHARS = 32;

export function isShareKey(key: string): boolean {
  return SHARE_KEY_RE.test(key);
}

export function isFid(fid: string): boolean {
  return FID_RE.test(fid);
}

export interface SharePage {
  key: string;
  /** 地址里的提取码，没有为 ""。 */
  password: string;
  /** 页面当前所在目录的 fid；根目录或无法识别为 ""。 */
  dir: string;
}

/** 分享页地址 → 分享标识、提取码与当前目录；不是夸克分享页返回 null（仿冒域名不认）。 */
export function parseSharePage(href: string): SharePage | null {
  const url = parseUrl(href);
  if (!url || url.host !== QUARK_HOST) return null;
  const m = SHARE_PATH_RE.exec(url.path);
  if (!m) return null;
  const password = (parseQuery(url.query).pwd ?? "").trim();
  return { key: m[1], password: password.length <= MAX_PASSWORD_CHARS ? password : "", dir: dirFromFragment(url.fragment) };
}

/** `/list/share/<fid>-名/<fid>-名` 的最后一级 fid。 */
function dirFromFragment(fragment: string): string {
  const parts = fragment.split("/").filter((p) => p !== "");
  const at = parts.indexOf("share");
  if (parts[0] !== "list" || at !== 1) return "";
  const last = parts[parts.length - 1];
  if (last === "share") return "";
  const fid = last.split("-")[0];
  return isFid(fid) ? fid : "";
}

export function sharePageTaskUrl(page: SharePage): string {
  const params: Record<string, string> = { key: page.key };
  if (page.password) params.pwd = page.password;
  if (page.dir && page.dir !== "0") params.dir = page.dir;
  return taskUrl(QUARK_HOST, SITE_ID, params);
}

export interface TaskParams {
  key: string;
  password: string;
  dir: string;
}

/** 任务 URL 参数 → 校验后的分享参数；不合法返回 null。 */
export function readTaskParams(params: Record<string, string>): TaskParams | null {
  const key = params.key ?? "";
  const password = params.pwd ?? "";
  const dir = params.dir || "0";
  if (!isShareKey(key) || !isFid(dir) || password.length > MAX_PASSWORD_CHARS) return null;
  return { key, password, dir };
}
