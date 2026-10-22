// 115 网盘（分享链接）：用浏览器里已登录的账号，把分享里的文件解析为直链。
//
// 任务 URL：`https://115.com/__accountdl/pan115?s=<share_code>[&p=<提取码>][&d=<起始目录 cid>]`（见 ./link.ts）。
// 初段：snap 广度优先列目录；只有一个文件时直接出直链，否则返回清单（条目 id = 文件 fid）。
// 二段（`resolverItem`）：app 接口 `share/downurl` 取该文件直链（不需要再列目录、也不需要转存）。
// 为什么不转存：200 MB 上限是 web 接口 `webapi.115.com/share/downurl` 自己的限制（页面常量 DOWN_LIMIT、p115client 文档）；
// app 接口没有记载这个限制（115driver / OpenList 以它取任意大小的分享文件），所以免转存、不改动用户网盘。
// 下载沿用 OpenList 的做法：取链用的 115 客户端 UA、无 Referer、不带账号 Cookie（115driver 称 CDN 直链不绑定 UA）。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { manifestResult } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import type { ResolveInput, Site } from "../../core/site";
import { APP_UA, listTree, shareDownurl } from "./api";
import { isTaskUrl, readTask, SITE_ID, SITE_NAME, type Pan115Task } from "./link";

const ITEM_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function directLink(cookies: string, task: Pan115Task, fileId: string, fallbackName: string): Promise<ResolveResult> {
  const dl = await shareDownurl(cookies, task.shareCode, task.receiveCode, fileId);
  return {
    url: dl.url,
    fileName: safeFileName(dl.name || fallbackName || `115-${fileId}`),
    ...(dl.size > 0 ? { totalBytes: dl.size } : {}),
    request: {
      // 直链不需要账号 Cookie：只带取链响应下发的 Cookie（通常为空），防止宿主把整串浏览器 Cookie 发给 CDN。
      cookies: dl.cookies,
      userAgent: APP_UA,
      referrer: "",
    },
  };
}

async function resolve(input: ResolveInput): Promise<ResolveResult> {
  const task = readTask(input.parsed);
  if (!task) throw new SiteError(SITE_NAME, "识别任务", "任务链接无效，请从分享页重新发起", "unsupported");
  if (input.cookies.trim() === "") {
    throw new SiteError(SITE_NAME, "检查登录", "没有检测到 115 登录信息：请先在浏览器登录 115，再从分享页的按钮发起下载", "login");
  }

  if (input.resolverItem) {
    if (!ITEM_RE.test(input.resolverItem)) throw new SiteError(SITE_NAME, "识别条目", "条目标识无效", "unsupported");
    return directLink(input.cookies, task, input.resolverItem, "");
  }

  const tree = await listTree(input.cookies, task.shareCode, task.receiveCode, task.dir);
  if (tree.files.length === 1) {
    const only = tree.files[0]!;
    return directLink(input.cookies, task, only.id, only.name);
  }
  return manifestResult(SITE_NAME, tree.title || `115分享-${task.shareCode}`, tree.files);
}

export const pan115: Site = {
  id: SITE_ID,
  name: SITE_NAME,
  // 只按主机与路径认领；参数非法由 resolve 报「任务链接无效」，比落到通用的「不支持的任务链接」更清楚。
  claims: isTaskUrl,
  resolve,
};
