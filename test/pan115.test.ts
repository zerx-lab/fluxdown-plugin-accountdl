import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { base64Decode, base64Encode, utf8Bytes } from "../src/core/hash";
import type { ResolveInput, Site as SiteContract } from "../src/core/site";
import { parseUrl } from "../src/core/url";
import * as realM115 from "../src/sites/pan115/m115";
import type * as ApiModule from "../src/sites/pan115/api";
import { header, installFlux, type MockRequest, type MockResponse } from "./helpers";

// 取直链响应由服务端私钥加密，测试里造不出合法密文：只在这个文件里把解密换成明文 base64（加密侧仍是真实实现）。
// m115 本身的编码/解码由 pan115-m115.test.ts 用 Go 原实现的向量验证。
const m115Path = "../src/sites/pan115/m115";
const realCopy = { ...realM115 };

let pan115: SiteContract;
let api: typeof ApiModule;

beforeAll(async () => {
  mock.module(m115Path, () => ({
    ...realCopy,
    m115Decode: (text: string) => {
      if (text === "BROKEN") throw new Error("m115 解密失败：填充不合法");
      return base64Decode(text);
    },
  }));
  // 动态 import：mock.module 必须先于被测模块加载生效，静态 import 做不到这个顺序。
  pan115 = (await import("../src/sites/pan115")).pan115;
  api = await import("../src/sites/pan115/api");
});

afterAll(() => {
  mock.module(m115Path, () => realCopy);
});

const SHARE = "swsexuo3zrk";
const PASSWORD = "t58d";
const COOKIES = "UID=10000_xx; CID=cid1; SEID=seid1; KID=kid1; acw_tc=abc";
const TASK = `https://115.com/__accountdl/pan115?s=${SHARE}&p=${PASSWORD}`;

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  const url = over.url ?? TASK;
  return { taskId: "t1", url, parsed: parseUrl(url)!, cookies: COOKIES, userAgent: "", referrer: "", resolverItem: "", ...over };
}

/** 按 115 snap 真实响应结构（2026-10 匿名实测）造文件条目。 */
function file(fid: string, name: string, size: number) {
  return { fid, uid: 342290996, cid: 0, n: name, ns: "", s: size, fc: 1, t: "1789189113", d: 1, c: 0, e: "", ico: "mkv", sha: "6CC45FD3", is_skip_login: 0, ec: 0, fl: [], u: "" };
}

/** 目录条目：`fc: 0`，目录 id 在 `cid`（115driver / OpenList 的约定，未登录无法实测）。 */
function dir(cid: string | number, name: string) {
  return { cid, n: name, fc: 0, t: "1789189113", s: 0, ico: "folder" };
}

function snapBody(list: unknown[], opts: { count?: number; state?: number; title?: string } = {}) {
  const state = opts.state ?? 1;
  return {
    state: true,
    error: "",
    errno: 0,
    data: {
      userinfo: { user_id: "342290996", user_name: "分***。", face: "http://avatars.115.com/x.jpg" },
      shareinfo: { snap_id: "1", file_size: 1, share_title: opts.title ?? "示例分享", share_state: state, forbid_reason: "", receive_code: PASSWORD, has_receive_code: 1 },
      count: opts.count ?? list.length,
      list,
      share_state: state,
      user_appeal: { can_appeal: 0 },
    },
  };
}

function downBody(fid: string, name: string, size: number | string, url = `https://cdnfhnfile.115.com/abc/${encodeURIComponent(name)}?t=1&u=2&s=3&k=4`) {
  const info = { fid, fn: name, fs: size, sha1: "AB", url: { url, client: 0, desc: "", isp: "", oss_id: "", ooid: "" } };
  return { state: true, error: "", errno: 0, data: base64Encode(utf8Bytes(JSON.stringify(info))) };
}

const isSnap = (req: MockRequest) => req.url.startsWith("https://webapi.115.com/share/snap?");
const isDown = (req: MockRequest) => req.url.startsWith("https://proapi.115.com/app/share/downurl?");
const q = (req: MockRequest) => new URL(req.url).searchParams;

describe("115 单文件分享", () => {
  test("列目录 → 取直链，直链补丁显式设置 Cookie / UA / 无 Referer", async () => {
    const { requests } = installFlux((req) => {
      if (isSnap(req)) return { body: snapBody([file("3516278936403182800", "冬城猎凶.mkv", 1245588322)]) };
      return {
        headers: { "content-type": "application/json", "set-cookie": "115dl=tok1; Path=/; HttpOnly\nacw_tc=x; Path=/; Max-Age=1800" },
        body: downBody("3516278936403182800", "冬城猎凶.mkv", "1245588322"),
      };
    });
    const res = await pan115.resolve(input());
    expect(res.url).toStartWith("https://cdnfhnfile.115.com/abc/");
    expect(res.fileName).toBe("冬城猎凶.mkv");
    expect(res.totalBytes).toBe(1245588322);
    expect(res.request).toEqual({ cookies: "115dl=tok1; acw_tc=x", userAgent: api.APP_UA, referrer: "" });
    expect(res.request?.cookies).not.toContain("UID=");

    expect(requests).toHaveLength(2);
    const [snap, down] = requests;
    // 列目录：普通浏览器 UA（115Browser UA 会被 webapi 拒绝）、浏览器登录 Cookie、分享页 Referer。
    expect(q(snap!).get("share_code")).toBe(SHARE);
    expect(q(snap!).get("receive_code")).toBe(PASSWORD);
    expect(q(snap!).get("cid")).toBe("0");
    expect(header(snap!, "User-Agent")).toBe(api.BROWSER_UA);
    expect(header(snap!, "User-Agent")).not.toContain("115Browser");
    expect(header(snap!, "Cookie")).toBe(COOKIES);
    expect(header(snap!, "Referer")).toBe(`https://115cdn.com/s/${SHARE}?password=${PASSWORD}&`);
    // 取直链：POST app 接口，115 客户端 UA，不带 Referer，表单 data 是 128 字节整数倍的 RSA 密文。
    expect(down!.method).toBe("POST");
    expect(q(down!).get("t")).toMatch(/^\d{10}$/);
    expect(header(down!, "User-Agent")).toBe(api.APP_UA);
    expect(header(down!, "Cookie")).toBe(COOKIES);
    expect(header(down!, "Referer")).toBeUndefined();
    expect(header(down!, "Content-Type")).toBe("application/x-www-form-urlencoded");
    const data = new URLSearchParams(down!.body).get("data")!;
    expect(base64Decode(data).length % 128).toBe(0);
    expect(base64Decode(data).length).toBeGreaterThan(0);
  });

  test("取链响应没有下发 Cookie 时 request.cookies 仍显式为空串", async () => {
    installFlux((req) => (isSnap(req) ? { body: snapBody([file("11", "a.zip", 5)]) } : { body: downBody("11", "a.zip", 5) }));
    const res = await pan115.resolve(input());
    expect(res.request?.cookies).toBe("");
  });

  test("单个文件在子目录里也直接出直链", async () => {
    installFlux((req) => {
      if (isDown(req)) return { body: downBody("22", "deep.bin", 7) };
      return { body: snapBody(q(req).get("cid") === "0" ? [dir("900", "目录")] : [file("22", "deep.bin", 7)]) };
    });
    const res = await pan115.resolve(input());
    expect(res.manifest).toBeUndefined();
    expect(res.fileName).toBe("deep.bin");
  });

  test("取链返回未知大小时不声明 totalBytes", async () => {
    installFlux((req) => (isSnap(req) ? { body: snapBody([file("11", "a.zip", 0)]) } : { body: downBody("11", "a.zip", 0) }));
    const res = await pan115.resolve(input());
    expect(res.totalBytes).toBeUndefined();
  });
});

describe("115 目录分享与清单", () => {
  const tree = (req: MockRequest): MockResponse => {
    const cid = q(req).get("cid");
    if (cid === "0") return { body: snapBody([dir("501", "第一季"), file("1", "简介.txt", 10)], { title: "剧集合集" }) };
    if (cid === "501") return { body: snapBody([file("2", "S01E01.mkv", 2000), dir("502", "字幕"), file("3", "S01E02.mkv", 3000)]) };
    if (cid === "502") return { body: snapBody([file("4", "S01E01.srt", 5)]) };
    throw new Error(`未预期的目录 ${cid}`);
  };

  test("递归列目录生成清单：条目 id 为 fid，保留目录与大小", async () => {
    const { requests } = installFlux(tree);
    const res = await pan115.resolve(input());
    expect(res.manifest?.name).toBe("剧集合集");
    expect(res.manifest?.items).toEqual([
      { id: "1", name: "简介.txt", kind: "file", size: 10 },
      { id: "2", name: "S01E01.mkv", kind: "file", path: "第一季", size: 2000 },
      { id: "3", name: "S01E02.mkv", kind: "file", path: "第一季", size: 3000 },
      { id: "4", name: "S01E01.srt", kind: "file", path: "第一季/字幕", size: 5 },
    ]);
    expect(requests.map((r) => q(r).get("cid"))).toEqual(["0", "501", "502"]);
  });

  test("任务 URL 带起始目录 d 时从该目录开始列（该目录只有一个文件则直接取链）", async () => {
    const { requests } = installFlux((req) => (isDown(req) ? { body: downBody("4", "S01E01.srt", 5) } : tree(req)));
    const res = await pan115.resolve(input({ url: `${TASK}&d=502` }));
    expect(requests.map((r) => (isSnap(r) ? q(r).get("cid") : "downurl"))).toEqual(["502", "downurl"]);
    expect(res.fileName).toBe("S01E01.srt");
  });

  test("超过 2^53 的数字目录 id 不丢精度", async () => {
    const { requests } = installFlux((req) => {
      const cid = q(req).get("cid");
      if (cid === "0") {
        // 站点把大目录 id 写成 JSON 数字：直接 JSON.parse 会变成 3516278936403182600。
        const raw = JSON.stringify(snapBody([file("1", "a.txt", 1), dir("0", "d")])).replace('"cid":"0"', '"cid":3516278936403182801');
        return { body: raw };
      }
      return { body: snapBody([file("2", "b.txt", 2)]) };
    });
    await pan115.resolve(input());
    expect(requests.map((r) => q(r).get("cid"))).toEqual(["0", "3516278936403182801"]);
  });

  test("分页：条目总数大于一页时按 offset 继续", async () => {
    const { requests } = installFlux((req) => {
      const offset = Number(q(req).get("offset"));
      if (offset === 0) return { body: snapBody([file("1", "a", 1), file("2", "b", 1)], { count: 3 }) };
      return { body: snapBody([file("3", "c", 1)], { count: 3 }) };
    });
    const res = await pan115.resolve(input());
    expect(res.manifest?.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(requests.map((r) => q(r).get("offset"))).toEqual(["0", "2"]);
  });

  test("文件超过 1000 个、列目录请求超过上限时报 limit 且说明原因", async () => {
    installFlux(() => ({ body: snapBody(Array.from({ length: 1001 }, (_, i) => file(String(i + 1), `f${i}.bin`, 1))) }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("1000") });

    let n = 0;
    const { requests } = installFlux(() => ({ body: snapBody([dir(String(++n + 100), `d${n}`)]) }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining(String(api.MAX_SNAP_REQUESTS)) });
    expect(requests).toHaveLength(api.MAX_SNAP_REQUESTS);
  });

  test("分享里没有任何文件时报 notFound", async () => {
    installFlux(() => ({ body: snapBody([]) }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "notFound" });
  });
});

describe("115 清单二段解析", () => {
  test("只取该文件直链，不再列目录；结果同样显式设置 request.cookies", async () => {
    const { requests } = installFlux(() => ({ body: downBody("3516278936403182800", "S01E01.mkv", 2000) }));
    const res = await pan115.resolve(input({ resolverItem: "3516278936403182800" }));
    expect(requests).toHaveLength(1);
    expect(isDown(requests[0]!)).toBe(true);
    expect(res.fileName).toBe("S01E01.mkv");
    expect(res.request).toEqual({ cookies: "", userAgent: api.APP_UA, referrer: "" });
  });

  test("条目标识非法时拒绝，不发请求", async () => {
    const { requests } = installFlux(() => ({ body: {} }));
    await expect(pan115.resolve(input({ resolverItem: "1&file_id=2" }))).rejects.toMatchObject({ kind: "unsupported" });
    expect(requests).toHaveLength(0);
  });
});

describe("115 错误映射", () => {
  const snapFail = (errno: number, error: string) => ({ body: { state: false, error, errno, errNo: errno, data: { userinfo: {}, is_access: 0 } } });
  const downFail = (errno: number, error: string) => ({ body: { state: false, error, errno, data: [] } });

  test("没有 Cookie：不发请求，直接报 login", async () => {
    const { requests } = installFlux(() => ({ body: {} }));
    await expect(pan115.resolve(input({ cookies: "" }))).rejects.toMatchObject({ kind: "login" });
    expect(requests).toHaveLength(0);
  });

  test("任务参数非法：unsupported，不发请求", async () => {
    const { requests } = installFlux(() => ({ body: {} }));
    await expect(pan115.resolve(input({ url: "https://115.com/__accountdl/pan115?s=ab" }))).rejects.toMatchObject({ kind: "unsupported" });
    expect(requests).toHaveLength(0);
  });

  test("snap：提取码缺失/错误 → password，分享失效 → notFound", async () => {
    installFlux(() => snapFail(4100012, "请输入访问码"));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "password" });
    installFlux(() => snapFail(4100008, "访问码错误"));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "password", message: expect.stringContaining("115 网盘·列出分享目录") });
    installFlux(() => snapFail(4100026, "分享不存在"));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "notFound" });
  });

  test("snap：分享已过期 / 被取消（state 仍为 true，靠 share_state 判断）→ notFound", async () => {
    installFlux(() => ({ body: snapBody([file("1", "a", 1)], { state: 7 }) }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "notFound", detail: "分享已过期" });
    installFlux(() => ({ body: snapBody([file("1", "a", 1)], { state: 4 }) }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "notFound" });
  });

  test("snap：被 WAF 拦截（405 HTML）→ network；401 → login", async () => {
    installFlux(() => ({ status: 405, headers: { "content-type": "text/html" }, body: "<!doctypehtml>405" }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "network" });
    installFlux(() => ({ status: 401, body: "" }));
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "login" });
  });

  test("取直链：登录失效 99 / 990001 → login", async () => {
    for (const code of [99, 990001]) {
      installFlux(() => downFail(code, "请重新登录"));
      await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "login" });
    }
  });

  test("取直链：文件已删除 / 过大 / 要求验证 / 客户端版本过低 / 未知码", async () => {
    installFlux(() => downFail(70005, "文件不存在"));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "notFound" });
    installFlux(() => downFail(50028, "文件过大"));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "limit" });
    installFlux(() => ({ body: { state: false, error: "需要验证", errcode: 911 } }));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "limit" });
    installFlux(() => ({ body: { state: false, error: "当前版本过低，请升级到最新版本下载。" } }));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "unsupported" });
    installFlux(() => downFail(12345, "奇怪的错误"));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "other", message: expect.stringContaining("12345") });
  });

  test("取直链：解密失败、没有下载地址（目录）→ 明确错误", async () => {
    installFlux(() => ({ body: { state: true, errno: 0, data: "BROKEN" } }));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "network", message: expect.stringContaining("解密失败") });
    const dirInfo = { fid: "1", fn: "文件夹", fs: 0, url: false };
    installFlux(() => ({ body: { state: true, errno: 0, data: base64Encode(utf8Bytes(JSON.stringify(dirInfo))) } }));
    await expect(pan115.resolve(input({ resolverItem: "1" }))).rejects.toMatchObject({ kind: "unsupported" });
  });

  test("错误消息不含 Cookie、提取码与带签名的直链", async () => {
    installFlux(() => downFail(12345, "奇怪的错误"));
    const e = await pan115.resolve(input({ resolverItem: "1" })).catch((err: Error) => err);
    expect((e as Error).message).not.toContain("seid1");
    expect((e as Error).message).not.toContain(PASSWORD);
  });
});

describe("115 请求体", () => {
  test("请求里没有明文的分享码与提取码（载荷整体是 m115 密文）", async () => {
    const { requests } = installFlux(() => ({ body: downBody("1", "a", 1) }));
    await pan115.resolve(input({ resolverItem: "1" }));
    const body = requests[0]!.body!;
    expect(body.startsWith("data=")).toBe(true);
    expect(body).not.toContain(SHARE);
    expect(body).not.toContain(PASSWORD);
  });
});

describe("115 snap 真实响应结构", () => {
  test("匿名实测的 snap 响应（脱敏）能解析；过期分享按 share_state 7 报 notFound", async () => {
    const real = await Bun.file(new URL("./fixtures/pan115/snap-real-expired.json", import.meta.url)).text();
    installFlux(() => ({ body: real }));
    const page = await api.shareSnap(COOKIES, SHARE, PASSWORD, "0", 0);
    expect(page).toEqual({
      title: "示例视频.S01E01.mkv",
      shareState: 7,
      total: 1,
      entries: [{ id: "3516278936403182800", name: "示例视频.S01E01.mkv", isDir: false, size: 1245588322 }],
    });
    await expect(pan115.resolve(input())).rejects.toMatchObject({ kind: "notFound", detail: "分享已过期" });
  });
});
