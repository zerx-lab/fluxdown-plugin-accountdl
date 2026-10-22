// 115 网盘分享页脚本：右下角「直链下载」按钮，把当前分享（全部文件）交给下载器。
// 不联网：只从地址取分享码与提取码；取直链全在 resolver 里用浏览器登录 Cookie 完成。
// 提取码只在地址 `?password=` 里；地址没有时（页面输入后只存在页面状态里）弹窗向用户要，不去猜页面里的输入框。
// 页面里的当前目录只存在 React 状态里、不在地址上，脚本读不到，所以总是下载整个分享。
// 任务 URL 固定用 115.com（Cookie 作用域 .115.com），页面在 115cdn.com / anxia.com 也一样。

import { makeTaskUrl, parseSharePage } from "../sites/pan115/link";
import { parseUrl } from "../core/url";
import { floatingButton, onUrlChange, sendTask } from "./kit";

const RECEIVE_CODE_RE = /^[A-Za-z0-9]{1,16}$/;

function currentShare() {
  const url = parseUrl(location.href);
  return url ? parseSharePage(url) : null;
}

const button = floatingButton("直链下载", "解析当前分享（全部文件）并交给下载器", async () => {
  const share = currentShare();
  if (!share) throw new Error("当前页面不是分享页");
  let receiveCode = share.receiveCode;
  if (receiveCode === "") {
    receiveCode = (window.prompt("请输入这个分享的提取码（访问码）") ?? "").trim();
    if (!RECEIVE_CODE_RE.test(receiveCode)) throw new Error("没有有效的提取码");
  }
  await sendTask(makeTaskUrl({ shareCode: share.shareCode, receiveCode }));
  return "已加入下载队列，请在下载器里查看文件清单";
});

onUrlChange(() => button.setVisible(currentShare() !== null));
