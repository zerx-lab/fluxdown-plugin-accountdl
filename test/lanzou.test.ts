import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "../src/core/errors";
import { parseUrl } from "../src/core/url";
import { lanzou } from "../src/sites/lanzou";
import { calcAcwScV2, findChallenge } from "../src/sites/lanzou/acw";
import { parseShareLink, shareUrl } from "../src/sites/lanzou/link";
import { header, installFlux, type MockRequest, type MockResponse } from "./helpers";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lanzou", name), "utf8");
const HTML = { "content-type": "text/html; charset=utf-8" };

// 真实挑战页 arg1 与对应 acw_sc__v2（2026-10 实测：带该 Cookie 的直链请求返回 302）。
const ARG1 = "CEC541BB68266250AAC1A9E9D638D8D863A0E1B2";
const ACW = "6ad977a186484398d007bb481a8581b583483d15";

const HOST = "www.lanzoub.com";
const DOM = "https://developer4.lanrar.com";
const TOKEN = "?FIXTURE_DOWN_TOKEN";
const DIRECT = `${DOM}/file/${TOKEN}`;
const TOTAL = 1663567;

function resolve(url: string, resolverItem = "") {
  return lanzou.resolve({ taskId: "t1", url, parsed: parseUrl(url)!, cookies: "", userAgent: "UA-test", referrer: "", resolverItem });
}

async function rejects(promise: Promise<unknown>): Promise<SiteError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SiteError);
    return e as SiteError;
  }
  throw new Error("应当抛出 SiteError");
}

/** 直链主机：无 Cookie → 挑战页；带正确 acw 但缺中文 Accept-Language → 验证页；齐全 → 206。 */
function directHost(req: MockRequest, mode: "ok" | "verify" = "ok"): MockResponse {
  const cookie = header(req, "cookie") ?? "";
  if (!cookie.includes(`acw_sc__v2=${ACW}`)) return { headers: HTML, body: fixture("challenge.html") };
  if (mode === "verify" || !/zh/.test(header(req, "accept-language") ?? "")) return { headers: HTML, body: fixture("verify.html") };
  return { status: 206, headers: { "content-type": "application/octet-stream", "content-range": `bytes 0-0/${TOTAL}` }, body: "P" };
}

const okJson = (extra: Record<string, unknown> = {}): MockResponse => ({ body: { zt: 1, dom: DOM, url: TOKEN, inf: 0, ...extra } });

function expectDirect(res: ResolveResult, fileName: string) {
  expect(res.url).toBe(DIRECT);
  expect(res.fileName).toBe(fileName);
  expect(res.totalBytes).toBe(TOTAL);
  // 必须显式设置 Cookie：只含直链需要的两项，不带浏览器整串 Cookie。
  expect(res.request?.cookies).toBe(`down_ip=1; acw_sc__v2=${ACW}`);
  expect(res.request?.setHeaders?.["Accept-Language"]).toContain("zh");
}

describe("蓝奏云 链接识别", () => {
  test("多个分享域名、子域名与 /tp/ 旧路径都认领，并取出提取码", () => {
    for (const url of [
      "https://www.lanzoub.com/iMq6x3jilnqb",
      "https://wwi.lanzoup.com/b073l8d1e",
      "https://xiu.lanzouw.com/iMq6x3jilnqb",
      "http://www.lanzn.com/iMq6x3jilnqb",
      "https://www.lanpw.com/iMq6x3jilnqb",
      "https://www.lanzoux.com/tp/iMq6x3jilnqb",
    ]) {
      expect(lanzou.claims(parseUrl(url)!)).toBe(true);
    }
    expect(parseShareLink(parseUrl("https://www.lanzoux.com/tp/iMq6x3jilnqb?pwd=a%26b")!)).toEqual({
      host: "www.lanzoux.com",
      id: "iMq6x3jilnqb",
      pwd: "a&b",
    });
  });

  test("仿冒域名、非分享路径与下载 CDN 链接不认领", () => {
    for (const url of [
      "https://www.lanzoub.com.evil.com/iMq6x3jilnqb",
      "https://evil-lanzoub.com/iMq6x3jilnqb",
      "https://lanzoub.com.cn/iMq6x3jilnqb",
      "https://www.lanzoub.com/u",
      "https://www.lanzoub.com/account.php",
      "https://www.lanzoub.com/fn?abc",
      "https://s41.lanzoug.com/100309bb/2022/07/27/c9cfbdfb1d487506e3dd375317a3464f.mp3?st=abc",
      "https://developer4.lanrar.com/file/?AmRSbF5v",
      "https://pan.baidu.com/s/1abcdef",
    ]) {
      expect(lanzou.claims(parseUrl(url)!)).toBe(false);
    }
  });

  test("规范分享链接：提取码编码，往返一致", () => {
    const url = shareUrl("www.lanzoub.com", "iMq6x3jilnqb", "中&文#1");
    expect(parseShareLink(parseUrl(url)!)).toEqual({ host: "www.lanzoub.com", id: "iMq6x3jilnqb", pwd: "中&文#1" });
    expect(shareUrl("www.lanzoub.com", "iMq6x3jilnqb")).toBe("https://www.lanzoub.com/iMq6x3jilnqb");
  });
});

describe("蓝奏云 acw_sc__v2", () => {
  test("计算向量：实测向量与独立实现的交叉向量", () => {
    expect(calcAcwScV2(ARG1)).toBe(ACW);
    expect(calcAcwScV2(ARG1.toLowerCase())).toBe(ACW);
    expect(calcAcwScV2("71552658861A285FCC6993991975D7876DAE517C")).toBe("6ad9781168eda73f14747dcbb97a7e55e5d5d6db");
    expect(calcAcwScV2("77E4CF70D463A45FC6B568495486D33160A80409")).toBe("6ad978144d36f8825ce3070376171a74eb66034d");
    expect(() => calcAcwScV2("ABC")).toThrow();
  });

  test("只在挑战页里找 arg1", () => {
    expect(findChallenge(fixture("challenge.html"))).toBe(ARG1);
    expect(findChallenge(fixture("file-share.html"))).toBeNull();
    expect(findChallenge('{"zt":1}')).toBeNull();
  });
});

describe("蓝奏云 单文件", () => {
  /** 无密码文件的整条链：分享页 → /fn 内页 → ajaxfile → 直链。 */
  function fileServer(mode: "ok" | "verify" = "ok") {
    return (req: MockRequest): MockResponse => {
      const u = req.url;
      if (u === `https://${HOST}/iFileAAAA`) return { headers: HTML, body: fixture("file-share.html") };
      if (u === `https://${HOST}/fn?FIXTURE_FN_TOKEN`) return { headers: HTML, body: fixture("file-inner.html") };
      if (u === "https://apifile.woozooo.com/ajaxfile.php?file=276372891") return okJson();
      if (u === DIRECT) return directHost(req, mode);
      throw new Error(`未预期的请求 ${req.method} ${u}`);
    };
  }

  test("无密码：按页面里的参数请求，直链带 acw 与中文 Accept-Language", async () => {
    const { requests } = installFlux(fileServer());
    const res = await resolve(`https://${HOST}/iFileAAAA`);
    expectDirect(res, "Tampermonkey_5.4.1(需要启用开发者模式才可用).zip");
    expect(res.request?.referrer).toBe(DOM);

    const post = requests.find((r) => r.method === "POST")!;
    expect(post.body).toBe("action=downprocess&websignkey=FxAj&signs=FxAj&sign=FIXTURE_WP_SIGN&websign=&kd=1&ves=1");
    expect(header(post, "referer")).toBe(`https://${HOST}/fn?FIXTURE_FN_TOKEN`);
    expect(header(post, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(header(post, "user-agent")).toBe("UA-test");

    // 直链探测：Range 0-0、不带浏览器 Cookie、第一次无 Cookie 取到挑战页，第二次带算出的 acw。
    const probes = requests.filter((r) => r.url === DIRECT);
    expect(probes).toHaveLength(2);
    expect(header(probes[0], "cookie")).toBe("down_ip=1");
    expect(header(probes[1], "cookie")).toBe(`down_ip=1; acw_sc__v2=${ACW}`);
    expect(header(probes[1], "range")).toBe("bytes=0-0");
  });

  test("任务带来的浏览器 Cookie 不会发给蓝奏云", async () => {
    const { requests } = installFlux(fileServer());
    const url = `https://${HOST}/iFileAAAA`;
    await lanzou.resolve({ taskId: "t", url, parsed: parseUrl(url)!, cookies: "ylogin=secret; acw_sc__v2=old", userAgent: "", referrer: "", resolverItem: "" });
    for (const r of requests) expect(header(r, "cookie") ?? "").not.toContain("secret");
  });

  test("分享页本身先返回挑战页：算出 acw 后重发，后续请求都带上", async () => {
    let first = true;
    const inner = fileServer();
    const { requests } = installFlux((req) => {
      if (req.url === `https://${HOST}/iFileAAAA` && !header(req, "cookie")) {
        first = false;
        return { headers: HTML, body: fixture("challenge.html") };
      }
      return inner(req);
    });
    const res = await resolve(`https://${HOST}/iFileAAAA`);
    expect(first).toBe(false);
    expectDirect(res, "Tampermonkey_5.4.1(需要启用开发者模式才可用).zip");
    const afterChallenge = requests.filter((r) => r.url === `https://${HOST}/fn?FIXTURE_FN_TOKEN`);
    expect(header(afterChallenge[0], "cookie")).toBe(`acw_sc__v2=${ACW}`);
  });

  test("直链返回下载验证页（网络异常）→ limit，不把验证页当文件", async () => {
    installFlux(fileServer("verify"));
    const err = await rejects(resolve(`https://${HOST}/iFileAAAA`));
    expect(err.kind).toBe("limit");
    expect(err.message).not.toContain(TOKEN);
  });

  test("文件已取消分享 → notFound", async () => {
    const { requests } = installFlux(() => ({ headers: HTML, body: fixture("gone.html") }));
    const err = await rejects(resolve(`https://${HOST}/iFileAAAA`));
    expect(err.kind).toBe("notFound");
    expect(requests).toHaveLength(1);
  });

  test("页面结构变化（找不到下载入口）→ network，不盲目请求", async () => {
    const { requests } = installFlux(() => ({ headers: HTML, body: "<html><body>空页面</body></html>" }));
    const err = await rejects(resolve(`https://${HOST}/iFileAAAA`));
    expect(err.kind).toBe("network");
    expect(requests).toHaveLength(1);
  });

  test("接口限流（zt=4）→ limit", async () => {
    const server = fileServer();
    installFlux((req) => (req.method === "POST" ? { body: { zt: 4, dom: DOM, url: 0, inf: "请求过于频繁" } } : server(req)));
    expect((await rejects(resolve(`https://${HOST}/iFileAAAA`))).kind).toBe("limit");
  });
});

describe("蓝奏云 带提取码的文件", () => {
  const PWD_AJAX = "https://apifile.woozooo.com/ajaxfile.php?file=25792756";

  function pwdServer(onPost: (body: URLSearchParams) => MockResponse) {
    return (req: MockRequest): MockResponse => {
      if (req.url === `https://${HOST}/iPwdFile1`) return { headers: HTML, body: fixture("file-password.html") };
      if (req.url === PWD_AJAX) return onPost(new URLSearchParams(req.body));
      if (req.url === DIRECT) return directHost(req);
      throw new Error(`未预期的请求 ${req.method} ${req.url}`);
    };
  }

  test("提取码随表单提交，文件名取自接口的 inf；sign 取页面里最后一次非空赋值", async () => {
    const posts: URLSearchParams[] = [];
    installFlux(
      pwdServer((body) => {
        posts.push(body);
        return okJson({ inf: "徐海俏 - 空.txt" });
      }),
    );
    const res = await resolve(`https://${HOST}/iPwdFile1?pwd=1234`);
    expectDirect(res, "徐海俏 - 空.txt");
    expect(Object.fromEntries(posts[0])).toEqual({ action: "downprocess", sign: "FIXTURE_PWD_SIGN", kd: "1", p: "1234" });
  });

  test("缺少提取码 → password，且不向接口发请求", async () => {
    const { requests } = installFlux(pwdServer(() => okJson()));
    const err = await rejects(resolve(`https://${HOST}/iPwdFile1`));
    expect(err.kind).toBe("password");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("提取码错误 → password（不回显提取码）", async () => {
    installFlux(pwdServer(() => ({ body: { zt: 0, dom: DOM, url: 0, inf: "密码错误" } })));
    const err = await rejects(resolve(`https://${HOST}/iPwdFile1?pwd=wrongpwd9`));
    expect(err.kind).toBe("password");
    expect(err.message).not.toContain("wrongpwd9");
  });

  test("分享页参数过期等其他失败 → network", async () => {
    installFlux(pwdServer(() => ({ body: { zt: 0, dom: DOM, url: 0, inf: "已超时，请刷新" } })));
    const err = await rejects(resolve(`https://${HOST}/iPwdFile1?pwd=1234`));
    expect(err.kind).toBe("network");
  });
});

describe("蓝奏云 文件夹", () => {
  const LIST_URL = `https://${HOST}/filemoreajax.php?file=1486474`;

  const row = (i: number, extra: Record<string, unknown> = {}) => ({
    icon: "zip",
    t: 0,
    id: `iFile${String(i).padStart(6, "0")}`,
    name_all: `文件 ${i}.zip`,
    size: "1.5 M",
    time: "2026-03-01",
    duan: "x",
    p_ico: 0,
    ...extra,
  });
  const rows = (from: number, count: number) => Array.from({ length: count }, (_, k) => row(from + k));

  function folderServer(pages: Record<number, MockResponse>, pageFixture = "folder.html", pageUrl = `https://${HOST}/bFolder01`) {
    return (req: MockRequest): MockResponse => {
      if (req.url === pageUrl) return { headers: HTML, body: fixture(pageFixture) };
      if (req.url === LIST_URL || req.url.startsWith(`https://${HOST}/filemoreajax.php`)) {
        const pg = Number(new URLSearchParams(req.body).get("pg"));
        return pages[pg] ?? { body: { zt: 2, info: "没有文件", text: 0 } };
      }
      throw new Error(`未预期的请求 ${req.method} ${req.url}`);
    };
  }

  test("分页（每页 50 条）→ 清单；跳过推广条目；表单参数取自页面里的变量", async () => {
    const page1 = [...rows(1, 49), row(99, { t: 1, id: "iAdAd0001" })];
    const { requests } = installFlux(
      folderServer({
        1: { body: { zt: 1, info: "sucess", text: page1 } },
        2: { body: { zt: 1, info: "sucess", text: rows(50, 3) } },
      }),
    );
    const res = await resolve(`https://${HOST}/bFolder01`);
    const items = res.manifest!.items;
    expect(res.manifest!.name).toBe("脚本管理扩展");
    expect(items).toHaveLength(52);
    expect(items[0]).toEqual({ id: "iFile000001", name: "文件 1.zip", kind: "file", size: 1572864 });
    expect(items.some((i) => i.id === "iAdAd0001")).toBe(false);

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    const form = Object.fromEntries(new URLSearchParams(posts[0].body));
    expect(form).toEqual({
      lx: "2",
      fid: "1486474",
      uid: "493109",
      puid: "FIXTURE_PUID",
      pg: "1",
      rep: "0",
      t: "1700000000",
      k: "0123456789abcdef0123456789abcdef",
      up: "1",
    });
    expect(new URLSearchParams(posts[1].body).get("pg")).toBe("2");
    expect(header(posts[0], "referer")).toBe(`https://${HOST}/bFolder01`);
  });

  test("请求页数有限：超过 1000 个文件 → limit", async () => {
    const pages: Record<number, MockResponse> = {};
    for (let pg = 1; pg <= 25; pg++) pages[pg] = { body: { zt: 1, text: rows((pg - 1) * 50, 50) } };
    const { requests } = installFlux(folderServer(pages));
    const err = await rejects(resolve(`https://${HOST}/bFolder01`));
    expect(err.kind).toBe("limit");
    expect(requests.filter((r) => r.method === "POST").length).toBeLessThanOrEqual(21);
  });

  test("空文件夹（zt=2）→ notFound", async () => {
    installFlux(folderServer({}));
    expect((await rejects(resolve(`https://${HOST}/bFolder01`))).kind).toBe("notFound");
  });

  test("带提取码的文件夹：提取码进表单；缺失、错误分别 password", async () => {
    const pageUrl = `https://${HOST}/bFolder02`;
    const server = folderServer(
      { 1: { body: { zt: 1, text: rows(1, 2) } } },
      "folder-password.html",
      pageUrl,
    );
    const seen: string[] = [];
    const { requests } = installFlux((req) => {
      if (req.method === "POST") {
        const form = new URLSearchParams(req.body);
        seen.push(form.get("pwd") ?? "<无>");
        if (form.get("pwd") !== "c8wc") return { body: { zt: 3, info: "密码不正确", text: 0 } };
      }
      return server(req);
    });

    const ok = await resolve(`${pageUrl}?pwd=c8wc`);
    expect(ok.manifest!.items).toHaveLength(2);
    expect(Object.fromEntries(new URLSearchParams(requests.find((r) => r.method === "POST")!.body)).ls).toBe("1");
    expect(seen).toEqual(["c8wc"]);

    const wrong = await rejects(resolve(`${pageUrl}?pwd=nope`));
    expect(wrong.kind).toBe("password");

    const before = requests.length;
    const missing = await rejects(resolve(pageUrl));
    expect(missing.kind).toBe("password");
    expect(requests.length - before).toBe(1); // 只读了分享页，没有去试空提取码
  });

  test("会员文件夹含子文件夹 → unsupported（不静默丢文件）", async () => {
    const withSub = fixture("folder.html").replace('<div id="infos"></div>', '<div id="infos"><div class="mbx mbxfolder"><a href="/b0sub">子目录</a></div></div>');
    installFlux(() => ({ headers: HTML, body: withSub }));
    expect((await rejects(resolve(`https://${HOST}/bFolder01`))).kind).toBe("unsupported");
  });

  test("二段解析：条目 id 当单文件解析，任务 URL 不变，提取码只用于需要它的文件页", async () => {
    const file = (req: MockRequest): MockResponse => {
      if (req.url === `https://${HOST}/iFile000007`) return { headers: HTML, body: fixture("file-share.html") };
      if (req.url === `https://${HOST}/fn?FIXTURE_FN_TOKEN`) return { headers: HTML, body: fixture("file-inner.html") };
      if (req.url === "https://apifile.woozooo.com/ajaxfile.php?file=276372891") return okJson();
      if (req.url === DIRECT) return directHost(req);
      throw new Error(`未预期的请求 ${req.method} ${req.url}`);
    };
    const { requests } = installFlux(file);
    const res = await resolve(`https://${HOST}/bFolder01?pwd=c8wc`, "iFile000007");
    expectDirect(res, "Tampermonkey_5.4.1(需要启用开发者模式才可用).zip");
    expect(requests[0].url).toBe(`https://${HOST}/iFile000007`);
    expect(requests.some((r) => r.url.includes("bFolder01"))).toBe(false);
  });

  test("二段解析：条目 id 非法 → unsupported，不发请求", async () => {
    const { requests } = installFlux(() => ({ body: {} }));
    expect((await rejects(resolve(`https://${HOST}/bFolder01`, "../etc"))).kind).toBe("unsupported");
    expect(requests).toHaveLength(0);
  });
});
