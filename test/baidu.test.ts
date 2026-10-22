import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseUrl } from "../src/core/url";
import type { ResolveInput } from "../src/core/site";
import type { ErrorKind } from "../src/core/errors";
import { baidu } from "../src/sites/baidu";
import { ANDROID_UA, SCRATCH_ROOT } from "../src/sites/baidu/api";
import { dirFromHash, makeTaskUrl, parseSharePage, readTask } from "../src/sites/baidu/link";
import { LOCATE_MAGIC, locateSign } from "../src/sites/baidu/sign";
import { header, installFlux, type MockRequest, type MockResponse } from "./helpers";

const COOKIES = "BAIDUID=bid; BDUSS=USS123; STOKEN=stk";
const BROWSER_UA = "Mozilla/5.0 TestBrowser";
const BIG_FSID = "1099511627776123456"; // > 2^53：不能经过 JS 数字

function input(url: string, over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    taskId: "t1", url, parsed: parseUrl(url)!, cookies: COOKIES, userAgent: BROWSER_UA, referrer: "", resolverItem: "", ...over,
  };
}

function rootTask(extra: Record<string, string> = {}): string {
  return makeTaskUrl({ key: "1AbCdEf", pwd: "abcd", ...extra });
}

async function failure(p: Promise<unknown>): Promise<{ kind: ErrorKind; message: string }> {
  try {
    await p;
  } catch (e) {
    return { kind: Reflect.get(e as object, "kind") as ErrorKind, message: (e as Error).message };
  }
  throw new Error("应当失败");
}

const path = (req: MockRequest) => new URL(req.url).pathname;
const query = (req: MockRequest) => new URL(req.url).searchParams;
const form = (req: MockRequest) => new URLSearchParams(req.body ?? "");

interface Fake {
  verify?: unknown;
  verifyCookie?: string;
  /** 按 `dir` 参数（根目录为 ""）返回的分享目录列表响应。 */
  lists?: Record<string, unknown>;
  login?: unknown;
  vip?: number;
  mkdir?: unknown;
  transfer?: unknown;
  taskquery?: unknown[];
  locate?: unknown;
  remove?: unknown;
}

function fakeBaidu(f: Fake = {}) {
  const queryLeft = [...(f.taskquery ?? [])];
  return (req: MockRequest): MockResponse => {
    const p = path(req);
    const q = query(req);
    if (p === "/share/verify") {
      return {
        headers: { "content-type": "application/json", "set-cookie": f.verifyCookie ?? "BDCLND=sek%2B1; Path=/; Domain=.baidu.com" },
        body: f.verify ?? { errno: 0, randsk: "sek%2B1" },
      };
    }
    if (p === "/share/list") return { body: f.lists?.[q.get("dir") ?? ""] ?? { errno: 0, share_id: "777", uk: "888", list: [] } };
    if (p === "/api/loginStatus") return { body: f.login ?? { errno: 0, login_info: { bdstoken: "tok", uk: 4242 } } };
    if (p === "/api/user/getinfo") return { body: { errno: 0, records: [{ vip_type: f.vip ?? 0 }] } };
    if (p === "/api/create") return { body: f.mkdir ?? { errno: 0 } };
    if (p === "/share/transfer") {
      return { body: f.transfer ?? { errno: 0, extra: { list: [{ from: "/共享/电影.mkv", to: `${form(req).get("path")}/电影.mkv` }] } } };
    }
    if (p === "/share/taskquery") return { body: queryLeft.shift() ?? { errno: 0, task_errno: 0, status: "running" } };
    if (p === "/rest/2.0/pcs/file") {
      return { body: f.locate ?? { urls: [{ url: "https://d.pcs.baidupcs.com/file/x?sign=s", encrypt: 0 }] } };
    }
    if (p === "/api/filemanager") return { body: f.remove ?? { errno: 0 } };
    throw new Error(`未预期的请求 ${req.method} ${req.url}`);
  };
}

const paths = (reqs: MockRequest[]) => reqs.map(path);

describe("百度网盘 链接识别", () => {
  test("分享页三种形式识别 key 与提取码，仿冒域名与非分享路径不识别", () => {
    const p = (u: string) => parseSharePage(parseUrl(u)!);
    expect(p("https://pan.baidu.com/s/1AbCdEf?pwd=a1b2")).toEqual({ key: "1AbCdEf", pwd: "a1b2" });
    expect(p("https://pan.baidu.com/s/1AbCdEf#list/path=%2F")).toEqual({ key: "1AbCdEf", pwd: "" });
    expect(p("https://yun.baidu.com/share/init?surl=AbCdEf&pwd=zzzz")).toEqual({ key: "1AbCdEf", pwd: "zzzz" });
    expect(p("https://pan.baidu.com/wap/init?surl=AbCdEf")).toEqual({ key: "1AbCdEf", pwd: "" });
    expect(p("https://pan.baidu.com.evil.com/s/1AbCdEf")).toBeNull();
    expect(p("https://evilpan.baidu.com/s/1AbCdEf")).toBeNull();
    expect(p("https://pan.baidu.com/disk/home")).toBeNull();
    expect(p("https://pan.baidu.com/share/init?surl=a")).toBeNull();
  });

  test("页面 hash 里的当前目录解码；根目录与畸形值为空", () => {
    expect(dirFromHash("list/path=%2F%E7%94%B5%E5%BD%B1%2F2024")).toBe("/电影/2024");
    expect(dirFromHash("list/path=%2F")).toBe("");
    expect(dirFromHash("list/path=%2F%E7%94%B5%E5%BD%B1%2F")).toBe("/电影");
    expect(dirFromHash("")).toBe("");
    expect(dirFromHash("list/path=relative")).toBe("");
  });

  test("任务 URL 往返（中文、& 与 #），主机固定为 pan.baidu.com", () => {
    const url = makeTaskUrl({ key: "1AbCdEf", pwd: "a1b2", dir: "/电影 & 剧集/#1", name: "#1" });
    expect(url.startsWith("https://pan.baidu.com/__accountdl/baidu?")).toBe(true);
    expect(readTask(parseUrl(url)!)).toEqual({ key: "1AbCdEf", surl: "AbCdEf", pwd: "a1b2", dir: "/电影 & 剧集/#1", name: "#1" });
    expect(baidu.claims(parseUrl(url)!)).toBe(true);
  });

  test("任务 URL 参数是不可信输入：坏 key、相对目录、其他主机、其他站点都不认领", () => {
    const bad = (u: string) => baidu.claims(parseUrl(u)!);
    expect(bad("https://pan.baidu.com/__accountdl/baidu?s=bad")).toBe(false);
    expect(bad("https://pan.baidu.com/__accountdl/baidu?s=1AbCdEf&dir=rel")).toBe(false);
    expect(bad("https://pan.baidu.com/__accountdl/baidu?s=1AbCdEf&pwd=a%20b")).toBe(false);
    expect(bad("https://pan.baidu.com.evil.com/__accountdl/baidu?s=1AbCdEf")).toBe(false);
    expect(bad("https://pan.baidu.com/__accountdl/quark?s=1AbCdEf")).toBe(false);
    expect(bad("https://pan.baidu.com/s/1AbCdEf")).toBe(false);
  });
});

describe("百度网盘 locatedownload 签名", () => {
  test("按 ops 算法计算（对照 node:crypto 独立实现），字段齐全", () => {
    const bduss = "USS123";
    const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
    const devuid = `${createHash("md5").update(bduss).digest("hex").toUpperCase()}|0`;
    const sign = locateSign("4242", bduss, 1_800_000_000);
    expect(sign).toEqual({
      time: "1800000000",
      devuid,
      cuid: devuid,
      rand: sha1(sha1(bduss) + "4242" + "ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF" + "1800000000" + devuid),
    });
    expect(LOCATE_MAGIC).toBe("ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF");
    expect(sign.devuid).toMatch(/^[0-9A-F]{32}\|0$/);
  });
});

describe("百度网盘 初段：验证提取码与列目录生成清单", () => {
  test("递归列目录生成清单；Cookie 含登录态与 BDCLND，列目录用任务 UA，大 fs_id 不丢精度", async () => {
    const { requests } = installFlux(
      fakeBaidu({
        lists: {
          "": {
            errno: 0, share_id: "777", uk: "888",
            list: [
              { server_filename: "子目录", isdir: 1, path: "/子目录", fs_id: 11 },
              { server_filename: "a.txt", isdir: 0, path: "/a.txt", fs_id: 22, size: 5 },
            ],
          },
          "/子目录": `{"errno":0,"list":[{"server_filename":"b.bin","isdir":0,"path":"/子目录/b.bin","fs_id":${BIG_FSID},"size":2048}]}`,
        },
      }),
    );
    const res = await baidu.resolve(input(rootTask({ name: "我的分享" })));
    expect(res.manifest).toEqual({
      name: "我的分享",
      items: [
        { id: "22:5", name: "a.txt", kind: "file", size: 5 },
        { id: `${BIG_FSID}:2048`, name: "b.bin", kind: "file", path: "子目录", size: 2048 },
      ],
    });
    expect(requests.every((r) => new URL(r.url).host === "pan.baidu.com")).toBe(true);
    const verify = requests.find((r) => path(r) === "/share/verify")!;
    expect(verify.method).toBe("POST");
    expect(form(verify).get("pwd")).toBe("abcd");
    expect(query(verify).get("surl")).toBe("AbCdEf");
    const lists = requests.filter((r) => path(r) === "/share/list");
    expect(lists.length).toBe(2);
    for (const l of lists) {
      expect(header(l, "cookie")).toContain("BDUSS=USS123");
      expect(header(l, "cookie")).toContain("BDCLND=sek%2B1");
      expect(header(l, "user-agent")).toBe(BROWSER_UA);
      expect(header(l, "referer")).toBe("https://pan.baidu.com/share/init?surl=AbCdEf");
    }
    expect(query(lists[0]).get("root")).toBe("1");
    expect(query(lists[1]).get("dir")).toBe("/子目录");
  });

  test("任务指定目录时只列该目录，清单名取目录名；条目路径相对该目录", async () => {
    const { requests } = installFlux(
      fakeBaidu({
        lists: { "/电影": { errno: 0, share_id: "1", uk: "2", list: [{ server_filename: "x.mkv", isdir: 0, path: "/电影/x.mkv", fs_id: 5, size: 9 }] } },
      }),
    );
    const res = await baidu.resolve(input(rootTask({ dir: "/电影" })));
    expect(res.manifest?.name).toBe("电影");
    expect(res.manifest?.items).toEqual([{ id: "5:9", name: "x.mkv", kind: "file", size: 9 }]);
    const list = requests.find((r) => path(r) === "/share/list")!;
    expect(query(list).get("dir")).toBe("/电影");
    expect(query(list).get("root")).toBeNull();
  });

  test("没有提取码时不发验证请求，沿用浏览器 Cookie 里的 BDCLND", async () => {
    const { requests } = installFlux(
      fakeBaidu({ lists: { "": { errno: 0, share_id: "1", uk: "2", list: [{ server_filename: "a", isdir: 0, path: "/a", fs_id: 1, size: 1 }] } } }),
    );
    await baidu.resolve(input(makeTaskUrl({ key: "1AbCdEf" }), { cookies: `${COOKIES}; BDCLND=fromBrowser` }));
    expect(paths(requests)).not.toContain("/share/verify");
    expect(header(requests[0], "cookie")).toContain("BDCLND=fromBrowser");
  });

  test("目录满 100 条时继续翻页", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ server_filename: `f${i}`, isdir: 0, path: `/f${i}`, fs_id: i + 1, size: 1 }));
    let calls = 0;
    const { requests } = installFlux((req) => {
      if (path(req) === "/share/verify") return { body: { errno: 0, randsk: "r" } };
      calls++;
      return { body: { errno: 0, share_id: "1", uk: "2", list: query(req).get("page") === "1" ? page : [page[0]] } };
    });
    const res = await baidu.resolve(input(rootTask()));
    expect(res.manifest?.items.length).toBe(101);
    expect(calls).toBe(2);
    expect(requests.filter((r) => path(r) === "/share/list").map((r) => query(r).get("page"))).toEqual(["1", "2"]);
  });

  test("文件超过 1000 个：limit，提示进入子目录", async () => {
    const mk = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ server_filename: `f${n}-${i}`, isdir: 0, path: `/f${n}-${i}`, fs_id: n * 100 + i + 1, size: 1 }));
    installFlux((req) => {
      if (path(req) === "/share/verify") return { body: { errno: 0, randsk: "r" } };
      return { body: { errno: 0, share_id: "1", uk: "2", list: mk(Number(query(req).get("page"))) } };
    });
    const err = await failure(baidu.resolve(input(rootTask())));
    expect(err.kind).toBe("limit");
    expect(err.message).toContain("子目录");
  });

  test("目录层级过深、请求数超限：limit，不无限递归", async () => {
    let n = 0;
    const { requests } = installFlux((req) => {
      if (path(req) === "/share/verify") return { body: { errno: 0, randsk: "r" } };
      n++;
      return { body: { errno: 0, share_id: "1", uk: "2", list: [{ server_filename: "d", isdir: 1, path: `/d${n}`, fs_id: n }] } };
    });
    const err = await failure(baidu.resolve(input(rootTask())));
    expect(err.kind).toBe("limit");
    expect(requests.length).toBeLessThanOrEqual(20);
  });

  test("空分享：notFound", async () => {
    installFlux(fakeBaidu());
    expect((await failure(baidu.resolve(input(rootTask())))).kind).toBe("notFound");
  });
});

describe("百度网盘 错误码映射", () => {
  test("没有 BDUSS：login，不发任何请求", async () => {
    const { requests } = installFlux(fakeBaidu());
    const err = await failure(baidu.resolve(input(rootTask(), { cookies: "BAIDUID=x" })));
    expect(err.kind).toBe("login");
    expect(requests.length).toBe(0);
  });

  const verifyCases: Array<[number, ErrorKind]> = [[-9, "password"], [105, "notFound"], [117, "notFound"], [-62, "limit"], [-6, "login"], [31, "other"]];
  for (const [errno, kind] of verifyCases) {
    test(`验证提取码 errno ${errno} → ${kind}`, async () => {
      installFlux(fakeBaidu({ verify: { errno } }));
      expect((await failure(baidu.resolve(input(rootTask())))).kind).toBe(kind);
    });
  }

  const listCases: Array<[number, ErrorKind]> = [[-9, "password"], [-6, "login"], [140, "notFound"], [2, "notFound"], [9019, "limit"], [8001, "limit"]];
  for (const [errno, kind] of listCases) {
    test(`列目录 errno ${errno} → ${kind}`, async () => {
      installFlux(fakeBaidu({ lists: { "": { errno } } }));
      expect((await failure(baidu.resolve(input(rootTask())))).kind).toBe(kind);
    });
  }

  test("提取码错误的消息不含提取码与 Cookie", async () => {
    installFlux(fakeBaidu({ verify: { errno: -9 } }));
    const err = await failure(baidu.resolve(input(rootTask())));
    expect(err.message).not.toContain("abcd");
    expect(err.message).not.toContain("USS123");
  });
});

describe("百度网盘 二段：转存 → 取链 → 删除", () => {
  const item = (size = 2048) => `${BIG_FSID}:${size}`;
  const fileInput = (over: Partial<ResolveInput> = {}) => input(rootTask(), { resolverItem: item(), ...over });

  test("完整链路：请求顺序、签名、UA/Cookie、删除在取链之后；返回最小 Cookie 与 Range 补丁", async () => {
    const { requests } = installFlux(fakeBaidu({ vip: 2 }));
    const res = await baidu.resolve(fileInput({ resolverItem: `${BIG_FSID}:${100 * 1024 * 1024}` }));

    expect(res.url).toBe("https://d.pcs.baidupcs.com/file/x?sign=s");
    expect(res.fileName).toBe("电影.mkv");
    expect(res.totalBytes).toBe(100 * 1024 * 1024);
    expect(res.request).toEqual({
      cookies: "",
      userAgent: ANDROID_UA,
      maxConnections: 15,
      maxRangeBytes: 5 * 1024 * 1024,
      segments: 15,
    });

    const seq = paths(requests);
    const at = (p: string) => seq.indexOf(p);
    expect(at("/share/verify")).toBeLessThan(at("/share/list"));
    expect(at("/api/create")).toBeGreaterThan(at("/api/loginStatus"));
    expect(at("/api/create")).toBeLessThan(at("/share/transfer"));
    expect(at("/share/transfer")).toBeLessThan(at("/rest/2.0/pcs/file"));
    expect(seq[seq.length - 1]).toBe("/api/filemanager");

    const create = requests[at("/api/create")];
    const dir = form(create).get("path")!;
    expect(dir).toMatch(new RegExp(`^${SCRATCH_ROOT}/\\d+-[0-9a-f]+$`));
    expect(form(create).get("isdir")).toBe("1");
    expect(query(create).get("bdstoken")).toBe("tok");
    expect(header(create, "user-agent")).toBe(ANDROID_UA);

    const transfer = requests[at("/share/transfer")];
    expect(form(transfer).get("fsidlist")).toBe(`[${BIG_FSID}]`);
    expect(form(transfer).get("path")).toBe(dir);
    expect(query(transfer).get("shareid")).toBe("777");
    expect(query(transfer).get("from")).toBe("888");
    expect(header(transfer, "cookie")).toContain("BDCLND=sek%2B1");
    expect(header(transfer, "referer")).toBe("https://pan.baidu.com/s/1AbCdEf");
    expect(header(transfer, "user-agent")).toBe(ANDROID_UA);

    const locate = requests[at("/rest/2.0/pcs/file")];
    expect(new URL(locate.url).host).toBe("pcs.baidu.com");
    expect(header(locate, "cookie")).toBe("BDUSS=USS123");
    expect(header(locate, "user-agent")).toBe(ANDROID_UA);
    const lq = query(locate);
    expect(lq.get("method")).toBe("locatedownload");
    expect(lq.get("path")).toBe(`${dir}/电影.mkv`);
    expect(lq.get("clienttype")).toBe("17");
    const expected = locateSign("4242", "USS123", Number(lq.get("time")));
    expect(lq.get("rand")).toBe(expected.rand);
    expect(lq.get("devuid")).toBe(expected.devuid);
    expect(lq.get("cuid")).toBe(expected.cuid);

    const del = requests[at("/api/filemanager")];
    expect(query(del).get("opera")).toBe("delete");
    expect(JSON.parse(form(del).get("filelist")!)).toEqual([dir]);
  });

  test("会员等级决定连接数与 Range：普通 1 连接 / 4 MiB，会员 10 连接，查询失败按普通", async () => {
    installFlux(fakeBaidu({ vip: 0 }));
    expect((await baidu.resolve(fileInput())).request).toMatchObject({ maxConnections: 1, maxRangeBytes: 4 * 1024 * 1024, segments: 1 });
    installFlux(fakeBaidu({ vip: 1 }));
    expect((await baidu.resolve(fileInput({ resolverItem: `${BIG_FSID}:${1024 * 1024 * 1024}` }))).request).toMatchObject({
      maxConnections: 10, maxRangeBytes: 4 * 1024 * 1024, segments: 10,
    });
    installFlux((req) => {
      if (path(req) === "/api/user/getinfo") throw new Error("boom");
      return fakeBaidu()(req);
    });
    expect((await baidu.resolve(fileInput())).request).toMatchObject({ maxConnections: 1 });
  });

  test("条目 id 没带大小时不声明 totalBytes / segments，仍显式设置 cookies", async () => {
    installFlux(fakeBaidu());
    const res = await baidu.resolve(fileInput({ resolverItem: BIG_FSID }));
    expect(res.totalBytes).toBeUndefined();
    expect(res.request?.cookies).toBe("");
    expect(res.request?.segments).toBeUndefined();
  });

  test("转存是异步任务：轮询 taskquery 直到 success", async () => {
    const { requests } = installFlux(
      fakeBaidu({
        transfer: { errno: 0, task_id: "99999999999999999" },
        taskquery: [
          { errno: 0, task_errno: 0, status: "running" },
          { errno: 0, task_errno: 0, status: "success", list: [{ from: "/共享/电影.mkv", to: "/x/y/电影.mkv" }] },
        ],
      }),
    );
    const res = await baidu.resolve(fileInput());
    expect(requests.filter((r) => path(r) === "/share/taskquery").length).toBe(2);
    expect(query(requests.find((r) => path(r) === "/share/taskquery")!).get("taskid")).toBe("99999999999999999");
    expect(res.fileName).toBe("电影.mkv");
    expect(query(requests.find((r) => path(r) === "/rest/2.0/pcs/file")!).get("path")).toBe("/x/y/电影.mkv");
  });

  test("取直链失败：仍删除临时目录，错误原样抛出（风控 → limit）", async () => {
    const { requests } = installFlux(fakeBaidu({ locate: { errno: 9019 } }));
    const err = await failure(baidu.resolve(fileInput()));
    expect(err.kind).toBe("limit");
    expect(paths(requests)).toContain("/api/filemanager");
    expect(paths(requests).filter((p) => p === "/api/filemanager").length).toBe(1);
  });

  test("locate 返回的链接全是加密的：network 错误且已删除", async () => {
    const { requests } = installFlux(fakeBaidu({ locate: { urls: [{ url: "https://x/y", encrypt: 1 }] } }));
    expect((await failure(baidu.resolve(fileInput()))).kind).toBe("network");
    expect(paths(requests)).toContain("/api/filemanager");
  });

  test("空间不足（transfer errno 12 / info -32）：limit 并给出提示，仍删除", async () => {
    const { requests } = installFlux(fakeBaidu({ transfer: { errno: 12, info: [{ errno: -32 }] } }));
    const err = await failure(baidu.resolve(fileInput()));
    expect(err.kind).toBe("limit");
    expect(err.message).toContain("空间不足");
    expect(paths(requests)).toContain("/api/filemanager");
  });

  test("转存其他错误码：2 → notFound，-9 → password，-6 → limit", async () => {
    for (const [errno, kind] of [[2, "notFound"], [-9, "password"], [-6, "limit"]] as const) {
      installFlux(fakeBaidu({ transfer: { errno } }));
      expect((await failure(baidu.resolve(fileInput()))).kind).toBe(kind);
    }
  });

  test("账号登录失效（loginStatus -6）：login，且没有创建任何临时目录", async () => {
    const { requests } = installFlux(fakeBaidu({ login: { errno: -6 } }));
    expect((await failure(baidu.resolve(fileInput()))).kind).toBe("login");
    expect(paths(requests)).not.toContain("/api/create");
    expect(paths(requests)).not.toContain("/api/filemanager");
  });

  test("创建临时目录失败（-6）：limit；删除失败不覆盖成功结果", async () => {
    installFlux(fakeBaidu({ mkdir: { errno: -6 } }));
    expect((await failure(baidu.resolve(fileInput()))).kind).toBe("limit");

    installFlux(fakeBaidu({ remove: { errno: 31066 } }));
    const res = await baidu.resolve(fileInput());
    expect(res.url).toBe("https://d.pcs.baidupcs.com/file/x?sign=s");
  });

  test("提取码错误发生在转存之前：不碰网盘写接口", async () => {
    const { requests } = installFlux(fakeBaidu({ verify: { errno: -9 } }));
    expect((await failure(baidu.resolve(fileInput()))).kind).toBe("password");
    expect(paths(requests)).not.toContain("/api/create");
  });

  test("条目标识非法：unsupported，不发请求", async () => {
    const { requests } = installFlux(fakeBaidu());
    expect((await failure(baidu.resolve(fileInput({ resolverItem: "../x" })))).kind).toBe("unsupported");
    expect(requests.length).toBe(0);
  });
});
