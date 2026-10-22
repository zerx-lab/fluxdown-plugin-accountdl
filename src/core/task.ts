// 网盘类站点的任务 URL：`https://<站点主机>/__accountdl/<站点 id>?<参数>`。
// - 主机必须是站点自己的域名：网页脚本调 `fluxdown.download` 时，浏览器扩展按这个 URL 取浏览器 Cookie
//   随任务交给 FluxDown（resolver 的 `ctx.cookies`），这就是「用用户自己的账号」的来源。
// - 路径用专属前缀而不是真实分享路径：避免与 DiskDirect 等匹配分享链接的插件争同一个 URL（宿主会弹出选择），
//   也不会把用户在浏览器里的普通下载误交给本插件。站点并不存在这个路径，resolver 从不请求它。
// - 文件信息放查询串而不是片段：宿主去重会剥离 `#` 片段。

import { encodeQuery, parseQuery, type ParsedUrl } from "./url";

export const TASK_PREFIX = "/__accountdl/";

export function taskUrl(host: string, siteId: string, params: Record<string, string>): string {
  const query = encodeQuery(params);
  return `https://${host}${TASK_PREFIX}${siteId}${query ? `?${query}` : ""}`;
}

/** 本插件生成的任务 URL → 站点 id 与参数；不是返回 null。 */
export function parseTaskUrl(url: ParsedUrl): { siteId: string; params: Record<string, string> } | null {
  if (url.scheme !== "https" || !url.path.startsWith(TASK_PREFIX)) return null;
  const siteId = url.path.slice(TASK_PREFIX.length);
  if (!/^[a-z0-9]{1,16}$/.test(siteId)) return null;
  return { siteId, params: parseQuery(url.query) };
}
