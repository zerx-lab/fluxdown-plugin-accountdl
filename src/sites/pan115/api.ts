// 115 分享链路的 API 请求（QuickJS 里用 flux.fetch，Cookie 取自浏览器登录态）。
//
// - 列目录：`GET https://webapi.115.com/share/snap`（web 接口，浏览器 UA；匿名也能列，本插件照浏览器带登录 Cookie）。
//   注意：该接口对 `115Browser` UA 返回 405（匿名实测），所以列目录一律用普通浏览器 UA。
// - 取直链：`POST https://proapi.115.com/app/share/downurl?t=<秒>`，表单 `data` = m115 加密的
//   `{share_code, receive_code, file_id}`，必须用 115 客户端 UA，且不带 Referer（SheltonZhu/115driver 的实测锁定）。
//   web 接口 `webapi.115.com/share/downurl` 单文件上限 200 MB（页面 DOWN_LIMIT=0xC800000，p115client 文档同），
//   且 2026-09 起对第三方返回「当前版本过低」，所以只用 app 接口。
// 响应一律当不可信输入；消息不含 Cookie、提取码或带签名的直链。

import { mergeSetCookie } from "../../core/cookies";
import { SiteError, type ErrorKind } from "../../core/errors";
import { formBody, parseJsonObject, request } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { utf8Bytes, utf8Decode } from "../../core/hash";
import { MAX_ITEMS, type ManifestFile } from "../../core/manifest";
import { encodeQuery, parseUrl } from "../../core/url";
import { KEY_SIZE, m115Decode, m115Encode, randomBytes } from "./m115";
import { SITE_NAME } from "./link";

/** 普通浏览器 UA（列目录用；115Browser UA 会被 webapi 拒绝）。 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** 115 客户端 UA（取直链用；app 接口拒绝普通浏览器与下载器 UA）。 */
export const APP_UA = "Mozilla/5.0 115Browser/27.0.5.7";

const SNAP_URL = "https://webapi.115.com/share/snap";
const DOWNURL_URL = "https://proapi.115.com/app/share/downurl";
const SHARE_REFERER = "https://115cdn.com/s/";

/** 单次解析里列目录的请求上限（resolve 总时长 30 秒）。 */
export const MAX_SNAP_REQUESTS = 20;
const SNAP_PAGE_LIMIT = 1000;

const LOGIN_MESSAGE = "没有登录或登录已失效：请先在浏览器登录 115，再从分享页的按钮发起下载";

/** snap 的 `share_state`：0 处理中 / 1 正常可用，其余都不可下载。 */
const SHARE_STATE_TEXT: Readonly<Record<number, string>> = {
  2: "分享因版权被禁止",
  3: "分享因违规被禁止",
  4: "分享已被分享者取消",
  5: "分享已被删除",
  6: "分享因违规被禁止",
  7: "分享已过期",
  8: "分享审核中，暂不可访问",
};

/** 把 cid / fid / pid 这类可能超过 2^53 的数字 id 先加引号，避免 JSON.parse 丢精度。 */
export function quoteBigIds(body: string): string {
  return body.replace(/("(?:cid|fid|pid)"\s*:\s*)(\d{16,})/g, '$1"$2"');
}

function firstCode(body: JsonObject): number {
  for (const key of ["errno", "errNo", "errcode", "msg_code", "code"]) {
    const n = asNumber(body[key]);
    if (n !== null && n !== 0) return n;
  }
  return 0;
}

function failure(stage: string, body: JsonObject): SiteError {
  const code = firstCode(body);
  const message = asString(body.error) || asString(body.msg) || asString(body.message);
  const raise = (detail: string, kind: ErrorKind) => new SiteError(SITE_NAME, stage, detail, kind);
  if (code === 99 || code === 990001) return raise(LOGIN_MESSAGE, "login");
  if (code === 4100012) return raise("分享需要提取码，链接里没有提取码", "password");
  if (code === 4100008) return raise("提取码错误", "password");
  if (code === 4100009 || code === 4100026) return raise("分享不存在、已失效或已被取消", "notFound");
  if (code === 70005 || code === 231011 || code === 50003 || code === 50015) return raise("文件不存在或已被删除", "notFound");
  if (code === 50028) return raise("文件过大，115 不允许直接下载", "limit");
  if (code === 911) return raise("115 要求完成验证：请先在 115 网页里通过验证后重试", "limit");
  if (message.includes("版本过低")) return raise("115 拒绝了本插件使用的客户端标识（版本过低），需要更新插件", "unsupported");
  if (message.includes("频繁") || message.includes("频率")) return raise(`请求过于频繁（${message}），请稍后再试`, "limit");
  return raise(`${message || "站点返回失败"}（错误码 ${code}）`, "other");
}

function checkState(stage: string, body: JsonObject): void {
  if (body.state === true || body.state === 1) return;
  throw failure(stage, body);
}

function checkHttp(stage: string, status: number): void {
  if (status === 401 || status === 403) throw new SiteError(SITE_NAME, stage, `HTTP ${status}，登录态无效或无权访问`, "login");
  if (status === 405) throw new SiteError(SITE_NAME, stage, "HTTP 405，请求被站点防护拦截", "network");
  if (status < 200 || status >= 300) throw new SiteError(SITE_NAME, stage, `HTTP ${status}`, "network");
}

export interface ShareEntry {
  /** 文件为 fid，目录为 cid。 */
  id: string;
  name: string;
  isDir: boolean;
  /** 字节数；目录与未知为 -1。 */
  size: number;
}

export interface SnapPage {
  title: string;
  shareState: number;
  /** 当前目录的条目总数。 */
  total: number;
  entries: ShareEntry[];
}

function parseEntry(raw: unknown): ShareEntry | null {
  const o = asObject(raw);
  if (!o) return null;
  const name = asString(o.n);
  const fid = asString(o.fid);
  const cid = asString(o.cid);
  const fc = asNumber(o.fc);
  const isDir = fc === null ? fid === "" : fc === 0;
  const id = isDir ? cid : fid;
  if (name === "" || id === "") return null;
  const size = asNumber(o.s);
  return { id, name, isDir, size: !isDir && size !== null && size >= 0 ? size : -1 };
}

export async function shareSnap(cookies: string, shareCode: string, receiveCode: string, dir: string, offset: number): Promise<SnapPage> {
  const stage = "列出分享目录";
  const query = encodeQuery({
    share_code: shareCode,
    receive_code: receiveCode,
    cid: dir,
    limit: String(SNAP_PAGE_LIMIT),
    offset: String(offset),
    asc: "0",
    format: "json",
  });
  const res = await request(SITE_NAME, stage, {
    url: `${SNAP_URL}?${query}`,
    headers: { Accept: "application/json, text/plain, */*" },
    cookies,
    userAgent: BROWSER_UA,
    referer: `${SHARE_REFERER}${shareCode}?password=${receiveCode}&`,
  });
  checkHttp(stage, res.status);
  const body = parseJsonObject(SITE_NAME, stage, quoteBigIds(res.body));
  checkState(stage, body);
  const data = asObject(body.data);
  if (!data) throw new SiteError(SITE_NAME, stage, "返回缺少分享数据", "network");
  const info = asObject(data.shareinfo);
  return {
    title: info ? asString(info.share_title) : "",
    shareState: asNumber(data.share_state) ?? (info ? (asNumber(info.share_state) ?? 1) : 1),
    total: asNumber(data.count) ?? 0,
    entries: asArray(data.list).flatMap((raw) => {
      const entry = parseEntry(raw);
      return entry ? [entry] : [];
    }),
  };
}

export interface ShareDownload {
  url: string;
  name: string;
  /** 字节数；未知为 -1。 */
  size: number;
  /** 取链响应下发的 Cookie（`k=v; …`），可能为 ""。 */
  cookies: string;
}

export async function shareDownurl(cookies: string, shareCode: string, receiveCode: string, fileId: string): Promise<ShareDownload> {
  const stage = "获取直链";
  const key = randomBytes(KEY_SIZE);
  const payload = JSON.stringify({ share_code: shareCode, receive_code: receiveCode, file_id: fileId });
  const res = await request(SITE_NAME, stage, {
    method: "POST",
    url: `${DOWNURL_URL}?t=${Math.floor(Date.now() / 1000)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json;charset=UTF-8" },
    body: formBody({ data: m115Encode(utf8Bytes(payload), key) }),
    cookies,
    userAgent: APP_UA,
  });
  checkHttp(stage, res.status);
  const body = parseJsonObject(SITE_NAME, stage, res.body);
  checkState(stage, body);
  const encoded = body.data;
  if (typeof encoded !== "string" || encoded === "") throw new SiteError(SITE_NAME, stage, "返回缺少下载信息", "network");
  let info: JsonObject;
  try {
    info = parseJsonObject(SITE_NAME, stage, utf8Decode(m115Decode(encoded, key)));
  } catch (e) {
    if (e instanceof SiteError) throw e;
    throw new SiteError(SITE_NAME, stage, "下载信息解密失败（站点协议可能已变更）", "network");
  }
  const link = asObject(info.url);
  const url = link ? asString(link.url) : "";
  if (url === "") throw new SiteError(SITE_NAME, stage, "没有可用的下载地址（目标可能是文件夹）", "unsupported");
  if (!parseUrl(url)) throw new SiteError(SITE_NAME, stage, "返回的下载地址格式不正确", "network");
  const size = asNumber(info.fs);
  return {
    url,
    name: asString(info.fn),
    size: size !== null && size >= 0 ? size : -1,
    cookies: mergeSetCookie("", res.headers["set-cookie"]),
  };
}

export interface ShareTree {
  title: string;
  /** `ManifestFile.id` 为文件 fid。 */
  files: ManifestFile[];
}

/** 广度优先列出起始目录下的全部文件；请求数与文件数超限给出明确错误。 */
export async function listTree(cookies: string, shareCode: string, receiveCode: string, startDir: string): Promise<ShareTree> {
  const files: ManifestFile[] = [];
  const queue: Array<{ dir: string; rel: string[] }> = [{ dir: startDir || "0", rel: [] }];
  let requests = 0;
  let title = "";
  while (queue.length > 0) {
    const { dir, rel } = queue.shift()!;
    let offset = 0;
    for (;;) {
      if (++requests > MAX_SNAP_REQUESTS) {
        throw new SiteError(SITE_NAME, "列出分享目录", `分享的目录结构太大，列完需要超过 ${MAX_SNAP_REQUESTS} 次请求（30 秒内无法完成）`, "limit");
      }
      const page = await shareSnap(cookies, shareCode, receiveCode, dir, offset);
      if (requests === 1) {
        title = page.title;
        if (page.shareState > 1) {
          throw new SiteError(SITE_NAME, "读取分享信息", SHARE_STATE_TEXT[page.shareState] ?? `分享状态异常（${page.shareState}）`, "notFound");
        }
      }
      for (const entry of page.entries) {
        if (entry.isDir) {
          queue.push({ dir: entry.id, rel: [...rel, entry.name] });
          continue;
        }
        files.push({ id: entry.id, name: entry.name, dirs: rel, ...(entry.size >= 0 ? { size: entry.size } : {}) });
        if (files.length > MAX_ITEMS) {
          throw new SiteError(SITE_NAME, "列出分享目录", `分享内文件超过 ${MAX_ITEMS} 个，一次最多下载 ${MAX_ITEMS} 个`, "limit");
        }
      }
      offset += page.entries.length;
      if (page.entries.length === 0 || offset >= page.total) break;
    }
  }
  return { title, files };
}
