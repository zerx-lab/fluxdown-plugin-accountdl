// 百度网盘分享页脚本：右下角「直链下载」按钮，把当前分享（及当前目录、提取码）交给下载器。
// 不联网：只从 URL / hash / 页面状态取标识；取直链全在 resolver 里用浏览器登录 Cookie 完成。
// 提取码来源（按优先级）：地址 `?pwd=` → 页面验证后自存的 localStorage `<key>_pwd` → 提取码输入框。
// 都没有也可以：提取码验证过的会话在 BDCLND Cookie 里，随任务一起交给 resolver。

import { dirFromHash, makeTaskUrl, parseSharePage } from "../sites/baidu/link";
import { parseUrl } from "../core/url";
import { floatingButton, onUrlChange, sendTask } from "./kit";

const PWD_RE = /^[A-Za-z0-9]{4}$/;

function currentShare() {
  const url = parseUrl(location.href);
  return url ? parseSharePage(url) : null;
}

function readPassword(key: string, fromUrl: string): string {
  const candidates = [
    fromUrl,
    localStorage.getItem(`${key}_pwd`) ?? "",
    document.querySelector<HTMLInputElement>("#accessCode")?.value ?? "",
  ];
  return candidates.map((s) => s.trim()).find((s) => PWD_RE.test(s)) ?? "";
}

const button = floatingButton("直链下载", "解析当前分享（当前目录内全部文件）并交给下载器", async () => {
  const share = currentShare();
  if (!share) throw new Error("当前页面不是分享页");
  const url = parseUrl(location.href);
  const dir = dirFromHash(url?.fragment ?? "");
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  await sendTask(makeTaskUrl({ key: share.key, pwd: readPassword(share.key, share.pwd), dir, name }));
  return "已加入下载队列，请在下载器里查看文件清单";
});

onUrlChange(() => button.setVisible(currentShare() !== null));
