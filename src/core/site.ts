// 站点契约。每个站点一个目录 `src/sites/<id>/`，导出一个 `Site` 对象，加入 `src/core/registry.ts`。
//
// 账号来源：用户在浏览器里登录站点，本插件的网页脚本在站点页面上调 `fluxdown.download(<任务 URL>)`，
// 扩展把浏览器里该 URL 对应的 Cookie（含 HttpOnly）随任务交给 FluxDown；resolver 用 `input.cookies` 以用户
// 自己的身份请求站点 API，拿到直链返回给宿主。插件不保存账号、不登录。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import type { ParsedUrl } from "./url";

export interface ResolveInput {
  taskId: string;
  /** 任务 URL 原文。 */
  url: string;
  parsed: ParsedUrl;
  /** 浏览器扩展随任务带来的 Cookie；从 FluxDown 里直接粘贴链接建任务时为 ""。 */
  cookies: string;
  /** 任务 UA（扩展会补浏览器真实 UA）；可能为 ""。 */
  userAgent: string;
  referrer: string;
  /** 清单二段解析的条目 id；初段为 ""。 */
  resolverItem: string;
}

/** 页面 RPC 处理器：args 是网页传来的不可信输入；pageUrl 是宿主给的调用页面（已校验属于 `page.hosts`）。 */
export type PageHandler = (args: unknown, pageUrl: ParsedUrl) => Promise<unknown>;

export interface Site {
  /** `[a-z0-9]{1,16}`，用于任务 URL 与 RPC 名前缀。 */
  readonly id: string;
  /** 中文显示名，用于错误消息前缀。 */
  readonly name: string;
  /**
   * 是否由本站点解析该任务 URL。manifest `match.urls` 只是调度入口（glob 会跨段误匹配），这里必须再按
   * 主机名与路径结构判定。
   */
  claims(url: ParsedUrl): boolean;
  /**
   * 解析。返回单文件（`url`，可带 `audioUrl` / `fileName` / `request`）或多文件 `manifest`。
   * **必须显式设置 `request.cookies`**（直链需要的最小 Cookie，或 `""`）：否则宿主会把任务上的整串浏览器
   * Cookie 原样发给直链主机（FluxDown `native/engine/src/intercept/patch.rs`：补丁 cookies 覆盖任务 Cookie）。
   */
  resolve(input: ResolveInput): Promise<ResolveResult>;
  /** 需要 main 协助的网页脚本 RPC（例如把网页 localStorage 里的令牌交给插件）。main 以 `<id>.<name>` 注册。 */
  readonly page?: {
    /** 允许调用的页面主机（精确匹配或其子域）。 */
    readonly hosts: readonly string[];
    readonly rpc: Readonly<Record<string, PageHandler>>;
  };
}

/** 主机是否为 domain 本身或其子域。 */
export function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
