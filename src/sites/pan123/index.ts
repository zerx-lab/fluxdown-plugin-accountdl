// 123 云盘：解析分享链接。登录令牌在网页 localStorage 里（不在 Cookie），由网页脚本经 RPC `pan123.syncToken`
// 交给 main 存进 `flux.storage`，这里解析时取用；没有令牌时匿名解析（分享者开启流量包时可用）。
//
// 任务 URL：`https://<分享页主机>/__accountdl/pan123?key=<分享标识>&pwd=<提取码>`（整个分享，清单形式）。
// 清单条目 id：`<文件 id>:<父目录 id>`；二段解析时回到父目录按 id 找到文件的 etag / S3KeyFlag / 大小再取直链。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { asObject } from "../../core/json";
import { manifestResult } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import type { ResolveInput, Site } from "../../core/site";
import { parseTaskUrl } from "../../core/task";
import { BROWSER_UA, ShareClient, type ShareEntry } from "./api";
import { MAX_TOKEN_CHARS, checkToken } from "./jwt";
import { isShareHost, parseShareTask, SHARE_DOMAINS, SITE_ID, SITE_NAME } from "./link";
import { clearToken, loadAuth, saveToken } from "./token";

const ITEM_ID_RE = /^(\d+):(\d+)$/;

async function fileResult(client: ShareClient, entry: ShareEntry): Promise<ResolveResult> {
  const link = await client.downloadLink(entry);
  return {
    url: link.url,
    fileName: safeFileName(entry.name),
    ...(entry.size > 0 ? { totalBytes: entry.size } : {}),
    // 直链不需要任何浏览器 Cookie；显式置空，免得宿主把任务上的整串 Cookie 发给 CDN。
    request: { cookies: "", referrer: link.referrer, userAgent: BROWSER_UA },
  };
}

async function resolve(input: ResolveInput): Promise<ResolveResult> {
  const share = parseShareTask(input.parsed);
  if (!share) throw new SiteError(SITE_NAME, "识别任务", "任务链接缺少有效的分享标识，请从分享页重新发起", "unsupported");
  const client = new ShareClient(share.key, share.pwd, await loadAuth(Math.floor(Date.now() / 1000)));

  if (input.resolverItem !== "") {
    const m = ITEM_ID_RE.exec(input.resolverItem);
    if (!m) throw new SiteError(SITE_NAME, "识别任务", "条目标识无效", "unsupported");
    return fileResult(client, await client.findFile(m[1]!, m[2]!));
  }

  const files = await client.walk();
  // 整个分享只有一个文件：不必让用户在清单里勾选，直接取直链。
  if (files.length === 1) return fileResult(client, files[0]!.entry);
  return manifestResult(
    SITE_NAME,
    `分享 ${share.key}`,
    files.map((f) => ({
      id: `${f.entry.id}:${f.parentId}`,
      name: f.entry.name,
      dirs: f.dirs,
      ...(f.entry.size > 0 ? { size: f.entry.size } : {}),
    })),
  );
}

/**
 * 页面 RPC：同步网页里的登录令牌。args = `{ token }`；token 为空串表示网页已退出登录，清除已存的令牌。
 * 令牌过期同样清除并报 login 错误（网页据此提示，并仍可匿名发起）。返回值不含令牌。
 */
async function syncToken(args: unknown): Promise<{ loggedIn: boolean; expiresAt: number }> {
  const raw = asObject(args)?.token;
  if (typeof raw !== "string" || raw.length > MAX_TOKEN_CHARS * 2) {
    throw new SiteError(SITE_NAME, "同步登录态", "参数无效", "unsupported");
  }
  if (raw.trim() === "") {
    await clearToken();
    return { loggedIn: false, expiresAt: 0 };
  }
  const checked = checkToken(raw, Math.floor(Date.now() / 1000));
  if (checked.kind === "shape") throw new SiteError(SITE_NAME, "同步登录态", "登录令牌格式无效", "unsupported");
  if (checked.kind === "expired") {
    await clearToken();
    throw new SiteError(SITE_NAME, "同步登录态", "登录已过期，请先在 123 云盘重新登录", "login");
  }
  await saveToken(checked.token, checked.exp);
  return { loggedIn: true, expiresAt: checked.exp };
}

export const pan123: Site = {
  id: SITE_ID,
  name: SITE_NAME,
  claims: (url) => isShareHost(url.host) && parseTaskUrl(url)?.siteId === SITE_ID,
  resolve,
  page: { hosts: SHARE_DOMAINS, rpc: { syncToken } },
};
