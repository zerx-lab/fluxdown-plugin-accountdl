// 蓝奏云（分享链接，免登录）。
//
// 任务 URL 就是真实分享链接 `https://<子域>.<域名>/<id>[?pwd=提取码]`（用户在 FluxDown 里直接粘贴也能用）；登录 Cookie 对分享解析没有用，
// 不发送 `input.cookies`。解析链（2026-10 匿名实测，见 test/fixtures/lanzou）：
//   文件：分享页 → iframe `/fn?…` → 内页里的 `domain1` + `downprocess` 表单 → POST 得 `{dom, url}` → 直链 `dom/file/url`。
//   带提取码的文件：分享页 `down_p()` 的表单（`sign` + `p` 提取码）直接 POST，返回里 `inf` 是文件名。
//   文件夹：分享页 `filemoreajax.php` 表单（`t` / `k` / `puid` … + 提取码）分页（每页 50 条）→ 清单，条目 id 为文件分享 id；二段解析按
//   `https://<同一主机>/<条目 id>` 当单文件解析。
// 直链 `dom/file/<token>` 是 302 到限时 CDN 地址，宿主 flux.fetch 读不到 Location，所以直链就交给下载引擎跟随重定向；需要的请求条件：
//   - Cookie `acw_sc__v2`：未带时返回 `var arg1=…` 挑战页，按 `acw.ts` 的算法算出（实测同一值可复用、跨 token 有效）；
//   - 请求头 `Accept-Language: zh-CN,zh`：缺失时返回「系统发现您的网络异常」验证页（需等待 2 秒再 POST，QuickJS 没有定时器，无法走完），
//     实测带上中文 Accept-Language 即直接 302；Referer 与 UA 无要求。
// 直链解析前用 `Range: bytes=0-0` 探一次：确认拿到的是文件不是挑战/验证页，顺带取总大小。

import type { FluxFetchResponse, ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { formBody, parseJsonObject, request, type HttpResponse } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { MAX_ITEMS, manifestResult, type ManifestFile } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import type { ResolveInput, Site } from "../../core/site";
import { calcAcwScV2, findChallenge } from "./acw";
import { parseShareLink, shareUrl, type ShareLink } from "./link";
import {
  decodeEntities,
  findIframePath,
  hasSubfolders,
  isGone,
  isPasswordFilePage,
  pageFileName,
  pageTitle,
  parseDownprocess,
  parseFolderCall,
  parseSize,
  stripComments,
} from "./parse";

export const SITE_NAME = "蓝奏云";

const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** 文件夹列表每页 50 条；至多取 21 页（比清单上限 1000 多探一页以判断是否超限）。 */
const PAGE_SIZE = 50;
const MAX_PAGES = Math.ceil(MAX_ITEMS / PAGE_SIZE) + 1;
const ITEM_ID_RE = /^[A-Za-z0-9]{5,32}$/;
/** 挑战页最多连续应答次数（同一请求）。 */
const MAX_CHALLENGES = 3;

/** 带 `acw_sc__v2` 挑战应答的请求会话：任何响应是挑战页就算出 Cookie 重发，之后的请求都带上。 */
class Session {
  private acw = "";

  constructor(readonly userAgent: string) {}

  /** 当前应答 Cookie（可能为 ""）。 */
  get acwValue(): string {
    return this.acw;
  }

  /** 按挑战页的 arg1 算出并记住 Cookie。 */
  answer(arg1: string): void {
    this.acw = calcAcwScV2(arg1);
  }

  async send(
    stage: string,
    req: { method?: string; url: string; headers?: Record<string, string>; body?: string; referer?: string },
  ): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await request(SITE_NAME, stage, {
        ...req,
        headers: { "Accept-Language": ACCEPT_LANGUAGE, ...(req.headers ?? {}) },
        cookies: this.acw ? `acw_sc__v2=${this.acw}` : "",
        userAgent: this.userAgent,
      });
      const arg1 = findChallenge(res.body);
      if (arg1 === null) {
        if (res.status < 200 || res.status >= 300) throw new SiteError(SITE_NAME, stage, `HTTP ${res.status}`, "network");
        return res;
      }
      if (attempt + 1 >= MAX_CHALLENGES) throw new SiteError(SITE_NAME, stage, "反爬验证（acw_sc__v2）未通过", "limit");
      this.answer(arg1);
    }
  }

  /** 读 HTML 页面（去注释）。 */
  async page(stage: string, url: string, referer?: string): Promise<string> {
    const res = await this.send(stage, { url, referer });
    return stripComments(res.body);
  }

  async postJson(stage: string, url: string, form: Record<string, string>, referer: string): Promise<JsonObject> {
    const res = await this.send(stage, {
      method: "POST",
      url,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(form),
      referer,
    });
    return parseJsonObject(SITE_NAME, stage, res.body);
  }
}

/** 站点返回的失败文案 → 错误类别。 */
function failure(stage: string, info: string): SiteError {
  const text = info.trim();
  if (/密码|提取码/.test(text)) return new SiteError(SITE_NAME, stage, text, "password");
  if (/取消分享|不存在|已删除|已失效/.test(text)) return new SiteError(SITE_NAME, stage, text, "notFound");
  if (/频繁|限制|次数|稍后/.test(text)) return new SiteError(SITE_NAME, stage, text, "limit");
  return new SiteError(SITE_NAME, stage, text || "站点返回失败", "network");
}

const NEED_PASSWORD = "该分享需要提取码：在分享页输入提取码后再点下载按钮，或在链接后加 ?pwd=提取码";

function pageChanged(stage: string): SiteError {
  return new SiteError(SITE_NAME, stage, "没有找到页面里的下载参数（蓝奏云可能改版）", "network");
}

/** 直链：确认拿到的是文件（而不是挑战 / 验证页），返回下载引擎需要的 Cookie 与总大小。 */
async function probeDirect(session: Session, dom: string, url: string): Promise<{ cookies: string; totalBytes?: number }> {
  const stage = "校验直链";
  for (let attempt = 0; ; attempt++) {
    const cookies = session.acwValue ? `down_ip=1; acw_sc__v2=${session.acwValue}` : "down_ip=1";
    let res: FluxFetchResponse;
    try {
      res = await flux.fetch({
        url,
        headers: {
          "Accept-Language": ACCEPT_LANGUAGE,
          Range: "bytes=0-0",
          Cookie: cookies,
          "User-Agent": session.userAgent,
          Referer: dom,
        },
      });
    } catch (e) {
      throw new SiteError(SITE_NAME, stage, `网络请求失败（${e instanceof Error ? e.message : String(e)}）`, "network");
    }
    const type = res.headers["content-type"] ?? "";
    if (/text\/html/i.test(type)) {
      const arg1 = findChallenge(res.body);
      if (arg1 !== null && attempt + 1 < MAX_CHALLENGES) {
        session.answer(arg1);
        continue;
      }
      throw new SiteError(SITE_NAME, stage, "蓝奏云要求下载前验证（网络异常），请稍后重试或先在浏览器里下载一次", "limit");
    }
    if (res.status < 200 || res.status >= 300) throw new SiteError(SITE_NAME, stage, `直链 HTTP ${res.status}`, "network");
    // 206：Content-Range 末尾是总大小；200（不支持 Range）且未截断时 Content-Length 就是总大小。
    const range = /\/(\d+)\s*$/.exec(res.headers["content-range"] ?? "");
    const length = res.status === 200 && !res.truncated ? asNumber(res.headers["content-length"]) : null;
    const totalBytes = range ? Number(range[1]) : length !== null && length > 0 ? length : undefined;
    return { cookies, ...(totalBytes !== undefined ? { totalBytes } : {}) };
  }
}

/** 下载接口返回 → 直链文件结果。`name` 为已知文件名（可为 ""）。 */
async function directResult(session: Session, stage: string, json: JsonObject, name: string): Promise<ResolveResult> {
  const zt = asNumber(json.zt);
  if (zt !== 1) {
    const info = typeof json.inf === "string" ? json.inf : "";
    throw zt === 4 ? new SiteError(SITE_NAME, stage, info || "请求过于频繁，请稍后重试", "limit") : failure(stage, info);
  }
  const dom = asString(json.dom).replace(/\/+$/, "");
  const token = asString(json.url);
  if (!/^https?:\/\//i.test(dom) || token === "") throw new SiteError(SITE_NAME, stage, "下载接口没有返回直链", "network");
  const url = `${dom}/file/${token}`;
  const { cookies, totalBytes } = await probeDirect(session, dom, url);
  const fileName = name === "" ? "" : safeFileName(name);
  return {
    url,
    ...(fileName ? { fileName } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    request: { cookies, referrer: dom, setHeaders: { "Accept-Language": ACCEPT_LANGUAGE } },
  };
}

/** 单文件分享（已读到分享页）。 */
async function fileFromPage(session: Session, link: ShareLink, pageUrl: string, page: string, pwd: string): Promise<ResolveResult> {
  const origin = `https://${link.host}`;
  if (isGone(page)) throw new SiteError(SITE_NAME, "读取分享页", "分享已取消或文件不存在", "notFound");

  if (isPasswordFilePage(page)) {
    if (pwd === "") throw new SiteError(SITE_NAME, "读取分享页", NEED_PASSWORD, "password");
    const call = parseDownprocess(page, origin, pwd);
    if (!call) throw pageChanged("读取分享页");
    const json = await session.postJson("获取直链", call.url, call.form, pageUrl);
    return directResult(session, "获取直链", json, typeof json.inf === "string" ? json.inf : "");
  }

  const iframe = findIframePath(page);
  if (!iframe) throw pageChanged("读取分享页");
  const innerUrl = `${origin}${iframe}`;
  const inner = await session.page("读取下载页", innerUrl, pageUrl);
  const call = parseDownprocess(inner, origin, "");
  if (!call) throw pageChanged("读取下载页");
  const json = await session.postJson("获取直链", call.url, call.form, innerUrl);
  return directResult(session, "获取直链", json, pageFileName(page));
}

async function resolveFile(session: Session, link: ShareLink, id: string, referer?: string): Promise<ResolveResult> {
  const pageUrl = shareUrl(link.host, id);
  const page = await session.page("读取分享页", pageUrl, referer);
  return fileFromPage(session, link, pageUrl, page, link.pwd);
}

/** 文件夹分享：分页取文件列表 → 清单。 */
async function resolveFolder(session: Session, link: ShareLink, pageUrl: string, page: string): Promise<ResolveResult> {
  if (isGone(page)) throw new SiteError(SITE_NAME, "读取分享页", "分享已取消或文件不存在", "notFound");
  const stage = "读取文件夹";
  const call = parseFolderCall(page, `https://${link.host}`, link.pwd);
  if (!call) throw pageChanged(stage);
  if (call.locked && link.pwd === "") throw new SiteError(SITE_NAME, stage, NEED_PASSWORD, "password");
  if (hasSubfolders(page)) {
    throw new SiteError(SITE_NAME, stage, "该文件夹含子文件夹（会员分享），暂不支持展开；请分别打开子文件夹链接下载", "unsupported");
  }

  const files: ManifestFile[] = [];
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const json = await session.postJson(stage, call.url, { ...call.form, pg: String(pg) }, pageUrl);
    const zt = asNumber(json.zt);
    const info = typeof json.info === "string" ? json.info : "";
    if (zt === 2) break; // 没有文件 / 已翻完
    if (zt === 3) throw new SiteError(SITE_NAME, stage, info || "提取码错误", "password");
    if (zt !== 1) throw failure(stage, info);
    const rows = asArray(json.text);
    for (const row of rows) {
      const o = asObject(row);
      const id = o ? asString(o.id) : "";
      // `t == 1` 是站点插入的推广条目，`id == -1` 是占位。
      if (!o || asNumber(o.t) === 1 || !ITEM_ID_RE.test(id)) continue;
      const size = parseSize(asString(o.size));
      files.push({ id, name: decodeEntities(asString(o.name_all)), ...(size !== undefined ? { size } : {}) });
    }
    if (rows.length < PAGE_SIZE) break;
    if (pg === MAX_PAGES) {
      throw new SiteError(SITE_NAME, stage, `文件夹内文件超过 ${MAX_ITEMS} 个，无法一次列出`, "limit");
    }
  }
  if (files.length > MAX_ITEMS) throw new SiteError(SITE_NAME, stage, `文件夹内文件超过 ${MAX_ITEMS} 个，无法一次列出`, "limit");
  const name = pageTitle(page) || link.id;
  return manifestResult(SITE_NAME, name, files);
}

async function resolveShare(input: ResolveInput, link: ShareLink): Promise<ResolveResult> {
  const session = new Session(input.userAgent || DEFAULT_UA);
  const pageUrl = shareUrl(link.host, link.id);

  if (input.resolverItem !== "") {
    if (!ITEM_ID_RE.test(input.resolverItem)) throw new SiteError(SITE_NAME, "识别条目", "清单条目标识无效", "unsupported");
    return resolveFile(session, link, input.resolverItem, pageUrl);
  }
  const page = await session.page("读取分享页", pageUrl);
  if (page.includes("filemoreajax.php")) return resolveFolder(session, link, pageUrl, page);
  return fileFromPage(session, link, pageUrl, page, link.pwd);
}

export const lanzou: Site = {
  id: "lanzou",
  name: SITE_NAME,
  claims: (url) => parseShareLink(url) !== null,
  async resolve(input) {
    const link = parseShareLink(input.parsed);
    if (!link) throw new SiteError(SITE_NAME, "识别链接", "不是蓝奏云分享链接", "unsupported");
    return resolveShare(input, link);
  },
};
