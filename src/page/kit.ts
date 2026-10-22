// 网页脚本公共件（运行在浏览器扩展 userScripts 的 isolated world）。
// - 按钮与提示放在 closed shadow root 里，样式与站点隔离；网页上不出现 FluxDown 名称或标志。
// - 节点只用 createElement / textContent 构建（站点数据当文本；站点可能启用 Trusted Types，不用 innerHTML）。
// - 交给 FluxDown：`fluxdown.download`。扩展会按 URL 附上浏览器里该站点的 Cookie（含 HttpOnly），
//   所以网盘类任务 URL 要用站点自己的主机（见 `src/core/task.ts`）。

const STYLE = `
:host { all: initial; }
.fab { position: fixed; right: 24px; bottom: 24px; z-index: 2147482000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 40px;
  padding: 0 16px; border-radius: 20px; background: #2563eb; color: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
  font: 500 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; }
button:hover { background: #1d4ed8; }
button[disabled] { opacity: .6; cursor: progress; }
.toast { max-width: 360px; padding: 10px 14px; border-radius: 8px; background: #0f172a; color: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; word-break: break-all; }
.toast.error { background: #b91c1c; }
`;

export interface FloatingButton {
  /** 显示或隐藏（单页应用切换路由时用）。 */
  setVisible(visible: boolean): void;
  toast(text: string, kind?: "info" | "error"): void;
}

/**
 * 右下角浮动按钮。点击时调用 `onClick`，期间按钮禁用；抛出的错误以红色提示显示，返回的字符串以普通提示显示。
 */
export function floatingButton(label: string, title: string, onClick: () => Promise<string | void>): FloatingButton {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const wrap = document.createElement("div");
  wrap.className = "fab";
  const button = document.createElement("button");
  button.type = "button";
  button.title = title;
  button.textContent = label;
  wrap.append(button);
  root.append(style, wrap);

  const toast = (text: string, kind: "info" | "error" = "info") => {
    const el = document.createElement("div");
    el.className = kind === "error" ? "toast error" : "toast";
    el.textContent = text;
    wrap.insertBefore(el, button);
    window.setTimeout(() => el.remove(), kind === "error" ? 8000 : 4000);
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    onClick()
      .then((msg) => {
        if (msg) toast(msg);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => {
        button.disabled = false;
      });
  });

  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };
  // 站点重绘可能移除我们的节点：DOM 变化时补挂。
  new MutationObserver(() => {
    if (host.style.display !== "none") mount();
  }).observe(document.documentElement, { childList: true });
  mount();

  return {
    setVisible(visible) {
      host.style.display = visible ? "" : "none";
    },
    toast,
  };
}

/** 交给 FluxDown 下载；失败抛错（消息可直接显示）。 */
export async function sendTask(url: string, filename?: string): Promise<void> {
  const res = await fluxdown.download({ url, referrer: location.href, ...(filename ? { filename } : {}) });
  if (!res.ok) throw new Error(res.message || "发送到下载器失败");
}

/** 单页应用路由变化：isolated world 看不到页面的 history 调用，轮询 location.href。 */
export function onUrlChange(callback: (href: string) => void): void {
  let last = location.href;
  callback(last);
  window.setInterval(() => {
    if (location.href === last) return;
    last = location.href;
    callback(last);
  }, 500);
}
