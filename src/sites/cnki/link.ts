// 知网详情页与下载入口的纯函数（网页脚本与测试共用，不依赖 DOM 或 flux）。
//
// 知网没有 resolver：详情页（`kns.cnki.net/kcms2/article/abstract?v=…`）服务端渲染好了下载按钮，
// `#pdfDown` / `#cajDown` 就是普通的 `<a href="https://bar.cnki.net/bar/download/order?id=…">`（匿名抓取实测，
// 登录态不影响 href；未登录时点开才被 302 到 login.cnki.net）。网页脚本把这个链接原样交给 FluxDown，
// 扩展按该 URL 附上 .cnki.net 的浏览器 Cookie，下载引擎跟随重定向并带上 Referer（详情页）；
// 没有权限时终点是 HTML，引擎的「HTML 当二进制」保护会直接中止任务，不会存出损坏的 PDF。

import { hostIn } from "../../core/site";
import { safeFileName } from "../../core/names";
import { parseQuery, parseUrl } from "../../core/url";

export type Format = "pdf" | "caj";

export const FORMATS: Readonly<Record<Format, { readonly label: string; readonly ext: string }>> = {
  pdf: { label: "PDF", ext: "pdf" },
  caj: { label: "CAJ", ext: "caj" },
};

const CNKI_DOMAINS = ["cnki.net"] as const;

/** 是否为知网文献详情页（kns / oversea / chn.oversea 等 *.cnki.net 子域；仿冒域名 `kns.cnki.net.evil.com` 不算）。 */
export function isDetailPage(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || !hostIn(parsed.host, CNKI_DOMAINS)) return false;
  const path = parsed.path.toLowerCase();
  return /^\/kcms2\/article\/abstract\/?$/.test(path) || path.startsWith("/kcms/detail/");
}

/**
 * 是否为知网下载订单链接：返回原样（去首尾空白）的链接，否则 null。
 * 现行是 `bar.cnki.net/bar/download/order?id=…`，海外站是 `o.oversea.cnki.net/barnew/download/order?id=…`；
 * 旧版详情页（`kcms/detail/detail.aspx`）的按钮指向 `…/download.aspx?filename=…`。
 * 页面上同样是 `<a>` 的「HTML阅读」「原版阅读」也走 order 路径，区分靠按钮而不是链接，见 `pickDownloads`。
 */
export function downloadLink(href: string): string | null {
  const parsed = parseUrl(href);
  if (!parsed || !hostIn(parsed.host, CNKI_DOMAINS)) return null;
  const path = parsed.path.toLowerCase();
  const query = parseQuery(parsed.query);
  if (/^\/bar(new)?\/download\/order$/.test(path)) return query.id ? href.trim() : null;
  if (/^\/(kcms|kns8?)\/download\.aspx$/.test(path)) return query.filename ? href.trim() : null;
  return null;
}

/** 网页脚本从 DOM 收集的链接信息（纯数据，便于离线测试）。 */
export interface DownloadAnchor {
  /** `<a id>`。 */
  id: string;
  /** 最近的 `<li>` 的 class 串，没有则 ""。 */
  container: string;
  /** 按钮文字（已 trim）。 */
  text: string;
  /** 解析后的绝对链接。 */
  href: string;
}

function formatOf(anchor: DownloadAnchor): Format | null {
  if (anchor.id === "pdfDown" || /(^|\s)btn-dlpdf(\s|$)/.test(anchor.container) || /^PDF\s*下载$/i.test(anchor.text)) return "pdf";
  if (anchor.id === "cajDown" || /(^|\s)btn-dlcaj(\s|$)/.test(anchor.container) || /^CAJ\s*下载$/i.test(anchor.text)) return "caj";
  return null;
}

/**
 * 从页面链接里挑出 PDF / CAJ 下载入口。详情页在正文和固定工具栏各放一份同样的按钮，取文档顺序里第一个有效的。
 * 不是 order / download.aspx 链接（例如登录跳转、`javascript:`）的按钮忽略。
 */
export function pickDownloads(anchors: readonly DownloadAnchor[]): Partial<Record<Format, string>> {
  const found: Partial<Record<Format, string>> = {};
  for (const anchor of anchors) {
    const format = formatOf(anchor);
    if (!format || found[format]) continue;
    const link = downloadLink(anchor.href);
    if (link) found[format] = link;
  }
  return found;
}

/**
 * 论文标题清洗：折叠空白，去掉标题行尾部的「网络首发」「附视频」标签文字与页面标题后缀「- 中国知网」。
 * 标题栏的标签是 `<h1>` 里的 `<span>`，页面脚本取文本前会先移除，这里再兜底（隐藏的 span 也会进 textContent）。
 */
export function cleanTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  title = title.replace(/\s*[-–—_|]\s*中国知网$/, "");
  for (;;) {
    const next = title.replace(/\s*(网络首发|附视频)$/, "");
    if (next === title) break;
    title = next;
  }
  return title.trim();
}

/** 保存文件名：标题 + 格式扩展名（站点不在链接里给扩展名）；标题为空返回 undefined，让下载器按响应头命名。 */
export function downloadFileName(title: string, format: Format): string | undefined {
  const clean = cleanTitle(title);
  return clean === "" ? undefined : safeFileName(`${clean}.${FORMATS[format].ext}`);
}
