/// <reference types="fluxdown-plugin-sdk/types/page" />
// Pixiv 作品页：右下角「下载原图」按钮。Pixiv 是单页应用，只在作品页显示。

import { artworkUrl, parseArtworkId } from "../sites/pixiv/link";
import { parseUrl } from "../core/url";
import { floatingButton, onUrlChange, sendTask } from "./kit";

function currentId(): string | null {
  const parsed = parseUrl(location.href);
  return parsed ? parseArtworkId(parsed) : null;
}

const button = floatingButton("下载原图", "解析并下载本作品的原图", async () => {
  const id = currentId();
  if (!id) throw new Error("当前不是作品页");
  await sendTask(artworkUrl(id));
  return "已发送下载任务";
});

onUrlChange(() => button.setVisible(currentId() !== null));
