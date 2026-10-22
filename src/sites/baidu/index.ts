// 百度网盘：用用户浏览器里已登录的 Cookie（BDUSS 等）解析分享链接。
//
// 任务 URL 见 ./link.ts（`https://pan.baidu.com/__accountdl/baidu?s=…`，由分享页网页脚本生成）。
// 初段：验证提取码 → 递归列出分享目录 → 清单（条目 id = `<fs_id>[:<字节数>]`）。
// 二段（`resolverItem`）：验证提取码 → 转存到用户网盘临时目录 → pcs locatedownload 取直链 → 立即删除临时目录。
// 取直链为什么要转存：web `sharedownload` 对账号常返回 9019 / 加密结果；转存 + locatedownload 是 ops 实测可行的链路
// （../diskdirect/.omp/knowledge/decisions.md）。已签发直链在源文件删除后仍可用（ops 实测 1~12 分钟）。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import { parseCookies } from "../../core/cookies";
import { SiteError, errorMessage } from "../../core/errors";
import { manifestResult, MAX_ITEMS, type ManifestFile } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import type { Site } from "../../core/site";
import { ANDROID_UA, BROWSER_UA, BaiduClient, SCRATCH_ROOT } from "./api";
import { readTask, SITE_ID, SITE_NAME } from "./link";

/** 同时列目录的并发数（flux.fetch 全局并发 8，留给转存等其他请求）。 */
const LIST_CONCURRENCY = 4;
const MiB = 1024 * 1024;
/** 按会员等级 vip_type 0/1/2 的连接数上限（超过会被限速数小时，ops 采用 BaiduPCS-Rust 推荐值）。 */
const CONNECTIONS = [1, 10, 15] as const;
const FILE_ITEM_RE = /^(\d{1,20})(?::(\d{1,16}))?$/;

function requireLogin(cookies: string): string {
  const bduss = parseCookies(cookies).get("BDUSS") ?? "";
  if (bduss === "") {
    throw new SiteError(SITE_NAME, "检查登录", "没有检测到百度网盘登录信息：请先在浏览器登录百度网盘，再从分享页的按钮发起下载", "login");
  }
  return bduss;
}

async function listManifest(client: BaiduClient, surl: string, startDir: string, pwd: string, name: string): Promise<ResolveResult> {
  const bdclnd = await client.verifyShare(surl, pwd);
  const files: ManifestFile[] = [];
  let level: Array<{ dir: string; rel: string[] }> = [{ dir: startDir, rel: [] }];
  while (level.length > 0) {
    const next: Array<{ dir: string; rel: string[] }> = [];
    for (let i = 0; i < level.length; i += LIST_CONCURRENCY) {
      const chunk = level.slice(i, i + LIST_CONCURRENCY);
      const lists = await Promise.all(chunk.map((d) => client.listAll(surl, d.dir, bdclnd)));
      lists.forEach((entries, idx) => {
        const rel = chunk[idx].rel;
        for (const e of entries) {
          if (e.isDir) next.push({ dir: e.path, rel: [...rel, e.name] });
          else files.push({ id: e.size >= 0 ? `${e.fsid}:${e.size}` : e.fsid, name: e.name, dirs: rel, ...(e.size >= 0 ? { size: e.size } : {}) });
        }
      });
      if (files.length > MAX_ITEMS) {
        throw new SiteError(SITE_NAME, "读取分享目录", `文件超过 ${MAX_ITEMS} 个，请进入子目录分批下载`, "limit");
      }
    }
    level = next;
  }
  return manifestResult(SITE_NAME, name, files);
}

async function resolveFile(client: BaiduClient, bduss: string, task: { key: string; surl: string; pwd: string }, item: string): Promise<ResolveResult> {
  const m = FILE_ITEM_RE.exec(item);
  if (!m) throw new SiteError(SITE_NAME, "识别条目", "文件标识格式不正确", "unsupported");
  const fsid = m[1];
  const size = m[2] === undefined ? -1 : Number(m[2]);

  // 验证后列根目录只为拿 share_id / uk；账号信息与会员等级互相独立，一起发出。
  const [share, acct, vip] = await Promise.all([
    (async () => {
      const bdclnd = await client.verifyShare(task.surl, task.pwd);
      return { bdclnd, page: await client.listPage(task.surl, "", bdclnd, 1) };
    })(),
    client.account(),
    client.vipType(),
  ]);
  if (share.page.shareId === "" || share.page.uk === "") throw new SiteError(SITE_NAME, "读取分享信息", "未返回 share_id 或 uk", "notFound");

  const dir = `${SCRATCH_ROOT}/${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 10)}`;
  let to: string;
  let link: string;
  try {
    await client.mkdir(acct.bdstoken, dir);
    to = await client.transfer({
      bdstoken: acct.bdstoken, bdclnd: share.bdclnd, key: task.key,
      shareId: share.page.shareId, uk: share.page.uk, fsid, dir,
    });
    link = await client.locate(bduss, acct.uid, to);
  } finally {
    // 转存副本只需撑到取链完成；失败路径同样尽力删除，删除失败不覆盖原错误。
    try {
      await client.remove(acct.bdstoken, [dir]);
    } catch (e) {
      flux.logger.warn(`临时目录删除失败（${dir}）：${errorMessage(e)}`);
    }
  }

  const connections = CONNECTIONS[vip] ?? 1;
  return {
    url: link,
    fileName: safeFileName(to.slice(to.lastIndexOf("/") + 1)),
    ...(size >= 0 ? { totalBytes: size } : {}),
    request: {
      // 直链自带签名，只需要安卓 UA，不带任何网盘 Cookie（否则宿主会把整串浏览器 Cookie 发给 CDN）。
      cookies: "",
      userAgent: ANDROID_UA,
      maxConnections: connections,
      // CDN 单次 Range 硬上限 5 MiB（ops 实测）；非 SVIP 按 ops 的 4 MiB。
      maxRangeBytes: vip === 2 ? 5 * MiB : 4 * MiB,
      ...(size >= 0 ? { segments: Math.min(connections, Math.max(1, Math.floor(size / (4 * MiB)))) } : {}),
    },
  };
}

export const baidu: Site = {
  id: SITE_ID,
  name: SITE_NAME,
  claims: (url) => readTask(url) !== null,
  async resolve(input) {
    const task = readTask(input.parsed);
    if (!task) throw new SiteError(SITE_NAME, "识别任务", "任务链接参数不正确，请从分享页重新发起", "unsupported");
    const bduss = requireLogin(input.cookies);
    const client = new BaiduClient(input.cookies, input.userAgent || BROWSER_UA);
    if (input.resolverItem !== "") return resolveFile(client, bduss, task, input.resolverItem);
    const name = task.name || task.dir.slice(task.dir.lastIndexOf("/") + 1) || "百度网盘分享";
    return listManifest(client, task.surl, task.dir, task.pwd, name);
  },
};
