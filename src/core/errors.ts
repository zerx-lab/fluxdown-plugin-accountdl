// 带站点与失败阶段的错误。消息格式「<站点>·<阶段>：<详情>」，不含 Cookie、令牌、密码或带签名的直链。

/**
 * 错误类别：`login` = 未登录或登录态失效（去浏览器里重新登录该站点，再从网页按钮发起）；
 * `password` = 提取码缺失或错误；`notFound` = 分享/作品不存在或已失效；`limit` = 站点限流、配额或会员限制；
 * `network` = 传输失败或站点返回非预期内容；`unsupported` = 链接结构或资源类型不支持。
 */
export type ErrorKind = "login" | "password" | "notFound" | "limit" | "network" | "unsupported" | "other";

export class SiteError extends Error {
  readonly kind: ErrorKind;
  readonly detail: string;

  constructor(site: string, stage: string, detail: string, kind: ErrorKind = "other") {
    super(`${site}·${stage}：${detail}`);
    this.name = "SiteError";
    this.kind = kind;
    this.detail = detail;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
