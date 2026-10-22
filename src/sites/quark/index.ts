// 夸克网盘（分享链接）：用浏览器里已登录的账号，把分享里的文件解析为直链。
//
// 任务 URL：`https://pan.quark.cn/__accountdl/quark?key=<pwd_id>[&pwd=<提取码>][&dir=<fid>]`（见 ./link.ts）。
// 初段：share/sharepage/token → 递归列目录；只有一个文件时直接出直链，否则返回清单（条目 id = `<所在目录 fid>:<fid>`）。
// 二段：重新取 stoken，在所在目录里找到文件（要它的 share_fid_token），免转存取链；被拒再转存到账号临时目录取链。

import { parseCookies } from "../../core/cookies";
import { SiteError } from "../../core/errors";
import { manifestResult } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import { parseTaskUrl } from "../../core/task";
import type { ResolveInput, Site } from "../../core/site";
import type { ResolveResult } from "fluxdown-plugin-sdk";
import { Conn, memberThreads, QuarkError, QUARK_REFERER, QUARK_UA, sizedSegments, SITE_NAME, type ShareFile } from "./api";
import { QUARK_HOST, readTaskParams, SITE_ID } from "./link";

const ITEM_RE = /^([A-Za-z0-9]{1,64}):([A-Za-z0-9]{1,64})$/;

/** 免转存取链被拒的原因里，转存可能解决的：不含登录、提取码、分享失效与传输失败。 */
function transferMayHelp(e: unknown): boolean {
  return e instanceof QuarkError && (e.kind === "other" || e.kind === "limit");
}

async function directLink(conn: Conn, key: string, stoken: string, file: ShareFile): Promise<ResolveResult> {
  let dl;
  let transferred = false;
  try {
    dl = await conn.downloadShared(key, stoken, file);
  } catch (e) {
    if (!transferMayHelp(e)) throw e;
    dl = await conn.downloadViaTransfer(key, stoken, file);
    transferred = true;
  }
  if (transferred) {
    // 清理以前转存、已过期的副本；失败不影响本次下载。
    try {
      await conn.purgeScratch(Math.floor(Date.now() / 1000));
    } catch {
      /* 忽略 */
    }
  }
  const size = dl.size >= 0 ? dl.size : file.size;
  const threads = sizedSegments(memberThreads(await conn.memberType()), size);
  const fileName = safeFileName(dl.name || file.name);
  return {
    url: dl.url,
    fileName,
    ...(size >= 0 ? { totalBytes: size } : {}),
    request: {
      // 直链只认账号会话：最小化为 __pus + __puus，同取链 UA 与 pan.quark.cn Referer。
      cookies: conn.directCookie(),
      userAgent: QUARK_UA,
      referrer: QUARK_REFERER,
      segments: threads,
      maxConnections: threads,
    },
  };
}

async function resolve(input: ResolveInput): Promise<ResolveResult> {
  const task = parseTaskUrl(input.parsed);
  const params = task ? readTaskParams(task.params) : null;
  if (!params) throw new SiteError(SITE_NAME, "识别任务", "任务链接无效，请从分享页重新发起", "unsupported");
  if (!parseCookies(input.cookies).get("__pus")) {
    throw new SiteError(SITE_NAME, "识别任务", "没有夸克登录态，请先在浏览器登录 pan.quark.cn，再从分享页发起", "login");
  }
  const conn = new Conn(input.cookies);
  const stoken = await conn.shareToken(params.key, params.password);

  if (input.resolverItem) {
    const m = ITEM_RE.exec(input.resolverItem);
    if (!m) throw new SiteError(SITE_NAME, "识别条目", "条目标识无效", "unsupported");
    const file = await conn.findShareFile(params.key, stoken, m[1], m[2]);
    return directLink(conn, params.key, stoken, file);
  }

  const files = await conn.listTree(params.key, stoken, params.dir);
  if (files.length === 1) return directLink(conn, params.key, stoken, files[0]);
  const name = `夸克分享-${params.key}`;
  return manifestResult(
    SITE_NAME,
    name,
    files.map((f) => ({ id: `${f.parent}:${f.fid}`, name: f.name, dirs: f.dirs, ...(f.size >= 0 ? { size: f.size } : {}) })),
  );
}

export const quark: Site = {
  id: SITE_ID,
  name: SITE_NAME,
  claims: (url) => url.host === QUARK_HOST && parseTaskUrl(url)?.siteId === SITE_ID,
  resolve,
};
