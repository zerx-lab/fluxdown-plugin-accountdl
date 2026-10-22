// 蓝奏云分享页：右下角「直链下载」按钮。
// 网页不联网解析：只读当前地址里的分享标识和页面上已输入的提取码，把规范分享链接交给下载器；解析在插件里完成。
// 蓝奏云分享页里嵌有 iframe（`/fn?…` 下载入口），脚本只在顶层页面显示按钮。

import { parseShareText, shareUrl } from "../sites/lanzou/link";
import { floatingButton, onUrlChange, sendTask } from "./kit";

/** 元素当前是否显示（站点用 display:none 隐藏已解锁的提取码框）。 */
function isShown(selector: string): boolean {
  const el = document.querySelector(selector);
  return el !== null && el.getClientRects().length > 0;
}

if (window === window.top) {
  const button = floatingButton("直链下载", "解析当前分享并直接下载（文件夹可勾选文件）", async () => {
    const link = parseShareText(location.href);
    if (!link) throw new Error("当前页面不是分享页");
    // 提取码：页面上已输入的优先（文件 `#pwd` / 文件夹 `#pwd`），其次地址里的 ?pwd=。
    const typed = document.querySelector<HTMLInputElement>("#pwd")?.value.trim() ?? "";
    const pwd = typed || link.pwd;
    if (pwd === "" && (isShown("#passwddiv") || isShown("#pwdload"))) throw new Error("请先在页面输入提取码");
    await sendTask(shareUrl(link.host, link.id, pwd));
    return "已加入下载";
  });

  onUrlChange((href) => button.setVisible(parseShareText(href) !== null));
}
