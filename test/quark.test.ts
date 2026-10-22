import { beforeEach, describe, expect, test } from "bun:test";
import { parseCookies } from "../src/core/cookies";
import { SiteError } from "../src/core/errors";
import { parseTaskUrl } from "../src/core/task";
import { parseUrl } from "../src/core/url";
import { memberThreads, QUARK_UA, scratchExpired, sizedSegments } from "../src/sites/quark/api";
import { quark } from "../src/sites/quark";
import { parseSharePage, readTaskParams, sharePageTaskUrl, type SharePage } from "../src/sites/quark/link";
import { header, installFlux, type MockRequest, type MockResponse } from "./helpers";

const KEY = "abcdef123456";
const FID_A = "a".repeat(32);
const FID_SUB = "b".repeat(32);
const COOKIE = "__pus=PUS1; __puus=PUUS1; other=x; tracker=y";
const MB = 1024 * 1024;

const ok = (data: unknown, extra: Record<string, unknown> = {}): MockResponse => ({ body: { code: 0, data, ...extra } });
const fail = (code: number, message = ""): MockResponse => ({ body: { code, message } });
const path = (req: MockRequest) => new URL(req.url).pathname;
const query = (req: MockRequest, name: string) => new URL(req.url).searchParams.get(name);
const bodyOf = (req: MockRequest): Record<string, unknown> => JSON.parse(req.body ?? "{}");

function task(params: Partial<SharePage>): string {
  return sharePageTaskUrl({ key: KEY, password: "", dir: "", ...params });
}

function run(url: string, resolverItem = "", cookies = COOKIE) {
  const parsed = parseUrl(url)!;
  return quark.resolve({ taskId: "t", url, parsed, cookies, userAgent: "Chrome", referrer: "", resolverItem });
}

const file = (fid: string, name: string, size: number) => ({ fid, file_name: name, dir: false, size, share_fid_token: `tok-${fid}` });
const dir = (fid: string, name: string) => ({ fid, file_name: name, dir: true, share_fid_token: `tok-${fid}` });

/** 默认假服务：根目录 = 文件夹 + 一个文件，文件夹内一个文件。 */
function server(over: (req: MockRequest) => MockResponse | undefined = () => undefined, memberType = "SUPER_VIP") {
  return (req: MockRequest): MockResponse => {
    const custom = over(req);
    if (custom) return custom;
    switch (path(req)) {
      case "/1/clouddrive/share/sharepage/token":
        return ok({ stoken: "ST1" });
      case "/1/clouddrive/share/sharepage/detail": {
        const pdir = query(req, "pdir_fid");
        if (pdir === "0") return ok({ list: [dir(FID_SUB, "子目录"), file(FID_A, "根文件.bin", 100 * MB)] }, { metadata: { _total: 2 } });
        if (pdir === FID_SUB) return ok({ list: [file("c".repeat(32), "内.txt", 5)] }, { metadata: { _total: 1 } });
        return ok({ list: [] });
      }
      case "/1/clouddrive/file/download":
        return ok([{ download_url: "https://dl-pc-sz.drive.quark.cn/f?sp=100&auth_key=k", file_name: "根文件.bin", size: 100 * MB }]);
      case "/1/clouddrive/member":
        return ok({ member_type: memberType });
    }
    return fail(99999, "未预期的请求 " + path(req));
  };
}

describe("夸克：链接识别与任务 URL", () => {
  test("分享页地址：标识、提取码、目录（片段）", () => {
    expect(parseSharePage(`https://pan.quark.cn/s/${KEY}?pwd=ab12#/list/share/${FID_A}-文件夹/${FID_SUB}-子`)).toEqual({
      key: KEY,
      password: "ab12",
      dir: FID_SUB,
    });
    expect(parseSharePage(`https://pan.quark.cn/s/${KEY}#/list/share`)).toEqual({ key: KEY, password: "", dir: "" });
  });

  test("仿冒域名、非分享路径、过短标识不认", () => {
    expect(parseSharePage(`https://pan.quark.cn.evil.com/s/${KEY}`)).toBeNull();
    expect(parseSharePage(`https://evil.com/pan.quark.cn/s/${KEY}`)).toBeNull();
    expect(parseSharePage("https://pan.quark.cn/list")).toBeNull();
    expect(parseSharePage("https://pan.quark.cn/s/abc")).toBeNull();
  });

  test("任务 URL 往返（含 & # 与中文提取码），根目录不写 dir", () => {
    const url = sharePageTaskUrl({ key: KEY, password: "密&#码", dir: FID_SUB });
    expect(url.startsWith("https://pan.quark.cn/__accountdl/quark?")).toBe(true);
    const parsed = parseUrl(url)!;
    expect(readTaskParams(parseTaskUrl(parsed)!.params)).toEqual({ key: KEY, password: "密&#码", dir: FID_SUB });
    expect(sharePageTaskUrl({ key: KEY, password: "", dir: "0" })).not.toContain("dir=");
  });

  test("认领：只认本站点任务 URL，非法参数拒绝", () => {
    expect(quark.claims(parseUrl(task({}))!)).toBe(true);
    expect(quark.claims(parseUrl(`https://pan.quark.cn/s/${KEY}`)!)).toBe(false);
    expect(quark.claims(parseUrl("https://pan.quark.cn.evil.com/__accountdl/quark?key=" + KEY)!)).toBe(false);
    expect(readTaskParams({ key: "x/../y" })).toBeNull();
    expect(readTaskParams({ key: KEY, dir: "../0" })).toBeNull();
  });
});

describe("夸克：列目录与清单", () => {
  test("递归列目录生成清单，条目 id 为「所在目录:fid」，请求带 UA / Referer / Cookie", async () => {
    const { requests } = installFlux(server());
    const res = await run(task({ password: "pw12" }));
    expect(res.manifest?.items).toEqual([
      { id: `0:${FID_A}`, name: "根文件.bin", kind: "file", size: 100 * MB },
      { id: `${FID_SUB}:${"c".repeat(32)}`, name: "内.txt", kind: "file", path: "子目录", size: 5 },
    ]);
    const first = requests[0];
    expect(path(first)).toBe("/1/clouddrive/share/sharepage/token");
    expect(bodyOf(first)).toMatchObject({ pwd_id: KEY, passcode: "pw12" });
    for (const r of requests) {
      expect(header(r, "user-agent")).toBe(QUARK_UA);
      expect(header(r, "referer")).toBe("https://pan.quark.cn/");
      expect(header(r, "cookie")).toBe(COOKIE);
    }
  });

  test("分页：按 _total 继续翻页", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => file(`${n}`.padStart(2, "0") + String(i).padStart(30, "0"), `f${n}-${i}`, 1));
    installFlux(
      server((req) => {
        if (path(req) !== "/1/clouddrive/share/sharepage/detail") return undefined;
        const p = Number(query(req, "_page"));
        return ok({ list: p === 1 ? page(1) : page(2).slice(0, 20) }, { metadata: { _total: 120 } });
      }),
    );
    const res = await run(task({}));
    expect(res.manifest?.items).toHaveLength(120);
  });

  test("只有一个文件时直接出直链", async () => {
    installFlux(
      server((req) =>
        path(req) === "/1/clouddrive/share/sharepage/detail" ? ok({ list: [file(FID_A, "单个.bin", 8 * MB)] }, { metadata: { _total: 1 } }) : undefined,
      ),
    );
    const res = await run(task({}));
    expect(res.url).toContain("dl-pc-sz.drive.quark.cn");
    expect(res.manifest).toBeUndefined();
  });

  test("列目录请求超过上限给出 limit 错误", async () => {
    // 每个目录里只有一个更深的目录：无限嵌套。
    installFlux(
      server((req) => (path(req) === "/1/clouddrive/share/sharepage/detail" ? ok({ list: [dir("d".repeat(31) + "1", "深")] }, { metadata: { _total: 1 } }) : undefined)),
    );
    const err = await run(task({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).kind).toBe("limit");
  });

  test("指定目录（dir）作为起点列目录", async () => {
    const { requests } = installFlux(server());
    const res = await run(task({ dir: FID_SUB }));
    expect(res.url).toBeDefined(); // 该目录只有一个文件 → 直链
    const detail = requests.find((r) => path(r).endsWith("/detail"))!;
    expect(query(detail, "pdir_fid")).toBe(FID_SUB);
  });
});

describe("夸克：免转存取链与请求补丁", () => {
  const item = `0:${FID_A}`;

  test("二段解析：带分享凭证取链，补丁含最小 Cookie、客户端 UA、Referer、线程数", async () => {
    const { requests } = installFlux(server());
    const res = await run(task({ password: "pw12" }), item);
    expect(res.url).toBe("https://dl-pc-sz.drive.quark.cn/f?sp=100&auth_key=k");
    expect(res.fileName).toBe("根文件.bin");
    expect(res.totalBytes).toBe(100 * MB);
    expect(res.request).toEqual({
      cookies: "__pus=PUS1; __puus=PUUS1",
      userAgent: QUARK_UA,
      referrer: "https://pan.quark.cn/",
      segments: 25, // SVIP 32 线程，但 100 MiB / 4 MiB = 25 段
      maxConnections: 25,
    });
    const dl = requests.find((r) => path(r) === "/1/clouddrive/file/download")!;
    expect(bodyOf(dl)).toEqual({ fids: [FID_A], fids_token: [`tok-${FID_A}`], pwd_id: KEY, stoken: "ST1", speedup_session: "", token: "" });
    expect(header(dl, "user-agent")).toBe(QUARK_UA);
    expect(requests.some((r) => path(r) === "/1/clouddrive/share/sharepage/save")).toBe(false);
  });

  test("线程数按会员等级与文件大小", () => {
    expect([memberThreads("SUPER_VIP"), memberThreads("VIP"), memberThreads("NORMAL"), memberThreads("")]).toEqual([32, 16, 8, 8]);
    expect(sizedSegments(32, 1)).toBe(1);
    expect(sizedSegments(32, 4 * MB + 1)).toBe(2);
    expect(sizedSegments(32, 10_000 * MB)).toBe(32);
    expect(sizedSegments(16, -1)).toBe(16);
  });

  test("普通会员 8 线程；会员查询失败按 8", async () => {
    installFlux(server(undefined, "NORMAL"));
    expect((await run(task({}), item)).request?.segments).toBe(8);
    installFlux(server((req) => (path(req) === "/1/clouddrive/member" ? fail(500, "x") : undefined)));
    expect((await run(task({}), item)).request?.segments).toBe(8);
  });

  test("二段解析找不到文件 / 条目标识非法", async () => {
    installFlux(server());
    const gone = await run(task({}), `0:${"z".repeat(32)}`).catch((e: unknown) => e);
    expect((gone as SiteError).kind).toBe("notFound");
    const bad = await run(task({}), "../x").catch((e: unknown) => e);
    expect((bad as SiteError).kind).toBe("unsupported");
  });

  test("没有 __pus 登录态报 login，且不发请求", async () => {
    const { requests } = installFlux(server());
    const err = await run(task({}), "", "tracker=y").catch((e: unknown) => e);
    expect((err as SiteError).kind).toBe("login");
    expect(requests).toHaveLength(0);
  });
});

describe("夸克：被拒 → 转存 → 取链 → 清理", () => {
  const item = `0:${FID_A}`;
  const NOW = Math.floor(Date.now() / 1000);
  let calls: string[];

  beforeEach(() => {
    calls = [];
  });

  function transferServer(refuse: MockResponse, tmpChildren: unknown[]) {
    let polls = 0;
    return server((req) => {
      const p = path(req);
      calls.push(`${req.method} ${p}`);
      if (p === "/1/clouddrive/file/download") {
        const body = bodyOf(req);
        if (body.pwd_id) return refuse;
        return ok([{ download_url: "https://dl-pc-sz.drive.quark.cn/own?sp=100", file_name: "根文件.bin", size: 100 * MB }]);
      }
      if (p === "/1/clouddrive/file/sort") {
        const pdir = query(req, "pdir_fid");
        if (pdir === "0") return ok({ list: [{ fid: "ROOT", file_name: "accountdl-tmp", dir: true }] });
        return ok({ list: tmpChildren });
      }
      if (p === "/1/clouddrive/file") return ok({ fid: "NEWDIR" });
      if (p === "/1/clouddrive/share/sharepage/save") return ok({ task_id: "TASK1" });
      if (p === "/1/clouddrive/task") return ok(++polls < 2 ? { status: 1 } : { status: 2, save_as: { save_as_top_fids: ["OWN1"] } });
      if (p === "/1/clouddrive/file/delete") return ok({});
      return undefined;
    });
  }

  test("免转存被拒（23018）→ 转存到临时目录 → 取自己那份的直链 → 只删过期副本", async () => {
    const stale = { fid: "STALE", file_name: `${NOW - 7 * 3600}-deadbeef`, dir: true };
    const fresh = { fid: "FRESH", file_name: `${NOW - 60}-cafebabe`, dir: true };
    const other = { fid: "OTHER", file_name: "用户自己的目录", dir: true };
    const { requests } = installFlux(transferServer(fail(23018, "limit"), [stale, fresh, other]));
    const res = await run(task({ password: "pw12" }), item);

    expect(res.url).toBe("https://dl-pc-sz.drive.quark.cn/own?sp=100");
    expect(res.request?.cookies).toBe("__pus=PUS1; __puus=PUUS1");

    const save = requests.find((r) => path(r).endsWith("/sharepage/save"))!;
    expect(bodyOf(save)).toMatchObject({ fid_list: [FID_A], fid_token_list: [`tok-${FID_A}`], to_pdir_fid: "NEWDIR", pwd_id: KEY, stoken: "ST1", pdir_fid: "0" });
    const mkdir = requests.filter((r) => r.method === "POST" && path(r) === "/1/clouddrive/file");
    expect(bodyOf(mkdir[0])).toMatchObject({ pdir_fid: "ROOT" });
    expect(bodyOf(mkdir[0]).file_name).toMatch(/^\d+-[0-9a-f]{8}$/);
    const own = requests.filter((r) => path(r) === "/1/clouddrive/file/download").at(-1)!;
    expect(bodyOf(own)).toEqual({ fids: ["OWN1"] });
    const del = requests.find((r) => path(r) === "/1/clouddrive/file/delete")!;
    expect(bodyOf(del)).toEqual({ action_type: 2, filelist: ["STALE"], exclude_fids: [] });
    // 取链之后才清理，且本次新建的副本不在删除列表里
    expect(calls.indexOf("POST /1/clouddrive/file/delete")).toBeGreaterThan(calls.lastIndexOf("POST /1/clouddrive/file/download"));
  });

  test("没有过期副本时不发删除；清理失败不影响结果", async () => {
    const a = installFlux(transferServer(fail(12345, "不给免转存"), [{ fid: "FRESH", file_name: `${NOW}-aa`, dir: true }]));
    await run(task({}), item);
    expect(a.requests.some((r) => path(r).endsWith("/file/delete"))).toBe(false);

    installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/file/download") return bodyOf(req).pwd_id ? fail(12345, "x") : ok([{ download_url: "https://dl.quark.cn/o", file_name: "a", size: 1 }]);
        if (p === "/1/clouddrive/file/sort") return query(req, "pdir_fid") === "0" ? ok({ list: [] }) : fail(500, "boom");
        if (p === "/1/clouddrive/file") return ok({ fid: "N" });
        if (p === "/1/clouddrive/share/sharepage/save") return ok({ task_id: "T" });
        if (p === "/1/clouddrive/task") return ok({ status: 2, save_as: { save_as_top_fids: ["O"] } });
        return undefined;
      }),
    );
    const res = await run(task({}), item);
    expect(res.url).toBe("https://dl.quark.cn/o");
  });

  test("登录、提取码、分享失效类错误不走转存", async () => {
    const { requests } = installFlux(transferServer(fail(41009), []));
    const err = await run(task({}), item).catch((e: unknown) => e);
    expect((err as SiteError).kind).toBe("password");
    expect(requests.some((r) => path(r).endsWith("/sharepage/save"))).toBe(false);
  });

  test("转存任务失败：空间不足 → limit；账号目录不污染", async () => {
    installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/file/download") return fail(23018);
        if (p === "/1/clouddrive/file/sort") return ok({ list: [{ fid: "ROOT", file_name: "accountdl-tmp", dir: true }] });
        if (p === "/1/clouddrive/file") return ok({ fid: "N" });
        if (p === "/1/clouddrive/share/sharepage/save") return ok({ task_id: "T" });
        if (p === "/1/clouddrive/task") return ok({ status: 3, message: "capacity limit[{0}]" });
        return undefined;
      }),
    );
    const err = await run(task({}), item).catch((e: unknown) => e);
    expect((err as SiteError).kind).toBe("limit");
  });

  test("过期判断", () => {
    expect(scratchExpired(`${NOW - 7 * 3600}-ab`, NOW)).toBe(true);
    expect(scratchExpired(`${NOW - 60}-ab`, NOW)).toBe(false);
    expect(scratchExpired("用户目录", NOW)).toBe(false);
  });
});

describe("夸克：__puus 刷新", () => {
  test("登录失效（31001）→ /config 补发 __puus → 重试用新会话，补丁带新 Cookie", async () => {
    let tokenCalls = 0;
    const { requests } = installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/config") return { body: { code: 0 }, headers: { "content-type": "application/json", "set-cookie": "__puus=PUUS2; Path=/; HttpOnly" } };
        if (p === "/1/clouddrive/share/sharepage/token" && ++tokenCalls === 1) return { status: 401, body: { code: 31001, message: "require login" } };
        return undefined;
      }),
    );
    const res = await run(task({}), `0:${FID_A}`);
    const cfg = requests.find((r) => path(r) === "/1/clouddrive/config")!;
    expect(parseCookies(header(cfg, "cookie")!).has("__puus")).toBe(false); // 刷新请求不带旧 __puus
    expect(parseCookies(header(cfg, "cookie")!).get("__pus")).toBe("PUS1");
    const retry = requests.filter((r) => path(r) === "/1/clouddrive/share/sharepage/token")[1];
    expect(parseCookies(header(retry, "cookie")!).get("__puus")).toBe("PUUS2");
    expect(res.request?.cookies).toBe("__pus=PUS1; __puus=PUUS2");
  });

  test("刷新后仍失效 → login；只刷新一次", async () => {
    const { requests } = installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/config") return ok({});
        if (p === "/1/clouddrive/share/sharepage/token") return fail(31001);
        return undefined;
      }),
    );
    const err = await run(task({})).catch((e: unknown) => e);
    expect((err as SiteError).kind).toBe("login");
    expect(requests.filter((r) => path(r) === "/1/clouddrive/config")).toHaveLength(1);
    expect(requests.filter((r) => path(r).endsWith("/token"))).toHaveLength(2);
  });

  test("刷新没有发新 __puus 时沿用原 Cookie", async () => {
    let n = 0;
    const { requests } = installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/config") return ok({});
        if (p === "/1/clouddrive/share/sharepage/token" && ++n === 1) return fail(20002);
        return undefined;
      }),
    );
    await run(task({}), `0:${FID_A}`);
    const retry = requests.filter((r) => path(r).endsWith("/token"))[1];
    expect(header(retry, "cookie")).toBe(COOKIE);
  });
});

describe("夸克：错误码映射", () => {
  const cases: Array<[number, string]> = [
    [31001, "login"],
    [20002, "login"],
    [41008, "password"],
    [41007, "password"],
    [41009, "password"],
    [24000, "password"],
    [41006, "notFound"],
    [41012, "notFound"],
    [24001, "notFound"],
    [41010, "notFound"],
    [12345, "other"],
  ];
  for (const [code, kind] of cases) {
    test(`token 接口错误码 ${code} → ${kind}`, async () => {
      installFlux(server((req) => (path(req).endsWith("/token") ? fail(code, "msg") : undefined)));
      const err = await run(task({})).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SiteError);
      expect((err as SiteError).kind).toBe(kind);
      expect((err as SiteError).message).not.toContain("PUS1");
    });
  }

  test("23018 在转存后仍出现 → limit；非 JSON 响应 → network", async () => {
    installFlux(
      server((req) => {
        const p = path(req);
        if (p === "/1/clouddrive/file/download") return fail(23018);
        if (p === "/1/clouddrive/file/sort") return ok({ list: [{ fid: "ROOT", file_name: "accountdl-tmp", dir: true }] });
        if (p === "/1/clouddrive/file") return ok({ fid: "N" });
        if (p === "/1/clouddrive/share/sharepage/save") return ok({ task_id: "T" });
        if (p === "/1/clouddrive/task") return ok({ status: 2, save_as: { save_as_top_fids: ["O"] } });
        return undefined;
      }),
    );
    const limit = await run(task({}), `0:${FID_A}`).catch((e: unknown) => e);
    expect((limit as SiteError).kind).toBe("limit");

    installFlux(() => ({ status: 502, body: "<html>bad gateway</html>" }));
    const net = await run(task({})).catch((e: unknown) => e);
    expect((net as SiteError).kind).toBe("network");
  });
});
