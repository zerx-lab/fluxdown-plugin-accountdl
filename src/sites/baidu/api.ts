// 百度网盘 API 客户端（QuickJS，只用 flux.fetch）。请求链与错误码移植自 ops `baidu.go` / `baidu_transfer.go`：
//   share/verify → share/list → api/loginStatus → api/create → share/transfer → pcs locatedownload → api/filemanager(delete)
// 所有 pan 请求用安卓客户端 UA 发写操作（网页 UA 在「需验证」账号上写接口恒返回 -6，ops 2026-10-20 实测）。

import { mergeSetCookie, formatCookies, parseCookies } from "../../core/cookies";
import { SiteError, type ErrorKind } from "../../core/errors";
import { parseJsonObject, request, formBody } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { locateSign } from "./sign";
import { SITE_NAME } from "./link";

export const APP_ID = "250528";
export const PAN = "https://pan.baidu.com";
export const PCS = "https://pcs.baidu.com";
/** 网盘安卓客户端 UA：转存 / locatedownload 与返回的 CDN 直链都要求它。 */
export const ANDROID_UA =
  "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;";
/** 任务没带 UA 时验证 / 列目录用的浏览器 UA。 */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** 临时转存根目录；每次解析一个 `<unix>-<随机>` 子目录，返回前删除。 */
export const SCRATCH_ROOT = "/accountdl-tmp";

const PAGE_SIZE = 100;
const TRANSFER_POLLS = 8;
/** 一次初段解析最多发出的请求数（验证 + 列目录），超限让用户进入子目录分批。 */
export const MAX_LIST_REQUESTS = 20;

export interface ShareEntry {
  name: string;
  isDir: boolean;
  /** 分享内绝对路径（目录继续列目录用）。 */
  path: string;
  /** 文件 fs_id（十进制串，不经过 JS 数字）。 */
  fsid: string;
  size: number;
}

export interface ListPage {
  entries: ShareEntry[];
  shareId: string;
  uk: string;
  last: boolean;
}

function fail(stage: string, detail: string, kind: ErrorKind): never {
  throw new SiteError(SITE_NAME, stage, detail, kind);
}

function errnoOf(obj: JsonObject): number {
  return asNumber(obj.errno) ?? 0;
}

/** fs_id / share_id / uk / task_id 可能超过 2^53：JSON.parse 前先把长整数加引号，保持十进制原样。 */
function quoteBigInts(body: string): string {
  return body.replace(/"(fs_id|share_id|uk|from_uk|task_id)"\s*:\s*(\d{15,})/g, '"$1":"$2"');
}

/** 把 BDCLND 并入 Cookie 串（同名覆盖）。 */
export function withBdclnd(cookies: string, bdclnd: string): string {
  if (bdclnd === "") return cookies;
  const jar = parseCookies(cookies);
  jar.set("BDCLND", bdclnd);
  return formatCookies(jar);
}

export class BaiduClient {
  /** 已发出的请求数。 */
  requests = 0;

  constructor(
    private readonly cookies: string,
    private readonly browserUA: string,
  ) {}

  private async call(
    stage: string,
    method: "GET" | "POST",
    url: string,
    o: { form?: Record<string, string>; cookie?: string; referer: string; ua?: string },
  ): Promise<{ obj: JsonObject; setCookie: string }> {
    this.requests++;
    const res = await request(SITE_NAME, stage, {
      method,
      url,
      headers: o.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      body: o.form ? formBody(o.form) : undefined,
      cookies: o.cookie ?? this.cookies,
      userAgent: o.ua ?? ANDROID_UA,
      referer: o.referer,
    });
    if (res.status < 200 || res.status >= 300) fail(stage, `HTTP ${res.status}`, "network");
    return { obj: parseJsonObject(SITE_NAME, stage, quoteBigInts(res.body)), setCookie: res.headers["set-cookie"] ?? "" };
  }

  /** 验证提取码，返回要并入 Cookie 的 BDCLND（无提取码返回 ""，沿用浏览器 Cookie 里的 BDCLND）。 */
  async verifyShare(surl: string, pwd: string): Promise<string> {
    if (pwd === "") return "";
    const stage = "验证提取码";
    const q = formBody({ surl, t: String(Date.now()), channel: "chunlei", web: "1", app_id: APP_ID, clienttype: "0" });
    const { obj, setCookie } = await this.call(stage, "POST", `${PAN}/share/verify?${q}`, {
      form: { pwd, vcode: "", vcode_str: "" },
      referer: `${PAN}/share/init?surl=${surl}`,
      ua: this.browserUA,
    });
    const errno = errnoOf(obj);
    switch (errno) {
      case 0: {
        // BDCLND 在 Set-Cookie；缺失时 randsk 即其值（百度网页同样把 randsk 写成 BDCLND）。
        const fromCookie = parseCookies(mergeSetCookie("", setCookie)).get("BDCLND");
        if (fromCookie) return fromCookie;
        const randsk = asString(obj.randsk);
        if (randsk === "") fail(stage, "验证通过但没有返回会话凭据", "network");
        return safeUnescape(randsk);
      }
      case -9:
      case 200025:
        return fail(stage, "提取码错误", "password");
      case -6:
        return fail(stage, "百度登录已失效，请在浏览器重新登录百度网盘", "login");
      case 105:
      case 115:
      case 117:
      case 140:
      case 145:
        return fail(stage, "分享链接不存在或已失效", "notFound");
      case -62:
      case -19:
        return fail(stage, "触发验证码，请先在浏览器里打开该分享完成验证后重试", "limit");
      default:
        return fail(stage, asString(obj.show_msg) || `错误码 ${errno}`, "other");
    }
  }

  /** 列一页分享目录；`dir` 为 "" 列根目录。 */
  async listPage(surl: string, dir: string, bdclnd: string, page: number): Promise<ListPage> {
    const stage = "读取分享目录";
    if (this.requests >= MAX_LIST_REQUESTS) {
      fail(stage, "目录太大，一次解析请求次数超限，请进入子目录分批下载", "limit");
    }
    const q: Record<string, string> = {
      web: "5", app_id: APP_ID, channel: "chunlei", clienttype: "0",
      page: String(page), num: String(PAGE_SIZE), order: "name", desc: "0", shorturl: surl,
    };
    if (dir === "") q.root = "1";
    else q.dir = dir;
    const { obj } = await this.call(stage, "GET", `${PAN}/share/list?${formBody(q)}`, {
      cookie: withBdclnd(this.cookies, bdclnd),
      referer: `${PAN}/share/init?surl=${surl}`,
      ua: this.browserUA,
    });
    const errno = errnoOf(obj);
    switch (errno) {
      case 0:
        break;
      case -9:
        return fail(stage, "此分享需要提取码，或提取码已失效", "password");
      case 2:
        return fail(stage, "目录不存在", "notFound");
      case 105:
      case 115:
      case 117:
      case 140:
      case 145:
        return fail(stage, "分享链接不存在或已失效", "notFound");
      case -6:
        return fail(stage, "百度登录已失效，请在浏览器重新登录百度网盘", "login");
      case 9019:
        return fail(stage, "百度要求安全验证（9019），请先在浏览器完成验证", "limit");
      case 8001:
      case 9013:
        return fail(stage, "账号被限制，请检查账号状态", "limit");
      default:
        return fail(stage, asString(obj.show_msg) || `错误码 ${errno}`, "other");
    }
    const list = asArray(obj.list);
    const entries: ShareEntry[] = [];
    for (const v of list) {
      const m = asObject(v);
      const name = m ? asString(m.server_filename) : "";
      if (!m || name === "") continue;
      const isDir = asString(m.isdir) === "1";
      const path = asString(m.path);
      const fsid = asString(m.fs_id);
      if (isDir ? path === "" : !/^\d{1,20}$/.test(fsid)) continue;
      entries.push({ name, isDir, path, fsid, size: isDir ? -1 : (asNumber(m.size) ?? -1) });
    }
    return { entries, shareId: asString(obj.share_id), uk: asString(obj.uk), last: list.length < PAGE_SIZE };
  }

  /** 列出目录全部条目（翻页）。 */
  async listAll(surl: string, dir: string, bdclnd: string): Promise<ShareEntry[]> {
    const out: ShareEntry[] = [];
    for (let page = 1; ; page++) {
      const res = await this.listPage(surl, dir, bdclnd, page);
      out.push(...res.entries);
      if (res.last) return out;
    }
  }

  /** 账号的 bdstoken 与 uk（locatedownload 签名的 uid）。只有这里的 -6 判定登录失效。 */
  async account(): Promise<{ bdstoken: string; uid: string }> {
    const stage = "读取账号信息";
    const { obj } = await this.call(stage, "GET", `${PAN}/api/loginStatus?clienttype=0&app_id=${APP_ID}&web=1`, {
      referer: `${PAN}/disk/home`,
    });
    const errno = errnoOf(obj);
    if (errno === -6) fail(stage, "百度登录已失效，请在浏览器重新登录百度网盘", "login");
    if (errno !== 0) fail(stage, asString(obj.show_msg) || `错误码 ${errno}`, "other");
    const info = asObject(obj.login_info);
    let bdstoken = info ? asString(info.bdstoken) : "";
    const uid = info ? asString(info.uk) : "";
    if (bdstoken === "") {
      const fields = formBody({ clienttype: "0", app_id: APP_ID, web: "1", fields: '["bdstoken"]' });
      const t = await this.call(stage, "GET", `${PAN}/api/gettemplatevariable?${fields}`, { referer: `${PAN}/disk/home` });
      bdstoken = asString(asObject(t.obj.result)?.bdstoken);
    }
    if (bdstoken === "" || uid === "") fail(stage, "未返回 bdstoken 或 uk", "network");
    return { bdstoken, uid };
  }

  /** 会员等级 vip_type：0 普通 / 1 会员 / 2 SVIP；查询失败按 0（最保守）。 */
  async vipType(): Promise<number> {
    try {
      const { obj } = await this.call("读取会员等级", "GET", `${PAN}/api/user/getinfo?need_selfinfo=1&clienttype=0&app_id=${APP_ID}&web=1`, {
        referer: `${PAN}/disk/home`,
      });
      const rec = asObject(asArray(obj.records)[0]);
      const v = rec ? asNumber(rec.vip_type) : null;
      return v === 1 || v === 2 ? v : 0;
    } catch {
      return 0;
    }
  }

  /** 创建临时目录（含父目录）。 */
  async mkdir(bdstoken: string, dir: string): Promise<void> {
    const stage = "创建临时目录";
    const q = formBody({ a: "commit", clienttype: "0", app_id: APP_ID, web: "1", bdstoken });
    const { obj } = await this.call(stage, "POST", `${PAN}/api/create?${q}`, {
      form: { path: dir, isdir: "1", block_list: "[]" },
      referer: `${PAN}/disk/home`,
    });
    const errno = errnoOf(obj);
    if (errno === 0 || errno === -8) return; // -8：已存在
    if (errno === -6) fail(stage, "百度拒绝写入（-6），账号可能需要先在浏览器完成安全验证", "limit");
    if (errno === -10) fail(stage, "网盘空间不足，请清理空间后重试", "limit");
    fail(stage, asString(obj.show_msg) || `错误码 ${errno}`, "other");
  }

  /** 把分享文件转存进 `dir`，返回转存后的路径。 */
  async transfer(p: { bdstoken: string; bdclnd: string; key: string; shareId: string; uk: string; fsid: string; dir: string }): Promise<string> {
    const stage = "转存文件";
    const cookie = withBdclnd(this.cookies, p.bdclnd);
    const referer = `${PAN}/s/${p.key}`;
    const q = formBody({
      shareid: p.shareId, from: p.uk, bdstoken: p.bdstoken,
      app_id: APP_ID, channel: "chunlei", clienttype: "0", web: "1",
    });
    const { obj } = await this.call(stage, "POST", `${PAN}/share/transfer?${q}`, {
      form: { fsidlist: `[${p.fsid}]`, path: p.dir },
      cookie,
      referer,
    });
    const errno = errnoOf(obj);
    if (errno !== 0) transferError(stage, errno, obj);
    const direct = transferTarget(asObject(obj.extra)?.list, p.dir);
    if (direct !== "") return direct;
    const taskId = asString(obj.task_id);
    if (taskId === "" || taskId === "0") fail(stage, "接口未返回目标路径", "network");
    const tq = formBody({
      taskid: taskId, shareid: p.shareId, from: p.uk, bdstoken: p.bdstoken,
      app_id: APP_ID, channel: "chunlei", clienttype: "0", web: "1",
    });
    // QuickJS 没有定时器，无法等待：连续轮询，每次请求自身的往返就是间隔。
    for (let i = 0; i < TRANSFER_POLLS; i++) {
      const t = await this.call(stage, "GET", `${PAN}/share/taskquery?${tq}`, { cookie, referer });
      const e = errnoOf(t.obj);
      if (e !== 0) fail(stage, `查询任务错误码 ${e}`, "other");
      const te = asNumber(t.obj.task_errno) ?? 0;
      if (te !== 0) transferError(stage, te, t.obj);
      if (asString(t.obj.status) === "success") {
        const to = transferTarget(t.obj.list, p.dir);
        return to !== "" ? to : fail(stage, "任务完成但未返回目标路径", "network");
      }
    }
    return fail(stage, "转存任务超时未完成，请稍后重试", "limit");
  }

  /** locatedownload：取自有文件的 CDN 直链。 */
  async locate(bduss: string, uid: string, filePath: string): Promise<string> {
    const stage = "获取直链";
    const sign = locateSign(uid, bduss, Math.floor(Date.now() / 1000));
    const q = formBody({
      ant: "1", check_blue: "1", es: "1", esl: "1", app_id: APP_ID, method: "locatedownload", path: filePath,
      ver: "4.0", clienttype: "17", channel: "0", apn_id: "1_0", freeisp: "0", queryfree: "0", use: "0",
      ...sign,
    });
    const { obj } = await this.call(stage, "POST", `${PCS}/rest/2.0/pcs/file?${q}`, {
      cookie: `BDUSS=${bduss}`,
      referer: `${PAN}/disk/home`,
    });
    const errno = errnoOf(obj) || (asNumber(obj.error_code) ?? 0);
    if (errno === 9019 || errno === 8002) fail(stage, `百度临时风控（${errno}），请稍后再试`, "limit");
    if (errno === -6) fail(stage, "百度拒绝访问（-6），账号可能需要先在浏览器完成安全验证", "limit");
    if (errno !== 0) fail(stage, `错误码 ${errno}`, "other");
    for (const v of asArray(obj.urls)) {
      const m = asObject(v);
      if (!m || (asNumber(m.encrypt) ?? 0) !== 0) continue;
      const url = asString(m.url);
      if (/^https?:\/\//i.test(url)) return url;
    }
    return fail(stage, "接口未返回可用链接", "network");
  }

  /** 把路径移入回收站（回收站不占配额）。 */
  async remove(bdstoken: string, paths: string[]): Promise<void> {
    const stage = "删除临时目录";
    const q = formBody({
      opera: "delete", async: "2", onnest: "fail", bdstoken, newVerify: "1", clienttype: "0", app_id: APP_ID, web: "1",
    });
    const { obj } = await this.call(stage, "POST", `${PAN}/api/filemanager?${q}`, {
      form: { filelist: JSON.stringify(paths) },
      referer: `${PAN}/disk/home`,
    });
    const errno = errnoOf(obj);
    if (errno !== 0) fail(stage, `错误码 ${errno}`, "other");
  }
}

function safeUnescape(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 转存目标路径：优先 `to`，否则目标目录下源文件名。 */
function transferTarget(list: unknown, dir: string): string {
  const first = asObject(asArray(list)[0]);
  if (!first) return "";
  const to = asString(first.to);
  if (to !== "") return to;
  const from = asString(first.from);
  return from !== "" ? `${dir}/${from.slice(from.lastIndexOf("/") + 1)}` : "";
}

function transferError(stage: string, errno: number, obj: JsonObject): never {
  if (errno === 12) {
    const inner = asObject(asArray(obj.info)[0]);
    if (inner && asNumber(inner.errno) === -32) fail(stage, "网盘空间不足，请清理空间后重试", "limit");
  }
  switch (errno) {
    case 2:
      return fail(stage, "文件不在该分享中（可能已被分享者删除）", "notFound");
    case -9:
      return fail(stage, "提取码验证已失效，请重新验证提取码", "password");
    case -6:
      return fail(stage, "百度拒绝写入（-6），账号可能需要先在浏览器完成安全验证", "limit");
    case 9019:
    case 8002:
      return fail(stage, `百度临时风控（${errno}），请稍后再试`, "limit");
    default:
      return fail(stage, asString(obj.show_msg) || `错误码 ${errno}`, "other");
  }
}
