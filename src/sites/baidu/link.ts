// 百度网盘分享页识别与任务 URL（纯函数，不依赖 flux；网页脚本与 resolver 共用）。
//
// 分享页：`/s/<key>`（key = 一位数字前缀 + surl）、`/share/init?surl=<surl>`、`/wap/init?surl=<surl>`；
// 主机 pan.baidu.com / yun.baidu.com（仅精确匹配）。页内目录在 hash：`#list/path=%2F目录`。
// 任务 URL：`https://pan.baidu.com/__accountdl/baidu?s=<key>[&pwd=][&dir=<分享内绝对路径>][&name=]`。
// 任务 URL 固定用 pan.baidu.com：登录 Cookie 的作用域是 .baidu.com，yun.baidu.com 页面发起也一样。

import { taskUrl, parseTaskUrl } from "../../core/task";
import { parseQuery, safeDecode, type ParsedUrl } from "../../core/url";

export const SITE_ID = "baidu";
export const SITE_NAME = "百度网盘";
export const TASK_HOST = "pan.baidu.com";
/** 分享页 / 任务 URL 允许的主机，仅精确匹配。 */
export const SHARE_HOSTS: readonly string[] = ["pan.baidu.com", "yun.baidu.com"];

const SHARE_PATH_RE = /^\/s\/([0-9][A-Za-z0-9_-]{5,40})\/?$/;
const INIT_PATH_RE = /^\/(?:share|wap)\/init\/?$/;
const SURL_RE = /^[A-Za-z0-9_-]{5,40}$/;
const KEY_RE = /^[0-9][A-Za-z0-9_-]{5,40}$/;
const PWD_RE = /^[A-Za-z0-9]{0,32}$/;
const MAX_DIR_CHARS = 1024;

export interface SharePage {
  /** 分享 key（带数字前缀）。 */
  key: string;
  /** URL `?pwd=` 里的提取码，没有为 ""。 */
  pwd: string;
}

/** 分享页 URL → key 与提取码；不是分享页返回 null。 */
export function parseSharePage(url: ParsedUrl): SharePage | null {
  if (!SHARE_HOSTS.includes(url.host)) return null;
  const query = parseQuery(url.query);
  const pwd = PWD_RE.test(query.pwd ?? "") ? (query.pwd ?? "") : "";
  const m = SHARE_PATH_RE.exec(url.path);
  if (m) return { key: m[1], pwd };
  if (INIT_PATH_RE.test(url.path)) {
    const surl = query.surl ?? "";
    return SURL_RE.test(surl) ? { key: `1${surl}`, pwd } : null;
  }
  return null;
}

/** 分享页 hash（`list/path=%2F目录`）里的当前目录；根目录与无目录返回 ""。 */
export function dirFromHash(fragment: string): string {
  const m = /(?:^|[/&])path=([^&]*)/.exec(fragment);
  if (!m) return "";
  const dir = safeDecode(m[1]);
  return validDir(dir) && dir !== "/" ? dir.replace(/\/+$/, "") : "";
}

/** 分享内绝对路径：以 `/` 开头、无控制字符、长度受限。 */
export function validDir(dir: string): boolean {
  if (!dir.startsWith("/") || Array.from(dir).length > MAX_DIR_CHARS) return false;
  for (let i = 0; i < dir.length; i++) {
    const c = dir.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

export interface BaiduTask {
  key: string;
  surl: string;
  /** 提取码；"" 表示无（resolver 改用浏览器 Cookie 里的 BDCLND）。 */
  pwd: string;
  /** 起始目录（分享内绝对路径）；"" = 分享根目录。 */
  dir: string;
  /** 显示名（清单名），可为 ""。 */
  name: string;
}

export function makeTaskUrl(task: { key: string; pwd?: string; dir?: string; name?: string }): string {
  const params: Record<string, string> = { s: task.key };
  if (task.pwd) params.pwd = task.pwd;
  if (task.dir) params.dir = task.dir;
  if (task.name) params.name = task.name;
  return taskUrl(TASK_HOST, SITE_ID, params);
}

/** 任务 URL → 参数；不是本站点任务 URL 或参数非法返回 null（参数当不可信输入）。 */
export function readTask(url: ParsedUrl): BaiduTask | null {
  if (!SHARE_HOSTS.includes(url.host)) return null;
  const parsed = parseTaskUrl(url);
  if (!parsed || parsed.siteId !== SITE_ID) return null;
  const { s = "", pwd = "", dir = "", name = "" } = parsed.params;
  if (!KEY_RE.test(s) || !PWD_RE.test(pwd)) return null;
  if (dir !== "" && !validDir(dir)) return null;
  return { key: s, surl: s.slice(1), pwd, dir, name };
}
