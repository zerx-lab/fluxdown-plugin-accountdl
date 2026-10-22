/// <reference types="fluxdown-plugin-sdk/types/page" />
// 知网文献详情页：右下角「直链下载 PDF / CAJ」按钮。
// 不联网：从页面 DOM 取站点自己渲染的下载链接（`#pdfDown` / `#cajDown`，指向 bar.cnki.net 的订单地址）和论文标题，
// 交给 `fluxdown.download`；扩展按该链接附上浏览器里的知网 Cookie（含机构 / 个人账号登录态），Referer 是本详情页。
// 链接在点击时才读取（页面可能延迟渲染按钮）；每个按钮只在页面上确有对应入口时显示。

import { cleanTitle, downloadFileName, FORMATS, isDetailPage, pickDownloads, type DownloadAnchor, type Format } from "../sites/cnki/link";
import { onUrlChange, sendTask } from "./kit";

const STYLE = `
:host { all: initial; }
.fab { position: fixed; right: 24px; bottom: 24px; z-index: 2147482000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; height: 40px; padding: 0 16px;
  border-radius: 20px; background: #2563eb; color: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
  font: 500 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; }
button:hover { background: #1d4ed8; }
button.caj { background: #fff; color: #2563eb; border: 1px solid #2563eb; }
button.caj:hover { background: #eff6ff; }
button[disabled] { opacity: .6; cursor: progress; }
.toast { max-width: 360px; padding: 10px 14px; border-radius: 8px; background: #0f172a; color: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; word-break: break-all; }
.toast.error { background: #b91c1c; }
`;

function collectAnchors(): DownloadAnchor[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (a) => ({
    id: a.id,
    container: a.closest("li")?.className ?? "",
    text: (a.textContent ?? "").trim(),
    href: a.href,
  }));
}

/** 标题栏 `<h1>` 里的 `<span>` 是「网络首发」「附视频」等标签，先移除再取文本；取不到退回页面标题。 */
function readTitle(): string {
  const h1 = document.querySelector(".brief h1, .wx-tit h1");
  if (h1) {
    const copy = h1.cloneNode(true) as Element;
    copy.querySelectorAll("span").forEach((span) => span.remove());
    const title = cleanTitle(copy.textContent ?? "");
    if (title) return title;
  }
  return cleanTitle(document.title);
}

/** 滑块验证弹层可见时（预载的弹层在屏幕外 top 为极大负值），订单链接会被拦到验证页。 */
function captchaShowing(): boolean {
  const el = document.querySelector("#tcaptcha_transform_dy");
  return el !== null && el.getBoundingClientRect().top >= 0;
}

async function download(format: Format): Promise<string> {
  const label = FORMATS[format].label;
  if (captchaShowing()) throw new Error("知网正在要求安全验证，请先在页面上完成验证再下载");
  const link = pickDownloads(collectAnchors())[format];
  if (!link) throw new Error(`页面上没有 ${label} 下载入口（该文献可能不提供，或页面还没加载完）`);
  await sendTask(link, downloadFileName(readTitle(), format));
  return `已发送 ${label} 下载任务（需要账号 / 机构的下载权限）`;
}

const host = document.createElement("div");
const root = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent = STYLE;
const wrap = document.createElement("div");
wrap.className = "fab";
root.append(style, wrap);

const buttons: Record<Format, HTMLButtonElement> = { pdf: document.createElement("button"), caj: document.createElement("button") };
for (const format of ["caj", "pdf"] as const) {
  const button = buttons[format];
  button.type = "button";
  button.className = format;
  button.textContent = `直链下载 ${FORMATS[format].label}`;
  button.title = `把本文的 ${FORMATS[format].label} 全文交给下载器`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    download(format)
      .then((msg) => toast(msg))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => {
        button.disabled = false;
      });
  });
  wrap.append(button);
}

function toast(text: string, kind: "info" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = kind === "error" ? "toast error" : "toast";
  el.textContent = text;
  wrap.insertBefore(el, wrap.firstChild);
  window.setTimeout(() => el.remove(), kind === "error" ? 8000 : 4000);
}

/** 按页面当前状态显示 / 隐藏：非详情页整体隐藏，按钮按入口是否存在各自显示。 */
function refresh(): void {
  const available = isDetailPage(location.href) ? pickDownloads(collectAnchors()) : {};
  for (const format of ["pdf", "caj"] as const) buttons[format].style.display = available[format] ? "" : "none";
  host.style.display = available.pdf || available.caj ? "" : "none";
  if (!host.isConnected) document.documentElement.append(host);
}

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    refresh();
  });
}

// 下载区可能由页面脚本延迟渲染，站点重绘也可能移除我们的节点：DOM 变化时重新评估。
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
onUrlChange(schedule);
