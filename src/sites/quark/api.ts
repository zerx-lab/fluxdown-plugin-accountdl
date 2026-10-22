// 夸克网盘 drive-pc API 客户端（移植自 ops `netdisk/quark.go`、`quark_transfer.go`，请求链来自 YunX QuarkApi /
// AList quark_uc）。一个 `Conn` 对应一次解析：持有当前 Cookie，按 Set-Cookie 轮换 `__puus`，登录失效时用 `__pus`
// 刷新一次后重试。QuickJS 里没有定时器，转存任务的轮询不等待（每次请求本身就是间隔），次数有上限。

import { mergeSetCookie, parseCookies, formatCookies, pickCookies } from "../../core/cookies";
import { SiteError, type ErrorKind } from "../../core/errors";
import { request } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { parseUrl } from "../../core/url";

export const SITE_NAME = "夸克网盘";

/** 夸克 PC 客户端 UA：接口与 CDN 都认它；换浏览器 UA 取大文件直链会返回 23018（ops 2026-10-20 实测）。 */
export const QUARK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch";
export const QUARK_ORIGIN = "https://pan.quark.cn";
export const QUARK_REFERER = `${QUARK_ORIGIN}/`;
export const DRIVE_BASE = "https://drive-pc.quark.cn";
/** 登录态 Cookie：`__pus` 长效登录，`__puus` 短效会话（由网盘经 Set-Cookie 轮换）；直链 CDN 只需要这两个。 */
export const SESSION_COOKIES = ["__pus", "__puus"] as const;

const PAGE_SIZE = 100;
/** 整个任务 30 秒硬上限：目录列表最多这么多次请求。 */
export const MAX_LIST_REQUESTS = 20;
export const MAX_FILES = 1000;
const TASK_POLLS = 15;
const ROOT_PAGES = 10;
const MAX_FIND_PAGES = 20;

/** 转存临时目录：账号根目录下一个固定名目录，里面每次转存一个 `<unix 秒>-<hex>` 子目录。 */
export const SCRATCH_ROOT = "accountdl-tmp";
export const SCRATCH_TTL_SEC = 6 * 3600;

export class QuarkError extends SiteError {
  readonly code: number;
  constructor(stage: string, detail: string, kind: ErrorKind, code: number) {
    super(SITE_NAME, stage, detail, kind);
    this.name = "QuarkError";
    this.code = code;
  }
}

function codeOf(obj: JsonObject): number {
  return asNumber(obj.code) ?? 0;
}

function loggedOut(status: number, obj: JsonObject): boolean {
  const code = codeOf(obj);
  return status === 401 || code === 31001 || code === 20002;
}

/** 失败响应 → 错误。错误码来自 clouddrive-auto-save docs/quark_apis.md（41007-41012 / 24000-24001）与 YunX（31001、41006）。 */
export function driveError(stage: string, obj: JsonObject): QuarkError {
  const code = codeOf(obj);
  switch (code) {
    case 31001:
    case 20002:
      return new QuarkError(stage, "登录已失效，请在浏览器重新登录 pan.quark.cn 后再发起", "login", code);
    case 41008:
      return new QuarkError(stage, "此分享需要提取码", "password", code);
    case 41007:
    case 41009:
    case 24000:
      return new QuarkError(stage, "提取码错误", "password", code);
    case 41006:
    case 41012:
    case 24001:
      return new QuarkError(stage, "分享不存在、已取消或已失效", "notFound", code);
    case 41010:
      return new QuarkError(stage, "分享文件涉及违规内容，无法访问", "notFound", code);
    case 23018:
      return new QuarkError(stage, "该文件超出可直接下载的额度（需要会员或网盘空间）", "limit", code);
  }
  const msg = asString(obj.message);
  if (/capacity|容量|空间不足/i.test(msg)) return new QuarkError(stage, "账号网盘空间不足，无法转存", "limit", code);
  return new QuarkError(stage, msg || `错误码 ${code}`, "other", code);
}

/** 把响应里轮换出的会话 Cookie（只认 `__pus` / `__puus`）并入 Cookie 串。 */
export function rotateSession(cookie: string, setCookie: string | undefined): string {
  if (!setCookie) return cookie;
  const fresh = parseCookies(mergeSetCookie("", setCookie));
  const jar = parseCookies(cookie);
  for (const name of SESSION_COOKIES) {
    const value = fresh.get(name);
    if (value) jar.set(name, value);
  }
  return formatCookies(jar);
}

export interface ShareFile {
  fid: string;
  name: string;
  isDir: boolean;
  /** 分享内字节数；目录或未知为 -1。 */
  size: number;
  /** 所在目录 fid（根为 "0"）。 */
  parent: string;
  /** 免转存取链与转存都要的文件令牌。 */
  fidToken: string;
}

export interface Download {
  url: string;
  name: string;
  size: number;
}

export interface ListedFile extends ShareFile {
  dirs: string[];
}

export class Conn {
  cookie: string;
  private refreshed = false;

  constructor(cookie: string) {
    this.cookie = cookie;
  }

  /** 最小化后的直链 Cookie（只含 `__pus` / `__puus`）。 */
  directCookie(): string {
    return pickCookies(this.cookie, SESSION_COOKIES);
  }

  private async once(stage: string, method: string, url: string, body: unknown): Promise<{ status: number; obj: JsonObject }> {
    const res = await request(SITE_NAME, stage, {
      method,
      url,
      cookies: this.cookie,
      userAgent: QUARK_UA,
      referer: QUARK_REFERER,
      headers: {
        Origin: QUARK_ORIGIN,
        Accept: "application/json, text/plain, */*",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.cookie = rotateSession(this.cookie, res.headers["set-cookie"]);
    let obj: JsonObject | null = null;
    try {
      obj = asObject(JSON.parse(res.body));
    } catch {
      obj = null;
    }
    if (!obj) {
      if (res.status === 401) throw new QuarkError(stage, "登录已失效，请在浏览器重新登录 pan.quark.cn 后再发起", "login", 31001);
      throw new SiteError(SITE_NAME, stage, `HTTP ${res.status}，返回的不是 JSON（站点可能改版或要求验证）`, "network");
    }
    return { status: res.status, obj };
  }

  /** `/config` 不带 `__puus` 请求，网盘用 `__pus` 重发新的 `__puus`（AList quark_uc refreshPuus）。 */
  private async refresh(): Promise<void> {
    this.refreshed = true;
    const full = this.cookie;
    const jar = parseCookies(full);
    jar.delete("__puus");
    this.cookie = formatCookies(jar);
    try {
      await this.once("刷新会话", "GET", `${DRIVE_BASE}/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=`, undefined);
    } catch {
      /* 刷新失败：沿用原 Cookie，下面按原错误报告 */
    }
    if (!parseCookies(this.cookie).get("__puus")) this.cookie = full;
  }

  /** 调用 drive-pc 接口；登录失效时刷新会话后重试一次。返回响应对象（不检查 code）。 */
  private async drive(stage: string, method: string, path: string, query: Record<string, string>, body?: unknown): Promise<JsonObject> {
    let url = `${DRIVE_BASE}${path}?pr=ucpro&fr=pc&uc_param_str=`;
    for (const [k, v] of Object.entries(query)) url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    for (;;) {
      const { status, obj } = await this.once(stage, method, url, body);
      if (loggedOut(status, obj) && this.cookie !== "" && !this.refreshed) {
        await this.refresh();
        continue;
      }
      return obj;
    }
  }

  private async data(stage: string, method: string, path: string, query: Record<string, string>, body?: unknown): Promise<{ data: unknown; obj: JsonObject }> {
    const obj = await this.drive(stage, method, path, query, body);
    if (codeOf(obj) !== 0) throw driveError(stage, obj);
    return { data: obj.data, obj };
  }

  /** 分享标识 + 提取码 → stoken。 */
  async shareToken(key: string, password: string): Promise<string> {
    const { data } = await this.data("读取分享", "POST", "/1/clouddrive/share/sharepage/token", {}, {
      pwd_id: key,
      passcode: password,
      support_visit_limit_private_share: true,
    });
    const stoken = asString(asObject(data)?.stoken);
    if (!stoken) throw new SiteError(SITE_NAME, "读取分享", "未返回 stoken", "network");
    return stoken;
  }

  /** 列分享目录的一页；last 表示最后一页。 */
  async sharePage(key: string, stoken: string, dir: string, page: number): Promise<{ files: ShareFile[]; last: boolean }> {
    const { data, obj } = await this.data("读取分享目录", "GET", "/1/clouddrive/share/sharepage/detail", {
      pwd_id: key,
      stoken,
      pdir_fid: dir,
      force: "0",
      ver: "2",
      _page: String(page),
      _size: String(PAGE_SIZE),
      _fetch_banner: "0",
      _fetch_share: "0",
      _fetch_total: "1",
      _sort: "file_type:asc,file_name:asc",
    });
    const list = asArray(asObject(data)?.list);
    const files: ShareFile[] = [];
    for (const v of list) {
      const it = asObject(v);
      if (!it) continue;
      const fid = asString(it.fid);
      const name = asString(it.file_name);
      if (!fid || !name) continue;
      const isDir = it.dir === true;
      const size = asNumber(it.size);
      files.push({
        fid,
        name,
        isDir,
        size: !isDir && size !== null && size >= 0 ? size : -1,
        parent: dir,
        fidToken: asString(it.share_fid_token),
      });
    }
    let last = list.length < PAGE_SIZE;
    const total = asNumber(asObject(obj.metadata)?._total);
    if (total !== null && page * PAGE_SIZE >= total) last = true;
    return { files, last };
  }

  /** 递归列出 dir 下所有文件（广度优先）。超出请求或文件数上限给出明确错误。 */
  async listTree(key: string, stoken: string, dir: string): Promise<ListedFile[]> {
    const out: ListedFile[] = [];
    const queue: Array<{ fid: string; dirs: string[] }> = [{ fid: dir, dirs: [] }];
    let requests = 0;
    const tooBig = () =>
      new SiteError(SITE_NAME, "读取分享目录", `内容过多（超过 ${MAX_LIST_REQUESTS} 次列目录请求或 ${MAX_FILES} 个文件），请进入子目录后分批下载`, "limit");
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (let page = 1; ; page++) {
        if (++requests > MAX_LIST_REQUESTS) throw tooBig();
        const { files, last } = await this.sharePage(key, stoken, cur.fid, page);
        for (const f of files) {
          if (f.isDir) queue.push({ fid: f.fid, dirs: [...cur.dirs, f.name] });
          else if (out.push({ ...f, dirs: cur.dirs }) > MAX_FILES) throw tooBig();
        }
        if (last) break;
      }
    }
    return out;
  }

  /** 在 parent 目录里按 fid 找文件（二段解析）。 */
  async findShareFile(key: string, stoken: string, parent: string, fid: string): Promise<ShareFile> {
    for (let page = 1; page <= MAX_FIND_PAGES; page++) {
      const { files, last } = await this.sharePage(key, stoken, parent, page);
      const hit = files.find((f) => f.fid === fid);
      if (hit) {
        if (hit.isDir) throw new SiteError(SITE_NAME, "读取分享目录", "目标是文件夹，不能直接下载", "unsupported");
        return hit;
      }
      if (last) break;
    }
    throw new SiteError(SITE_NAME, "读取分享目录", "分享中找不到该文件（分享内容可能已变更）", "notFound");
  }

  private async download(body: unknown): Promise<Download> {
    const { data } = await this.data("获取直链", "POST", "/1/clouddrive/file/download", { sys: "win32", ve: "3.23.2" }, body);
    const it = asObject(asArray(data)[0]);
    if (!it) throw new SiteError(SITE_NAME, "获取直链", "未返回下载地址", "network");
    const url = asString(it.download_url);
    if (!parseUrl(url)) throw new SiteError(SITE_NAME, "获取直链", "返回的下载地址无效", "network");
    const size = asNumber(it.size);
    return { url, name: asString(it.file_name), size: size !== null && size >= 0 ? size : -1 };
  }

  /** 带分享凭证免转存取链。 */
  downloadShared(key: string, stoken: string, f: ShareFile): Promise<Download> {
    return this.download({ fids: [f.fid], fids_token: [f.fidToken], pwd_id: key, stoken, speedup_session: "", token: "" });
  }

  /** 转存到账号临时目录，取账号自己那份文件的直链。副本保留（删源后直链是否有效未验证），过期副本由 purgeScratch 清理。 */
  async downloadViaTransfer(key: string, stoken: string, f: ShareFile): Promise<Download> {
    const root = await this.scratchRoot(true);
    const dir = await this.mkdir(root, scratchName());
    const { data } = await this.data("转存文件", "POST", "/1/clouddrive/share/sharepage/save", {}, {
      fid_list: [f.fid],
      fid_token_list: [f.fidToken],
      to_pdir_fid: dir,
      pwd_id: key,
      stoken,
      pdir_fid: f.parent,
      scene: "link",
    });
    const task = asString(asObject(data)?.task_id);
    if (!task) throw new SiteError(SITE_NAME, "转存文件", "未返回任务", "network");
    const fid = await this.waitSave(task);
    return this.download({ fids: [fid] });
  }

  private async waitSave(task: string): Promise<string> {
    for (let i = 0; i < TASK_POLLS; i++) {
      const { data } = await this.data("转存文件", "GET", "/1/clouddrive/task", { task_id: task, retry_index: String(i) });
      const m = asObject(data);
      const status = asNumber(m?.status);
      if (status === 2) {
        const fid = asString(asArray(asObject(m?.save_as)?.save_as_top_fids)[0]);
        if (!fid) throw new SiteError(SITE_NAME, "转存文件", "任务未返回新文件", "network");
        return fid;
      }
      if (status === 3) throw driveError("转存文件", { code: -1, message: asString(m?.message) || "转存任务失败" });
    }
    throw new SiteError(SITE_NAME, "转存文件", "等待转存超时", "network");
  }

  private async ownPage(dir: string, page: number): Promise<{ files: Array<{ fid: string; name: string; isDir: boolean }>; last: boolean }> {
    const { data } = await this.data("读取账号目录", "GET", "/1/clouddrive/file/sort", {
      pdir_fid: dir,
      _page: String(page),
      _size: String(PAGE_SIZE),
      _fetch_total: "1",
      _fetch_sub_dirs: "0",
      _sort: "file_type:asc,file_name:asc",
    });
    const list = asArray(asObject(data)?.list);
    const files = list.flatMap((v) => {
      const it = asObject(v);
      const fid = asString(it?.fid);
      return it && fid ? [{ fid, name: asString(it.file_name), isDir: it.dir === true }] : [];
    });
    return { files, last: list.length < PAGE_SIZE };
  }

  private async scratchRoot(create: boolean): Promise<string> {
    for (let page = 1; page <= ROOT_PAGES; page++) {
      const { files, last } = await this.ownPage("0", page);
      const hit = files.find((f) => f.isDir && f.name === SCRATCH_ROOT);
      if (hit) return hit.fid;
      if (last) break;
    }
    return create ? this.mkdir("0", SCRATCH_ROOT) : "";
  }

  private async mkdir(parent: string, name: string): Promise<string> {
    const { data } = await this.data("创建临时目录", "POST", "/1/clouddrive/file", {}, {
      pdir_fid: parent,
      file_name: name,
      dir_path: "",
      dir_init_lock: false,
    });
    const fid = asString(asObject(data)?.fid);
    if (!fid) throw new SiteError(SITE_NAME, "创建临时目录", "未返回目录标识", "network");
    return fid;
  }

  /** 删除超过 TTL 的转存副本目录；其他条目不动。 */
  async purgeScratch(nowSec: number): Promise<void> {
    const root = await this.scratchRoot(false);
    if (!root) return;
    const stale: string[] = [];
    for (let page = 1; page <= ROOT_PAGES; page++) {
      const { files, last } = await this.ownPage(root, page);
      for (const f of files) if (f.isDir && scratchExpired(f.name, nowSec)) stale.push(f.fid);
      if (last) break;
    }
    if (stale.length === 0) return;
    await this.data("清理临时目录", "POST", "/1/clouddrive/file/delete", {}, { action_type: 2, filelist: stale, exclude_fids: [] });
  }

  /** 会员等级 `member_type`；查询失败为 ""。 */
  async memberType(): Promise<string> {
    try {
      const { data } = await this.data("会员信息", "GET", "/1/clouddrive/member", { fetch_subscribe: "true" });
      return asString(asObject(data)?.member_type);
    } catch {
      return "";
    }
  }
}

function scratchName(): string {
  let hex = "";
  for (let i = 0; i < 8; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `${Math.floor(Date.now() / 1000)}-${hex}`;
}

export function scratchExpired(name: string, nowSec: number): boolean {
  const m = /^(\d{1,12})-/.exec(name);
  return m !== null && nowSec - Number(m[1]) > SCRATCH_TTL_SEC;
}

/** 每个线程至少 4 MiB（ops sizedSegments）；大小未知保持 want。 */
export function sizedSegments(want: number, size: number): number {
  if (size < 0) return want;
  const n = Math.ceil(size / (4 << 20));
  return Math.max(1, Math.min(want, n));
}

/**
 * 夸克直链每个 Range 请求被签名 `sp=100` 限速约 100 KB/s（ops 2026-10-20 SVIP 实测：1/8/16/32/64 并发 →
 * 0.1/0.8/1.65/约 21/约 20 MB/s），速度靠并发。付费档给更多线程；免费与未知档保守取 8。
 */
export function memberThreads(memberType: string): number {
  switch (memberType) {
    case "SUPER_VIP":
    case "EXP_SVIP":
    case "Z_VIP":
      return 32;
    case "VIP":
    case "EXP_VIP":
      return 16;
    default:
      return 8;
  }
}
