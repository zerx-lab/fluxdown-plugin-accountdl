// 123 云盘分享页：右下角「直链下载」按钮。
// 网页不联网解析：只读 URL 里的分享标识、提取码和登录令牌。登录令牌在页面 localStorage / sessionStorage 的
// `authorToken`（不是 Cookie，扩展带不过来），先经 RPC 交给插件后台保存，再把任务交给下载器；
// 解析与列目录都在插件里用这个令牌完成。

import { errorMessage } from "../core/errors";
import { MAX_TOKEN_CHARS, normalizeToken } from "../sites/pan123/jwt";
import { parseSharePage, shareTaskUrl, storedPwd } from "../sites/pan123/link";
import { floatingButton, onUrlChange, sendTask } from "./kit";

function readStorage(storage: () => Storage, key: string): string {
  try {
    return storage().getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** 与站点同序：sessionStorage（未勾「记住我」）优先，再 localStorage。 */
function readAuthToken(): string {
  const token = normalizeToken(readStorage(() => sessionStorage, "authorToken")) || normalizeToken(readStorage(() => localStorage, "authorToken"));
  return token.length <= MAX_TOKEN_CHARS ? token : "";
}

const button = floatingButton("直链下载", "用当前登录的账号解析并下载整个分享", async () => {
  const share = parseSharePage(location.href);
  if (!share) throw new Error("当前页面不是分享页");
  const pwd = share.pwd || storedPwd(readStorage(() => localStorage, `sharePwd_${share.key}`));

  // 令牌为空表示网页未登录：让插件清掉旧令牌，避免沿用上次登录的账号。
  const token = readAuthToken();
  let loggedIn = false;
  let syncError = "";
  try {
    loggedIn = (await fluxdown.invoke<{ loggedIn: boolean }>("pan123.syncToken", { token })).loggedIn;
  } catch (e) {
    syncError = errorMessage(e);
  }

  await sendTask(shareTaskUrl(location.hostname, share.key, pwd));
  if (loggedIn) return "已加入下载，使用当前登录的账号解析";
  if (token !== "" && syncError !== "") return `${syncError}；已按未登录尝试解析`;
  return "已加入下载（未登录，仅在分享者开启流量包时可用）";
});

onUrlChange((href) => button.setVisible(parseSharePage(href) !== null));
