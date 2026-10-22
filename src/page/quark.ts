// 夸克网盘分享页：右下角「直链下载」按钮。只从地址 / localStorage 取分享标识、提取码与当前目录，
// 交给下载器（扩展会带上浏览器里 pan.quark.cn 的登录 Cookie）；所有解析在下载器那边完成。

import { parseSharePage, sharePageTaskUrl } from "../sites/quark/link";
import { floatingButton, onUrlChange, sendTask } from "./kit";

/** 页面验证提取码后，站点把 `[{ key, code, ts }]` 记在 localStorage `share_code_cache`（与 diskdirect 实测一致）。 */
function savedPassword(key: string): string {
  try {
    const cache: unknown = JSON.parse(localStorage.getItem("share_code_cache") ?? "null");
    if (!Array.isArray(cache)) return "";
    const hit: unknown = cache.find((e: unknown) => typeof e === "object" && e !== null && Reflect.get(e, "key") === key);
    const code = typeof hit === "object" && hit !== null ? Reflect.get(hit, "code") : null;
    return typeof code === "string" ? code.trim() : "";
  } catch {
    return "";
  }
}

const button = floatingButton("直链下载", "用已登录的账号解析并下载这个分享", async () => {
  const page = parseSharePage(location.href);
  if (!page) throw new Error("当前页面不是夸克网盘分享页");
  const password = page.password || savedPassword(page.key);
  await sendTask(sharePageTaskUrl({ ...page, password }));
  return page.dir ? "已发送当前文件夹，请在下载器里选择文件" : "已发送，请在下载器里选择文件";
});

onUrlChange((href) => button.setVisible(parseSharePage(href) !== null));
