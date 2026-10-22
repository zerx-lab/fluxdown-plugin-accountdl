// 站点注册表。新增站点：`src/sites/<id>/index.ts` 导出 `Site`，加到这里，并同步 manifest 的
// `resolvers[0].match.urls` 与 `contributes.pageScripts`。顺序有意义：resolve 取首个 `claims` 命中的站点。
// 知网只有网页脚本（直接把站点自己的下载链接交给 FluxDown），没有 resolver，不在这里。

import { baidu } from "../sites/baidu";
import { bilibili } from "../sites/bilibili";
import { lanzou } from "../sites/lanzou";
import { pan115 } from "../sites/pan115";
import { pan123 } from "../sites/pan123";
import { pixiv } from "../sites/pixiv";
import { quark } from "../sites/quark";
import type { Site } from "./site";

export const SITES: readonly Site[] = [baidu, quark, pan123, pan115, lanzou, bilibili, pixiv];
