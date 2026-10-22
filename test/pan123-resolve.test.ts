import { describe, expect, test } from "bun:test";
import { SiteError } from "../src/core/errors";
import { parseUrl } from "../src/core/url";
import { pan123 } from "../src/sites/pan123";
import { shareTaskUrl } from "../src/sites/pan123/link";
import { fake123, futureExp, GOOD_KEY, GOOD_PWD, makeJwt, REAL_URL, type FakeOptions } from "./fixtures/pan123/fake";
import { header, installFlux, type MockRequest } from "./helpers";

const TOKEN = makeJwt(futureExp());
const STORED_TOKEN = { "pan123.auth": JSON.stringify({ token: TOKEN, exp: futureExp() }) };

function resolve(opts: { key?: string; pwd?: string; item?: string; cookies?: string } = {}) {
  const url = shareTaskUrl("1.share.123pan.cn", opts.key ?? GOOD_KEY, opts.pwd ?? GOOD_PWD);
  return pan123.resolve({
    taskId: "t1",
    url,
    parsed: parseUrl(url)!,
    cookies: opts.cookies ?? "",
    userAgent: "",
    referrer: "",
    resolverItem: opts.item ?? "",
  });
}

async function failure(p: Promise<unknown>): Promise<SiteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SiteError) return e;
    throw e;
  }
  throw new Error("预期抛出 SiteError");
}

function apiRequests(requests: MockRequest[], path: string): MockRequest[] {
  return requests.filter((r) => new URL(r.url).pathname === path);
}

/** 只有根目录一个文件的分享。 */
const SINGLE: FakeOptions = {
  tree: { "0": [[{ FileId: 1, FileName: "a.txt", Type: 0, Size: 5, Etag: "e1", S3KeyFlag: "s1" }]] },
};

describe("123 云盘 单文件取直链", () => {
  test("整个分享只有一个文件时直接返回直链：请求带令牌/UA/Referer，补丁显式清空 Cookie", async () => {
    const { requests } = installFlux(fake123({ ...SINGLE, validTokens: [TOKEN] }), {}, STORED_TOKEN);
    const res = await resolve({ cookies: "sid=浏览器整串Cookie" });
    expect(res).toEqual({
      url: REAL_URL,
      fileName: "a.txt",
      totalBytes: 5,
      request: { cookies: "", referrer: "https://yun.123pan.com/", userAgent: expect.stringContaining("Chrome/") },
    });

    const list = apiRequests(requests, "/b/api/share/get")[0]!;
    expect(header(list, "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(list, "User-Agent")).toContain("Chrome/");
    expect(header(list, "Referer")).toBe("https://yun.123pan.com/");
    expect(header(list, "platform")).toBe("web");
    // 浏览器整串 Cookie 不会被带去接口
    expect(header(list, "Cookie")).toBeUndefined();
    const q = new URL(list.url).searchParams;
    expect(q.get("shareKey")).toBe(GOOD_KEY);
    expect(q.get("SharePwd")).toBe(GOOD_PWD);
    expect([...q.keys()].some((k) => /^\d+$/.test(k))).toBe(true);

    const info = apiRequests(requests, "/b/api/share/download/info")[0]!;
    expect(info.method).toBe("POST");
    expect(JSON.parse(info.body!)).toEqual({ shareKey: GOOD_KEY, SharePwd: GOOD_PWD, etag: "e1", fileId: 1, s3keyFlag: "s1", size: 5 });
    expect(header(info, "Content-Type")).toBe("application/json");

    // 探测请求：解码 params 得到真实地址，带网页版 Referer 与 Range
    const probe = requests.find((r) => r.url === REAL_URL)!;
    expect(probe.headers["Referer"]).toBe("https://yun.123pan.com/");
    expect(probe.headers["Range"]).toBe("bytes=0-0");
  });

  test("真实地址返回 JSON：取 data.redirect_url，Referer 用下载地址所在主机", async () => {
    installFlux(fake123({ ...SINGLE, mode: "json" }));
    const res = await resolve();
    expect(res.url).toBe("https://cdn.example.com/j/a.txt?sig=2");
    expect(res.request).toMatchObject({ cookies: "", referrer: "https://dl.example.com/" });
  });

  test("params 里含 + 的 base64（查询串中被解成空格）能还原", async () => {
    const real = "https://real.example.com/real?x=>>>?>>>";
    const b64 = Buffer.from(real).toString("base64");
    expect(b64).toContain("+");
    const { requests } = installFlux(fake123({ ...SINGLE, downloadUrl: `https://dl.example.com/dl?params=${b64}` }));
    const res = await resolve();
    expect(res.url).toBe(real);
    expect(requests.some((r) => r.url === real)).toBe(true);
  });

  test("没有 params：直接探测下载地址本身", async () => {
    const direct = "https://real.example.com/direct?x=1";
    const { requests } = installFlux(fake123({ ...SINGLE, downloadUrl: direct }));
    expect((await resolve()).url).toBe(direct);
    expect(requests.some((r) => r.url === direct)).toBe(true);
  });

  test("v1 下载信息不含地址时改用 v2 接口（dispatchList + downloadPath）", async () => {
    const { requests } = installFlux(fake123({ ...SINGLE, v1Empty: true }));
    const res = await resolve();
    expect(res.url).toBe(REAL_URL);
    const v2 = apiRequests(requests, "/b/api/v2/share/download/info")[0]!;
    expect(JSON.parse(v2.body!)).toMatchObject({ ShareKey: GOOD_KEY, FileID: 1, Etag: "e1", S3keyFlag: "s1", Size: 5 });
  });

  test("文件内容恰好是 JSON（无 code）或 206 切片时当作文件，不当作接口响应", async () => {
    installFlux((req) =>
      req.url === REAL_URL
        ? { status: 206, headers: { "content-type": "application/json", "content-range": "bytes 0-0/5" }, body: '{"code":0,"data":{"redirect_url":"https://evil.example.com/x"}}' }
        : fake123(SINGLE)(req),
    );
    expect((await resolve()).url).toBe(REAL_URL);
  });

  test("真实地址返回网页或 4xx：network 错误", async () => {
    installFlux((req) => (req.url === REAL_URL ? { status: 200, headers: { "content-type": "text/html" }, body: "<html></html>" } : fake123(SINGLE)(req)));
    expect((await failure(resolve())).kind).toBe("network");
    installFlux((req) => (req.url === REAL_URL ? { status: 403, headers: {}, body: "" } : fake123(SINGLE)(req)));
    expect((await failure(resolve())).kind).toBe("network");
  });

  test("params 无法解码：network 错误", async () => {
    installFlux(fake123({ ...SINGLE, downloadUrl: "https://dl.example.com/dl?params=%25%25%25" }));
    expect((await failure(resolve())).kind).toBe("network");
    installFlux(fake123({ ...SINGLE, downloadUrl: `https://dl.example.com/dl?params=${Buffer.from("ftp://x/y").toString("base64")}` }));
    expect((await failure(resolve())).kind).toBe("network");
  });
});

describe("123 云盘 目录清单", () => {
  test("递归列目录（含分页）生成清单：目录结构、大小与条目 id", async () => {
    const { requests } = installFlux(fake123());
    const res = await resolve();
    expect(res.manifest).toEqual({
      name: `分享 ${GOOD_KEY}`,
      items: [
        { id: "2:10", name: "sub.txt", kind: "file", path: "Dir B", size: 7 },
        { id: "3:11", name: "deep.bin", kind: "file", path: "Dir B/inner", size: 9 },
        { id: "1:0", name: "a.txt", kind: "file", size: 5 },
      ],
    });
    // 目录 10 分了两页
    const pages = apiRequests(requests, "/b/api/share/get")
      .map((r) => new URL(r.url).searchParams)
      .filter((q) => q.get("parentFileId") === "10")
      .map((q) => q.get("Page"));
    expect(pages.sort()).toEqual(["1", "2"]);
    expect(apiRequests(requests, "/b/api/share/download/info")).toHaveLength(0);
  });

  test("二段解析：按 fileId:parentId 回到父目录找到文件再取直链", async () => {
    const { requests } = installFlux(fake123());
    const res = await resolve({ item: "2:10" });
    expect(res).toMatchObject({ url: REAL_URL, fileName: "sub.txt", totalBytes: 7, request: { cookies: "" } });
    const info = apiRequests(requests, "/b/api/share/download/info")[0]!;
    expect(JSON.parse(info.body!)).toMatchObject({ fileId: 2, etag: "e2", s3keyFlag: "s2", size: 7 });
    // 文件在第 1 页就找到，不会继续翻页
    expect(apiRequests(requests, "/b/api/share/get")).toHaveLength(1);
  });

  test("二段解析：目标在第二页且是文件夹、文件已移出分享、条目标识无效", async () => {
    installFlux(fake123());
    // 11 是目录 10 第二页上的文件夹：要翻到第二页才找得到
    expect((await failure(resolve({ item: "11:10" }))).kind).toBe("unsupported");
    expect((await failure(resolve({ item: "999:0" }))).kind).toBe("notFound");
    expect((await failure(resolve({ item: "abc" }))).kind).toBe("unsupported");
  });

  test("空分享：notFound", async () => {
    installFlux(fake123({ tree: { "0": [[]] } }));
    expect((await failure(resolve())).kind).toBe("notFound");
  });

  test("文件超过 1000 个：limit 错误且不会无限翻页", async () => {
    const files = (page: number) => Array.from({ length: 100 }, (_, i) => ({ FileId: page * 1000 + i + 1, FileName: `f${page}-${i}.bin`, Type: 0, Size: 1, Etag: "e", S3KeyFlag: "s" }));
    const { requests } = installFlux(fake123({ tree: { "0": Array.from({ length: 11 }, (_, p) => files(p + 1)) } }));
    expect((await failure(resolve())).kind).toBe("limit");
    expect(apiRequests(requests, "/b/api/share/get").length).toBeLessThanOrEqual(20);
  });

  test("目录请求数超过上限：limit 错误", async () => {
    // 每层一个子目录，嵌套 30 层
    const tree: Record<string, Record<string, unknown>[][]> = {};
    for (let i = 0; i < 30; i++) tree[i === 0 ? "0" : String(i)] = [[{ FileId: i + 1, FileName: `d${i}`, Type: 1, Size: 0 }]];
    const { requests } = installFlux(fake123({ tree }));
    const err = await failure(resolve());
    expect(err.kind).toBe("limit");
    expect(apiRequests(requests, "/b/api/share/get")).toHaveLength(20);
  });
});

describe("123 云盘 登录态", () => {
  test("没有令牌：匿名请求，不带 Authorization", async () => {
    const { requests } = installFlux(fake123(SINGLE));
    await resolve();
    expect(requests.every((r) => header(r, "Authorization") === undefined)).toBe(true);
  });

  test("令牌已过期：不发送，按匿名解析，流量不足时提示重新登录", async () => {
    const expired = makeJwt(Math.floor(Date.now() / 1000) - 100);
    const { requests } = installFlux(fake123({ ...SINGLE, exhausted: [""] }), {}, { "pan123.auth": JSON.stringify({ token: expired, exp: 1 }) });
    const err = await failure(resolve());
    expect(err.kind).toBe("limit");
    expect(err.message).toContain("已过期");
    expect(requests.every((r) => header(r, "Authorization") === undefined)).toBe(true);
  });

  test("存储里的令牌形状被篡改：忽略，按匿名解析", async () => {
    const { requests } = installFlux(fake123(SINGLE), {}, { "pan123.auth": JSON.stringify({ token: "garbage", exp: 9e12 }) });
    await resolve();
    expect(requests.every((r) => header(r, "Authorization") === undefined)).toBe(true);
    installFlux(fake123(SINGLE), {}, { "pan123.auth": "{坏" });
    await resolve();
  });
});

describe("123 云盘 错误码映射", () => {
  test("5112 匿名：limit，提示先登录；已登录：limit，提示账号流量", async () => {
    installFlux(fake123({ ...SINGLE, exhausted: [""] }));
    const anon = await failure(resolve());
    expect(anon.kind).toBe("limit");
    expect(anon.message).toContain("先在浏览器登录");

    installFlux(fake123({ ...SINGLE, validTokens: [TOKEN], exhausted: [TOKEN] }), {}, STORED_TOKEN);
    const logged = await failure(resolve());
    expect(logged.kind).toBe("limit");
    expect(logged.message).toContain("当前账号");
    expect(logged.message).not.toContain(TOKEN);
  });

  test("5103：提取码错误 → password，分享不存在 → notFound", async () => {
    installFlux(fake123());
    expect((await failure(resolve({ pwd: "Zz99" }))).kind).toBe("password");
    expect((await failure(resolve({ key: "zzzz-yyyy" }))).kind).toBe("notFound");
  });

  test("401：已存令牌被服务端拒绝 → login，消息不含令牌", async () => {
    installFlux(fake123({ ...SINGLE, validTokens: ["other"] }), {}, STORED_TOKEN);
    const err = await failure(resolve());
    expect(err.kind).toBe("login");
    expect(err.message).toContain("重新登录");
    expect(err.message).not.toContain(TOKEN);
  });

  test("分享已过期（Expired）→ notFound；未知 code → other 并带 code", async () => {
    installFlux(() => ({ body: { code: 0, message: "ok", data: { Expired: true, InfoList: [] } } }));
    expect((await failure(resolve())).kind).toBe("notFound");
    installFlux(() => ({ body: { code: 7777, message: "怪事", data: null } }));
    const err = await failure(resolve());
    expect(err.kind).toBe("other");
    expect(err.message).toContain("7777");
  });

  test("文件标识超出安全整数范围：拒绝而不是下载错文件", async () => {
    installFlux(() => ({
      body: { code: 0, message: "ok", data: { InfoList: [{ FileId: 12345678901234567890, FileName: "x", Type: 0, Size: 1 }], Next: "-1" } },
    }));
    expect((await failure(resolve())).kind).toBe("unsupported");
  });
});

describe("123 云盘 接口主机回退", () => {
  test("首选主机返回非 JSON 时换备用主机；业务错误不回退", async () => {
    const inner = fake123(SINGLE);
    const { requests } = installFlux((req) => (req.url.startsWith("https://yun.123pan.com/") ? { status: 404, headers: { "content-type": "text/html" }, body: "<html></html>" } : inner(req)));
    // 备用主机的路径同为 /b/api，替身按路径应答
    const res = await resolve();
    expect(res.url).toBe(REAL_URL);
    const hosts = requests.map((r) => new URL(r.url).hostname);
    expect(hosts[0]).toBe("yun.123pan.com");
    expect(hosts[1]).toBe("www.123pan.cn");

    const businessError = installFlux(fake123({ tree: {} }));
    await failure(resolve({ pwd: "bad1" }));
    expect(businessError.requests.filter((r) => new URL(r.url).hostname === "www.123pan.cn")).toHaveLength(0);
  });

  test("两个主机都不可用：network 错误", async () => {
    installFlux(() => ({ status: 502, headers: { "content-type": "text/html" }, body: "bad gateway" }));
    expect((await failure(resolve())).kind).toBe("network");
  });
});

test("任务 URL 没有有效分享标识：unsupported", async () => {
  installFlux(fake123());
  const url = "https://1.share.123pan.cn/__accountdl/pan123?key=bad";
  expect(
    (await failure(pan123.resolve({ taskId: "t", url, parsed: parseUrl(url)!, cookies: "", userAgent: "", referrer: "", resolverItem: "" }))).kind,
  ).toBe("unsupported");
});
