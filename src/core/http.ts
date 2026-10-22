// flux.fetch 薄封装：统一错误（带站点与阶段）、状态与截断检查、JSON 解析。
// flux.fetch 不是标准 Fetch：body 为文本、headers 是普通记录（小写键）、无 Cookie jar、自动跟随重定向、
// 单请求 10 秒 / 8 MB（FluxDown `native/engine/src/plugin/bridge.rs`）。

import { SiteError } from "./errors";
import { asObject, type JsonObject } from "./json";

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** 作为 Cookie 头发送；空串不发。 */
  cookies?: string;
  userAgent?: string;
  referer?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 发出请求；传输失败与截断抛 `network` 错误。不检查状态码。 */
export async function request(site: string, stage: string, req: HttpRequest): Promise<HttpResponse> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.cookies) headers["Cookie"] = req.cookies;
  if (req.userAgent) headers["User-Agent"] = req.userAgent;
  if (req.referer) headers["Referer"] = req.referer;
  let res: Awaited<ReturnType<typeof flux.fetch>>;
  try {
    res = await flux.fetch({ method: req.method ?? "GET", url: req.url, headers, body: req.body });
  } catch (e) {
    throw new SiteError(site, stage, `网络请求失败（${e instanceof Error ? e.message : String(e)}）`, "network");
  }
  if (res.truncated) throw new SiteError(site, stage, "响应过大被截断", "network");
  return { status: res.status, headers: res.headers, body: res.body };
}

/** 请求并解析 JSON 对象；非 2xx 或非 JSON 抛 `network` 错误（401/403 归为 `login`）。 */
export async function requestJson(site: string, stage: string, req: HttpRequest): Promise<JsonObject> {
  const res = await request(site, stage, req);
  if (res.status === 401 || res.status === 403) throw new SiteError(site, stage, `HTTP ${res.status}，登录态无效或无权访问`, "login");
  if (res.status < 200 || res.status >= 300) throw new SiteError(site, stage, `HTTP ${res.status}`, "network");
  return parseJsonObject(site, stage, res.body);
}

export function parseJsonObject(site: string, stage: string, body: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new SiteError(site, stage, "返回的不是 JSON（站点可能改版或要求验证）", "network");
  }
  const obj = asObject(value);
  if (!obj) throw new SiteError(site, stage, "返回的 JSON 不是对象", "network");
  return obj;
}

/** 表单编码请求体。 */
export function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
