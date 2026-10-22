// 哔哩哔哩链接识别：纯函数，不依赖 flux，网页脚本与 resolver 共用。
// 认领的页面：
//   /video/BV1xxxxxxxxx、/video/av<数字>（可带 ?p=N 分 P）
//   /bangumi/play/ep<数字>（单集）、/bangumi/play/ss<数字>（整季）
// 主机必须精确是 www / m / 裸域名：`www.bilibili.com.evil.com`、`evilbilibili.com` 都不认。

import { parseQuery, type ParsedUrl } from "../../core/url";

export const BILI_HOSTS: readonly string[] = ["www.bilibili.com", "bilibili.com", "m.bilibili.com"];

export type BiliTarget =
  /** 普通投稿；`id` 是 BV 号（`idKey === "bvid"`）或 av 号数字（`"aid"`）。`page` 为 null 表示 URL 没指定分 P。 */
  | { kind: "video"; idKey: "bvid" | "aid"; id: string; page: number | null }
  /** 番剧 / 影视的单集（ep 号）。 */
  | { kind: "episode"; id: string }
  /** 番剧 / 影视的整季（ss 号）。 */
  | { kind: "season"; id: string };

const VIDEO_PATH = /^\/video\/(?:(BV[0-9A-Za-z]{10})|av(\d{1,19}))\/?$/i;
const BANGUMI_PATH = /^\/bangumi\/play\/(?:ep(\d{1,12})|ss(\d{1,12}))\/?$/i;

export function parseBilibiliLink(url: ParsedUrl): BiliTarget | null {
  if (!BILI_HOSTS.includes(url.host)) return null;
  const video = VIDEO_PATH.exec(url.path);
  if (video) {
    const page = parsePage(parseQuery(url.query)["p"]);
    if (video[1]) return { kind: "video", idKey: "bvid", id: `BV${video[1].slice(2)}`, page };
    return { kind: "video", idKey: "aid", id: video[2], page };
  }
  const bangumi = BANGUMI_PATH.exec(url.path);
  if (bangumi) {
    if (bangumi[1]) return { kind: "episode", id: bangumi[1] };
    return { kind: "season", id: bangumi[2] };
  }
  return null;
}

/** `?p=` 取值：正整数才算指定；`0`、负数、非数字都当没指定（站点页面也是回到 P1）。 */
function parsePage(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,4}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

/** 规范化的页面 URL（去掉跟踪参数）；`page` 覆盖目标里的分 P。网页脚本把它交给下载器当任务 URL。 */
export function canonicalUrl(target: BiliTarget, page: number | null = target.kind === "video" ? target.page : null): string {
  switch (target.kind) {
    case "video": {
      const path = target.idKey === "bvid" ? target.id : `av${target.id}`;
      return `https://www.bilibili.com/video/${path}${page !== null ? `?p=${page}` : ""}`;
    }
    case "episode":
      return `https://www.bilibili.com/bangumi/play/ep${target.id}`;
    case "season":
      return `https://www.bilibili.com/bangumi/play/ss${target.id}`;
  }
}
