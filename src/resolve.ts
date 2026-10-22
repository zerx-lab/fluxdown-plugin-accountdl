// resolver 入口：按注册表分派。manifest 的 URL 匹配只是调度入口，由站点 `claims` 再按主机与路径结构判定。

import { defineResolver } from "fluxdown-plugin-sdk/runtime";
import { SiteError } from "./core/errors";
import { SITES } from "./core/registry";
import { parseTaskUrl } from "./core/task";
import { parseUrl } from "./core/url";

defineResolver(async (ctx) => {
  const parsed = parseUrl(ctx.url);
  if (!parsed) return null;
  const site = SITES.find((s) => s.claims(parsed));
  if (site) {
    return site.resolve({
      taskId: ctx.taskId,
      url: ctx.url,
      parsed,
      cookies: ctx.cookies ?? "",
      userAgent: ctx.userAgent ?? "",
      referrer: ctx.referrer ?? "",
      resolverItem: ctx.resolverItem ?? "",
    });
  }
  // 本插件生成的任务 URL 却没有站点认领：插件版本与任务不匹配，不能把不存在的路径当文件下载。
  if (parseTaskUrl(parsed)) throw new SiteError("账号直链", "识别任务", "不支持的任务链接（插件版本可能已更新，请从网页重新发起）", "unsupported");
  // 其他 URL（glob 的 `*` 会跨越查询串误匹配）：放行，按原 URL 下载。
  return null;
});
