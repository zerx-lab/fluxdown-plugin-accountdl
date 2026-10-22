// 123 云盘的离线替身：响应结构按 ops `helper_test.go` 的 fake123（对照真实匿名响应）与分享页 bundle 编写。
// 业务失败一律 HTTP 200 + 非零 code；成功 code 0。

import type { MockRequest, MockResponse } from "../../helpers";

export const GOOD_KEY = "abcd-efgh";
export const GOOD_PWD = "Ab12";
export const REAL_URL = "https://real.example.com/real";

type Page = Record<string, unknown>[];

export const TREE: Record<string, Page[]> = {
  "0": [
    [
      { FileId: 10, FileName: "Dir B", Type: 1, Size: 0 },
      { FileId: 1, FileName: "a.txt", Type: 0, Size: 5, Etag: "e1", S3KeyFlag: "s1" },
    ],
  ],
  "10": [
    [{ FileId: 2, FileName: "sub.txt", Type: 0, Size: 7, Etag: "e2", S3KeyFlag: "s2" }],
    [{ FileId: 11, FileName: "inner", Type: 1, Size: 0 }],
  ],
  "11": [[{ FileId: 3, FileName: "deep.bin", Type: 0, Size: 9, Etag: "e3", S3KeyFlag: "s3" }]],
};

export function makeJwt(expSec: number): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "HS256", typ: "JWT" })}.${seg({ id: 1, exp: expSec })}.c2lnbmF0dXJl`;
}

export function futureExp(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

export interface FakeOptions {
  tree?: Record<string, Page[]>;
  /** 接受的 Bearer 令牌；其余非空令牌得到 401。 */
  validTokens?: string[];
  /** 流量包耗尽的令牌（"" = 匿名）。 */
  exhausted?: string[];
  /** 直链地址的形态：redirect = 302 到文件（宿主自动跟随，探测拿到 206 的文件切片）；json = redirect_url。 */
  mode?: "redirect" | "json";
  /** share/download/info 返回的 DownloadURL（默认带 params）。 */
  downloadUrl?: string;
  /** v1 下载信息成功但不含地址，转备用接口。 */
  v1Empty?: boolean;
}

function reply(code: number, message: string, data: unknown): MockResponse {
  return { body: { code, message, data } };
}

export function bearer(req: MockRequest): string {
  const raw = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
  return raw.replace(/^Bearer /, "");
}

export function fake123(opts: FakeOptions = {}) {
  const tree = opts.tree ?? TREE;
  const valid = new Set(opts.validTokens ?? []);
  const exhausted = new Set(opts.exhausted ?? []);
  const downloadUrl = opts.downloadUrl ?? `https://dl.example.com/dl?params=${Buffer.from(REAL_URL).toString("base64")}&x=1`;
  return (req: MockRequest): MockResponse => {
    const url = new URL(req.url);
    const token = bearer(req);
    if (url.hostname === "real.example.com") {
      if (opts.mode === "json") return reply(0, "ok", { redirect_url: "https://cdn.example.com/j/a.txt?sig=2" });
      return { status: 206, headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-0/5" }, body: "h" };
    }
    if (token !== "" && !valid.has(token)) return reply(401, "cookie token is empty", null);
    const path = url.pathname;
    if (path === "/b/api/share/get") {
      const q = url.searchParams;
      if (q.get("shareKey") !== GOOD_KEY) return reply(5103, "此分享不存在", null);
      if (q.get("SharePwd") !== GOOD_PWD) return reply(5103, "提取码错误", null);
      const pages = tree[q.get("parentFileId") ?? ""] ?? [[]];
      const page = Number(q.get("Page") ?? "1");
      if (page > pages.length) return reply(0, "ok", { InfoList: [], Next: "-1" });
      return reply(0, "ok", { InfoList: pages[page - 1], Next: page < pages.length ? String(page + 1) : "-1" });
    }
    if (path === "/b/api/share/download/info") {
      if (exhausted.has(token)) return reply(5112, "分享方提取流量包不足", null);
      return reply(0, "ok", opts.v1Empty ? {} : { DownloadURL: downloadUrl });
    }
    if (path === "/b/api/v2/share/download/info") {
      return reply(0, "ok", { dispatchList: [{ prefix: "https://dl.example.com" }], downloadPath: `/v2dl?params=${Buffer.from(REAL_URL).toString("base64")}` });
    }
    return { status: 404, headers: { "content-type": "text/html" }, body: "<html>404</html>" };
  };
}
