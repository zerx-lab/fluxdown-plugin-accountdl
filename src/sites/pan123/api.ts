// 123 云盘分享接口：列目录（递归）与取直链。移植自 ops `pan123.go`（OpenList drivers/123、123_share 同款链路）。
//
// 业务失败一律是 HTTP 200 + 非零 `code`：5103 提取码错误 / 分享不存在、5112 分享方提取流量包不足、
// 401 登录失效、400 参数异常；成功为 0。`www.123pan.com/b/api` 返回 404 网页，所以接口主机按
// `yun.123pan.com` → `www.123pan.cn` 回退（只在传输失败或返回非 JSON 时）。
// flux.fetch 自动跟随重定向、读不到 302 的 Location：取直链最后一步按「JSON 里的 redirect_url」与
// 「302 到文件」两种形态处理，见 `follow`。

import type { FluxFetchResponse } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { base64Decode, utf8Decode } from "../../core/hash";
import { request } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { MAX_ITEMS } from "../../core/manifest";
import { encodeQuery, parseQuery, parseUrl } from "../../core/url";
import { SITE_NAME } from "./link";
import { signPath } from "./sign";
import type { Auth } from "./token";

/** 接口需要这个 Referer / Origin（网页版 yun.123pan.com）；直链探测同样使用。 */
const WEB_REFERER = "https://yun.123pan.com/";
const WEB_ORIGIN = "https://yun.123pan.com";
/** ops 实测链路用的浏览器 UA；接口与直链下载都用它。 */
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const API_BASES = [
  { origin: "https://yun.123pan.com", prefix: "/b/api" },
  { origin: "https://www.123pan.cn", prefix: "/b/api" },
] as const;

const PAGE_LIMIT = 100;
/** 单次解析最多发出的目录请求数（30 秒总时限内留足取直链的时间）。 */
export const MAX_LIST_REQUESTS = 20;
const LIST_CONCURRENCY = 3;
/** 列目录阶段的时间预算；超出直接报错，免得撞上宿主 30 秒硬上限。 */
const LIST_DEADLINE_MS = 20_000;

export interface ShareEntry {
  id: string;
  name: string;
  isDir: boolean;
  /** 字节数；未知为 0。 */
  size: number;
  etag: string;
  s3Key: string;
}

export interface SharedFile {
  entry: ShareEntry;
  parentId: string;
  /** 相对分享根的目录名。 */
  dirs: string[];
}

export interface DirectLink {
  url: string;
  referrer: string;
}

function toEntry(value: unknown): ShareEntry | null {
  const obj = asObject(value);
  if (!obj) return null;
  const rawId = obj.FileId;
  // 超出安全整数的 id 经 JSON.parse 已失真，宁可报错也不下载错文件。
  if (typeof rawId === "number" && !Number.isSafeInteger(rawId)) {
    throw new SiteError(SITE_NAME, "读取分享目录", "文件标识超出可处理范围", "unsupported");
  }
  const id = asString(rawId);
  const name = asString(obj.FileName);
  if (id === "" || name === "") return null;
  const size = asNumber(obj.Size);
  return {
    id,
    name,
    isDir: asNumber(obj.Type) === 1,
    size: size !== null && size > 0 ? size : 0,
    etag: asString(obj.Etag),
    s3Key: asString(obj.S3KeyFlag),
  };
}

export class ShareClient {
  private listRequests = 0;
  private readonly deadline = Date.now() + LIST_DEADLINE_MS;

  constructor(
    readonly key: string,
    readonly pwd: string,
    private readonly auth: Auth,
  ) {}

  /** 调业务接口，返回 `data` 对象。 */
  private async call(method: "GET" | "POST", path: string, query: Record<string, string>, body: unknown, stage: string): Promise<JsonObject> {
    let lastError: SiteError | null = null;
    for (const base of API_BASES) {
      const [signKey, signValue] = signPath(`${base.prefix}${path}`, Date.now(), Math.floor(Math.random() * 10_000_001));
      const headers: Record<string, string> = { Origin: WEB_ORIGIN, platform: "web", "app-version": "3" };
      if (this.auth.token) headers["Authorization"] = `Bearer ${this.auth.token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let text: string;
      try {
        const res = await request(SITE_NAME, stage, {
          method,
          url: `${base.origin}${base.prefix}${path}?${encodeQuery({ ...query, [signKey]: signValue })}`,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          userAgent: BROWSER_UA,
          referer: WEB_REFERER,
        });
        text = res.body;
      } catch (e) {
        if (!(e instanceof SiteError)) throw e;
        lastError = e;
        continue;
      }
      let obj: JsonObject | null = null;
      try {
        obj = asObject(JSON.parse(text));
      } catch {
        // 非 JSON：换下一个接口主机。
      }
      if (!obj) {
        lastError = new SiteError(SITE_NAME, stage, "接口返回的不是 JSON（站点可能改版或要求验证）", "network");
        continue;
      }
      return this.unwrap(obj, stage);
    }
    throw lastError ?? new SiteError(SITE_NAME, stage, "请求接口失败", "network");
  }

  /** 按 `code` 归类业务响应。 */
  private unwrap(obj: JsonObject, stage: string): JsonObject {
    const code = asNumber(obj.code);
    if (code === 0) return asObject(obj.data) ?? {};
    const message = asString(obj.message).slice(0, 100);
    switch (code) {
      case 401: {
        const hint =
          this.auth.state === "ok"
            ? "登录已失效，请在浏览器重新登录 123 云盘后，再从分享页点击「直链下载」"
            : "该分享需要登录：请先在浏览器登录 123 云盘，再从分享页点击「直链下载」";
        throw new SiteError(SITE_NAME, stage, hint, "login");
      }
      case 5103:
        throw new SiteError(SITE_NAME, stage, message || "提取码错误或分享不存在", message.includes("提取码") ? "password" : "notFound");
      case 5112:
        throw new SiteError(SITE_NAME, stage, `${message || "分享方提取流量包不足"}（${this.trafficHint()}）`, "limit");
      case 400:
        throw new SiteError(SITE_NAME, stage, message || "请求参数异常", "other");
      default:
        throw new SiteError(SITE_NAME, stage, `${message || "接口返回异常"}（code ${code ?? "?"}）`, "other");
    }
  }

  private trafficHint(): string {
    if (this.auth.state === "ok") return "当前账号的下载流量可能不足";
    if (this.auth.state === "expired") return "登录已过期，已按未登录解析，会消耗分享者的提取流量；请重新登录 123 云盘后再试";
    return "未登录时会消耗分享者的提取流量；请先在浏览器登录 123 云盘，再从分享页点击「直链下载」";
  }

  private spendListRequest(): void {
    if (this.listRequests >= MAX_LIST_REQUESTS) {
      throw new SiteError(SITE_NAME, "读取分享目录", `分享内容过多（超过 ${MAX_ITEMS} 个文件或 ${MAX_LIST_REQUESTS} 次目录请求），无法一次列出`, "limit");
    }
    if (Date.now() > this.deadline) {
      throw new SiteError(SITE_NAME, "读取分享目录", "读取目录耗时过长，已中止", "limit");
    }
    this.listRequests++;
  }

  /** 一页目录；last 表示最后一页。 */
  private async listPage(dirId: string, page: number): Promise<{ items: ShareEntry[]; last: boolean }> {
    this.spendListRequest();
    const data = await this.call(
      "GET",
      "/share/get",
      {
        limit: String(PAGE_LIMIT),
        next: "0",
        orderBy: "file_id",
        orderDirection: "desc",
        parentFileId: dirId,
        Page: String(page),
        shareKey: this.key,
        SharePwd: this.pwd,
      },
      undefined,
      "读取分享目录",
    );
    if (data.Expired === true) throw new SiteError(SITE_NAME, "读取分享目录", "分享已过期", "notFound");
    const list = asArray(data.InfoList);
    const items: ShareEntry[] = [];
    for (const v of list) {
      const entry = toEntry(v);
      if (entry) items.push(entry);
    }
    return { items, last: list.length === 0 || asString(data.Next) === "-1" };
  }

  private async listDir(dirId: string): Promise<ShareEntry[]> {
    const out: ShareEntry[] = [];
    for (let page = 1; ; page++) {
      const { items, last } = await this.listPage(dirId, page);
      out.push(...items);
      if (last) return out;
    }
  }

  /** 递归列出整个分享（广度优先，目录请求并发 3 个），按目录先后顺序展平成文件列表。 */
  async walk(): Promise<SharedFile[]> {
    const listing = new Map<string, ShareEntry[]>();
    const seen = new Set<string>(["0"]);
    let level = ["0"];
    let fileCount = 0;
    while (level.length > 0) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += LIST_CONCURRENCY) {
        const batch = level.slice(i, i + LIST_CONCURRENCY);
        const results = await Promise.all(batch.map((id) => this.listDir(id)));
        batch.forEach((id, j) => {
          const entries = results[j]!;
          listing.set(id, entries);
          for (const e of entries) {
            if (!e.isDir) fileCount++;
            else if (!seen.has(e.id)) {
              seen.add(e.id);
              next.push(e.id);
            }
          }
        });
        if (fileCount > MAX_ITEMS) {
          throw new SiteError(SITE_NAME, "读取分享目录", `分享内容过多（超过 ${MAX_ITEMS} 个文件），无法一次列出`, "limit");
        }
      }
      level = next;
    }
    const files: SharedFile[] = [];
    const onPath = new Set<string>();
    const visit = (dirId: string, dirs: string[]): void => {
      onPath.add(dirId);
      for (const e of listing.get(dirId) ?? []) {
        if (!e.isDir) files.push({ entry: e, parentId: dirId, dirs });
        else if (!onPath.has(e.id)) visit(e.id, [...dirs, e.name]);
      }
      onPath.delete(dirId);
    };
    visit("0", []);
    return files;
  }

  /** 在父目录里按 id 找文件（清单二段解析用）。 */
  async findFile(fileId: string, parentId: string): Promise<ShareEntry> {
    for (let page = 1; ; page++) {
      const { items, last } = await this.listPage(parentId, page);
      const hit = items.find((e) => e.id === fileId);
      if (hit) {
        if (hit.isDir) throw new SiteError(SITE_NAME, "查找文件", "目标是文件夹，不是文件", "unsupported");
        return hit;
      }
      if (last) throw new SiteError(SITE_NAME, "查找文件", "文件不存在或已移出分享", "notFound");
    }
  }

  /** 取一个文件的直链。 */
  async downloadLink(entry: ShareEntry): Promise<DirectLink> {
    if (entry.isDir) throw new SiteError(SITE_NAME, "获取下载地址", "目标是文件夹，不是文件", "unsupported");
    if (!/^\d+$/.test(entry.id) || !Number.isSafeInteger(Number(entry.id))) {
      throw new SiteError(SITE_NAME, "获取下载地址", "文件标识格式不正确", "unsupported");
    }
    const fileId = Number(entry.id);
    const data = await this.call(
      "POST",
      "/share/download/info",
      {},
      { shareKey: this.key, SharePwd: this.pwd, etag: entry.etag, fileId, s3keyFlag: entry.s3Key, size: entry.size },
      "获取下载地址",
    );
    // 分享接口叫 DownloadURL，个人网盘接口叫 DownloadUrl。
    let downloadUrl = asString(data.DownloadURL) || asString(data.DownloadUrl);
    if (!parseUrl(downloadUrl)) downloadUrl = await this.downloadUrlV2(entry, fileId);
    return this.follow(downloadUrl);
  }

  /**
   * 备用接口：网页分享页当前用 `/v2/share/download/info`，返回 `dispatchList[0].prefix + downloadPath`
   * （源码依据：statics.123pan.com 分享页 bundle；登录后的返回未实测）。
   */
  private async downloadUrlV2(entry: ShareEntry, fileId: number): Promise<string> {
    const data = await this.call(
      "POST",
      "/v2/share/download/info",
      {},
      { ShareKey: this.key, SharePwd: this.pwd, FileID: fileId, S3keyFlag: entry.s3Key, Size: entry.size, Etag: entry.etag },
      "获取下载地址（备用接口）",
    );
    const prefix = asString(asObject(asArray(data.dispatchList)[0])?.prefix);
    const url = prefix + asString(data.downloadPath);
    if (!parseUrl(url)) throw new SiteError(SITE_NAME, "获取下载地址", "接口未返回下载地址", "network");
    return url;
  }

  /**
   * 处理下载地址（OpenList 123_share 同款）：`params` 是 base64 的真实地址，解码后 GET，
   * 返回 302（跳到文件）或 JSON `data.redirect_url`。
   * flux.fetch 自动跟随重定向，读不到 302 的 Location：JSON 形态能拿到 redirect_url；
   * 跳到文件的形态只能返回解码后的地址，由下载引擎自己跟随 302（Referer 仍用网页版）。
   */
  private async follow(downloadUrl: string): Promise<DirectLink> {
    const stage = "获取直链";
    const origin = parseUrl(downloadUrl);
    if (!origin) throw new SiteError(SITE_NAME, stage, "下载地址无效", "network");
    let target = downloadUrl;
    const params = parseQuery(origin.query).params;
    if (params) {
      let decoded = "";
      try {
        // 查询串里未转义的 `+` 已被解码成空格，先还原。
        decoded = utf8Decode(base64Decode(params.replace(/ /g, "+")));
      } catch {
        // 下面统一报错
      }
      if (!parseUrl(decoded)) throw new SiteError(SITE_NAME, stage, "下载地址参数无法解码（接口可能已改版）", "network");
      target = decoded;
    }

    // 不用 core/http 的 request：它把 truncated 当错误；这里若 CDN 无视 Range 返回整个文件，截断是预期内的。
    let res: FluxFetchResponse;
    try {
      res = await flux.fetch({ method: "GET", url: target, headers: { Referer: WEB_REFERER, "User-Agent": BROWSER_UA, Range: "bytes=0-0" } });
    } catch (e) {
      throw new SiteError(SITE_NAME, stage, `请求下载地址失败（${e instanceof Error ? e.message : String(e)}）`, "network");
    }
    if (res.status >= 400) throw new SiteError(SITE_NAME, stage, `下载地址返回 HTTP ${res.status}`, "network");
    const type = (res.headers["content-type"] ?? "").toLowerCase();
    if (type.startsWith("text/html")) {
      throw new SiteError(SITE_NAME, stage, "下载地址返回了网页而不是文件（可能需要验证或接口已改版）", "network");
    }
    const text = res.body.trim();
    const isFileSlice = res.status === 206 || res.headers["content-range"] !== undefined;
    if (!isFileSlice && !res.truncated && (type.includes("json") || text.startsWith("{"))) {
      let obj: JsonObject | null = null;
      try {
        obj = asObject(JSON.parse(text));
      } catch {
        // 只是以 { 开头的文件内容
      }
      // 接口形态的响应都带 code；没有 code 的 JSON 当作文件内容本身。
      if (obj && "code" in obj) {
        const redirect = asString(asObject(obj.data)?.redirect_url);
        if (parseUrl(redirect)) return { url: redirect, referrer: `${origin.scheme}://${origin.host}/` };
        throw new SiteError(SITE_NAME, stage, asString(obj.message).slice(0, 100) || "下载地址未返回直链", "network");
      }
    }
    return { url: target, referrer: WEB_REFERER };
  }
}
