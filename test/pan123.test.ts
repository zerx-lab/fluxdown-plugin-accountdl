import { describe, expect, test } from "bun:test";
import { SiteError } from "../src/core/errors";
import { parseUrl } from "../src/core/url";
import { checkToken, normalizeToken } from "../src/sites/pan123/jwt";
import { isShareHost, normalizePwd, parseShareTask, parseSharePage, shareTaskUrl, storedPwd } from "../src/sites/pan123/link";
import { pan123 } from "../src/sites/pan123";
import { signPath } from "../src/sites/pan123/sign";
import { futureExp, makeJwt } from "./fixtures/pan123/fake";
import { installFlux } from "./helpers";

const SHARE_PAGE = parseUrl("https://1.share.123pan.cn/123pan/abcd-efgh")!;

async function rejection(p: Promise<unknown>): Promise<SiteError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SiteError) return e;
    throw e;
  }
  throw new Error("预期抛出 SiteError");
}

describe("123 云盘 链接识别", () => {
  test("识别 /s/ /ps/ /123pan/ 三种分享路径、.html 后缀与 pwd 参数", () => {
    expect(parseSharePage("https://1.share.123pan.cn/123pan/abcd-efgh?pwd=Ab12")).toEqual({ host: "1.share.123pan.cn", key: "abcd-efgh", pwd: "Ab12" });
    expect(parseSharePage("https://www.123pan.com/s/abcd-efgh.html")).toEqual({ host: "www.123pan.com", key: "abcd-efgh", pwd: "" });
    expect(parseSharePage("https://www.123684.com/ps/ab12-cd34")?.key).toBe("ab12-cd34");
  });

  test("仿冒域名、缺少连字符的 key、非分享路径一律不识别", () => {
    expect(parseSharePage("https://123pan.com.evil.com/s/abcd-efgh")).toBeNull();
    expect(parseSharePage("https://evil123pan.com/s/abcd-efgh")).toBeNull();
    expect(parseSharePage("https://www.123pan.com/s/abcdefgh")).toBeNull();
    expect(parseSharePage("https://www.123pan.com/Notice/abcd-efgh")).toBeNull();
    expect(isShareHost("x.com.123pan.com.evil.com")).toBe(false);
    expect(isShareHost("123pan.com")).toBe(true);
    expect(isShareHost("uid.share.123pan.cn")).toBe(true);
  });

  test("提取码规整：去引号，拒绝带符号或超长的值", () => {
    expect(normalizePwd(' "Ab12" ')).toBe("Ab12");
    expect(normalizePwd("a&b=1")).toBe("");
    expect(normalizePwd("x".repeat(33))).toBe("");
    expect(storedPwd('"Ab12"')).toBe("Ab12");
    expect(storedPwd('{"value":"Ab12","timestamp":1}')).toBe("Ab12");
    expect(storedPwd("Ab12")).toBe("Ab12");
    expect(storedPwd("{坏")).toBe("");
  });
});

describe("123 云盘 任务 URL", () => {
  test("生成与解析往返，使用分享页自己的主机", () => {
    const url = shareTaskUrl("1.share.123pan.cn", "abcd-efgh", "Ab12");
    expect(url.startsWith("https://1.share.123pan.cn/__accountdl/pan123?")).toBe(true);
    expect(parseShareTask(parseUrl(url)!)).toEqual({ key: "abcd-efgh", pwd: "Ab12" });
    expect(parseShareTask(parseUrl(shareTaskUrl("www.123pan.com", "abcd-efgh", ""))!)).toEqual({ key: "abcd-efgh", pwd: "" });
  });

  test("参数里夹带 & # 中文或非法 key 时不认作有效任务", () => {
    const withPwd = (pwd: string) => parseShareTask(parseUrl(shareTaskUrl("www.123pan.com", "abcd-efgh", pwd))!);
    expect(withPwd("a&key=x-y")).toBeNull();
    expect(withPwd("a#b")).toBeNull();
    expect(withPwd("密码")).toBeNull();
    expect(parseShareTask(parseUrl(shareTaskUrl("www.123pan.com", "../x", ""))!)).toBeNull();
    expect(parseShareTask(parseUrl(shareTaskUrl("www.123pan.com", "abcdefgh", ""))!)).toBeNull();
  });

  test("claims：只认领本插件在分享域名上的任务 URL", () => {
    const claims = (url: string) => pan123.claims(parseUrl(url)!);
    expect(claims(shareTaskUrl("1.share.123pan.cn", "abcd-efgh", ""))).toBe(true);
    expect(claims("https://1.share.123pan.cn/123pan/abcd-efgh")).toBe(false);
    expect(claims("https://1.share.123pan.cn/__accountdl/quark?key=abcd-efgh")).toBe(false);
    expect(claims("https://pan.example.com/__accountdl/pan123?key=abcd-efgh")).toBe(false);
    expect(claims("https://123pan.com.evil.com/__accountdl/pan123?key=abcd-efgh")).toBe(false);
  });
});

describe("123 云盘 接口签名", () => {
  // 固定向量取自 ops `netdisk_test.go` 的 TestSignPathVectors（Go 实现）。
  test("与 Go 实现的固定向量一致", () => {
    expect(signPath("/b/api/share/get", 1792464000123, 4242424)).toEqual(["3216272866", "1792464000-4242424-2544535079"]);
  });

  test("UTC 18:00 在东八区已是次日 02:00，key 按东八区时间计算", () => {
    expect(signPath("/b/api/share/download/info", 1792432800000, 0)).toEqual(["3644428938", "1792432800-0-351779122"]);
  });
});

describe("123 云盘 登录令牌", () => {
  test("规整：去 JSON 引号与 Bearer 前缀", () => {
    expect(normalizeToken(' "Bearer abc.def.ghi" ')).toBe("abc.def.ghi");
    expect(normalizeToken("bearer   x.y.z")).toBe("x.y.z");
  });

  test("校验 JWT 形状与 exp：合格、过期、临近过期、形状错误", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(checkToken(makeJwt(now + 3600), now)).toMatchObject({ kind: "ok", exp: now + 3600 });
    expect(checkToken(`"${makeJwt(now + 3600)}"`, now).kind).toBe("ok");
    expect(checkToken(makeJwt(now - 10), now).kind).toBe("expired");
    expect(checkToken(makeJwt(now + 30), now).kind).toBe("expired");
    expect(checkToken("not-a-jwt", now).kind).toBe("shape");
    expect(checkToken("a.b", now).kind).toBe("shape");
    expect(checkToken("a$.b.c", now).kind).toBe("shape");
    const noExp = `${Buffer.from('{"alg":"x"}').toString("base64url")}.${Buffer.from('{"id":1}').toString("base64url")}.c2ln`;
    expect(checkToken(noExp, now).kind).toBe("shape");
  });
});

describe("123 云盘 令牌同步 RPC", () => {
  const sync = (args: unknown) => pan123.page!.rpc.syncToken!(args, SHARE_PAGE);

  test("只允许分享域名页面调用", () => {
    expect(pan123.page!.hosts).toContain("123pan.cn");
    expect(pan123.page!.hosts).not.toContain("example.com");
  });

  test("合法令牌落盘（令牌与过期时间），返回值不含令牌", async () => {
    const { storage } = installFlux(() => ({ body: {} }));
    const exp = futureExp();
    const token = makeJwt(exp);
    const result = await sync({ token: `"${token}"` });
    expect(result).toEqual({ loggedIn: true, expiresAt: exp });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.parse(storage["pan123.auth"]!)).toEqual({ token, exp });
  });

  test("参数类型不对、形状错误、超长一律拒绝且不改动已存令牌", async () => {
    const stored = JSON.stringify({ token: makeJwt(futureExp()), exp: futureExp() });
    const { storage } = installFlux(() => ({ body: {} }), {}, { "pan123.auth": stored });
    for (const args of [null, "x", { token: 1 }, { token: "garbage" }, { token: "a.b.c" }, { token: `${"a".repeat(9000)}` }, {}]) {
      const err = await rejection(sync(args));
      expect(err.kind).toBe("unsupported");
    }
    expect(storage["pan123.auth"]).toBe(stored);
  });

  test("令牌已过期：报 login 并清除旧令牌", async () => {
    const stored = JSON.stringify({ token: makeJwt(futureExp()), exp: futureExp() });
    const { storage } = installFlux(() => ({ body: {} }), {}, { "pan123.auth": stored });
    const err = await rejection(sync({ token: makeJwt(Math.floor(Date.now() / 1000) - 5) }));
    expect(err.kind).toBe("login");
    expect(storage["pan123.auth"]).toBe("");
  });

  test("空令牌表示网页已退出登录：清除已存令牌", async () => {
    const stored = JSON.stringify({ token: makeJwt(futureExp()), exp: futureExp() });
    const { storage } = installFlux(() => ({ body: {} }), {}, { "pan123.auth": stored });
    expect(await sync({ token: "  " })).toEqual({ loggedIn: false, expiresAt: 0 });
    expect(storage["pan123.auth"]).toBe("");
  });
});
