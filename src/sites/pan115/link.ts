// 115 网盘分享页识别与任务 URL（纯函数，不依赖 flux；网页脚本与 resolver 共用）。
//
// 分享页：`https://115.com/s/<share_code>?password=<receive_code>`（115.com 会 302 到 115cdn.com）、
// `https://115cdn.com/s/...`、`https://anxia.com/s/...`（老域名）。主机仅精确匹配。
// 任务 URL：`https://115.com/__accountdl/pan115?s=<share_code>[&p=<提取码>][&d=<起始目录 cid>]`。
// 任务 URL 固定用 115.com：登录 Cookie（UID / CID / SEID / KID）的作用域是 .115.com，
// 即使分享页在 115cdn.com，扩展也按任务 URL 的主机取 Cookie。

import { parseTaskUrl, taskUrl } from "../../core/task";
import { parseQuery, type ParsedUrl } from "../../core/url";

export const SITE_ID = "pan115";
export const SITE_NAME = "115 网盘";
export const TASK_HOST = "115.com";
/** 分享页允许的主机，仅精确匹配。 */
export const SHARE_HOSTS: readonly string[] = ["115.com", "115cdn.com", "anxia.com"];

const SHARE_PATH_RE = /^\/s\/([A-Za-z0-9]{4,32})\/?$/;
const SHARE_CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const RECEIVE_CODE_RE = /^[A-Za-z0-9]{0,16}$/;
/** 目录 id：数字（`0` = 分享根目录）。 */
const DIR_RE = /^[0-9]{1,30}$/;

export interface SharePage {
  shareCode: string;
  /** URL `?password=` 里的提取码，没有为 ""。 */
  receiveCode: string;
}

/** 分享页 URL → 分享码与提取码；不是分享页返回 null。 */
export function parseSharePage(url: ParsedUrl): SharePage | null {
  if (!SHARE_HOSTS.includes(url.host)) return null;
  const m = SHARE_PATH_RE.exec(url.path);
  if (!m) return null;
  const query = parseQuery(url.query);
  const code = query.password ?? query.pwd ?? "";
  return { shareCode: m[1], receiveCode: RECEIVE_CODE_RE.test(code) ? code : "" };
}

export interface Pan115Task {
  shareCode: string;
  /** 提取码；可为 ""（resolver 会让站点报「需要提取码」）。 */
  receiveCode: string;
  /** 起始目录 cid；"" = 分享根目录。 */
  dir: string;
}

export function makeTaskUrl(task: { shareCode: string; receiveCode?: string; dir?: string }): string {
  const params: Record<string, string> = { s: task.shareCode };
  if (task.receiveCode) params.p = task.receiveCode;
  if (task.dir) params.d = task.dir;
  return taskUrl(TASK_HOST, SITE_ID, params);
}

/** 任务 URL → 参数；不是本站点任务 URL 或参数非法返回 null（参数当不可信输入）。 */
export function readTask(url: ParsedUrl): Pan115Task | null {
  if (url.host !== TASK_HOST) return null;
  const parsed = parseTaskUrl(url);
  if (!parsed || parsed.siteId !== SITE_ID) return null;
  const { s = "", p = "", d = "" } = parsed.params;
  if (!SHARE_CODE_RE.test(s) || !RECEIVE_CODE_RE.test(p)) return null;
  if (d !== "" && !DIR_RE.test(d)) return null;
  return { shareCode: s, receiveCode: p, dir: d };
}

/** 是否本站点的任务 URL（只看主机与路径，不校验参数）。 */
export function isTaskUrl(url: ParsedUrl): boolean {
  return url.host === TASK_HOST && parseTaskUrl(url)?.siteId === SITE_ID;
}
