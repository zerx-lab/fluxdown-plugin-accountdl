// 哔哩哔哩网页脚本：视频页 / 番剧页右下角加「直链下载」按钮，把当前页面（视频带当前分 P）交给下载器。
// 不联网解析：清晰度、分 P、会员内容由 resolver 用浏览器带来的登录 Cookie 处理。

import { canonicalUrl, parseBilibiliLink } from "../sites/bilibili/link";
import { parseUrl } from "../core/url";
import { floatingButton, onUrlChange, sendTask } from "./kit";

/** 当前页面对应的任务 URL；不是视频 / 番剧页返回 null。分 P 视频总是显式带 p（缺省为 P1），避免多 P 视频被当成整部清单。 */
function currentTaskUrl(): string | null {
  const parsed = parseUrl(location.href);
  const target = parsed ? parseBilibiliLink(parsed) : null;
  if (!target) return null;
  return target.kind === "video" ? canonicalUrl(target, target.page ?? 1) : canonicalUrl(target);
}

const button = floatingButton("直链下载", "用当前登录账号解析并下载本页视频", async () => {
  const url = currentTaskUrl();
  if (!url) throw new Error("当前页面不是视频页");
  await sendTask(url);
  return "已发送到下载器";
});

onUrlChange(() => button.setVisible(currentTaskUrl() !== null));
