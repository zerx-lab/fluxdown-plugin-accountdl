import { describe, expect, test } from "bun:test";
import { SiteError } from "../src/core/errors";
import { parseUrl } from "../src/core/url";
import type { ResolveInput } from "../src/core/site";
import { artworkUrl, parseArtworkId } from "../src/sites/pixiv/link";
import { pixiv } from "../src/sites/pixiv";
import { header, installFlux, type MockResponse } from "./helpers";

const ID = "100000000";
const ORIG = (n: number) => `https://i.pximg.net/img-original/img/2022/07/26/02/35/50/${ID}_p${n}.${n === 1 ? "png" : "jpg"}`;

function input(url: string, over: Partial<ResolveInput> = {}): ResolveInput {
  return { taskId: "t", url, parsed: parseUrl(url)!, cookies: "", userAgent: "", referrer: "", resolverItem: "", ...over };
}

function api(opts: { type?: number; pages?: number; error?: boolean; status?: number } = {}) {
  const pages = opts.pages ?? 1;
  return (req: { url: string }): MockResponse => {
    if (opts.error) return { status: opts.status ?? 200, body: { error: true, message: "", body: [] } };
    if (req.url.endsWith("/ugoira_meta")) {
      return { body: { error: false, body: { src: "https://i.pximg.net/img-zip-ugoira/a_ugoira600x600.zip", originalSrc: "https://i.pximg.net/img-zip-ugoira/a_ugoira1920x1080.zip" } } };
    }
    if (req.url.endsWith("/pages")) {
      return { body: { error: false, body: Array.from({ length: pages }, (_, i) => ({ urls: { original: ORIG(i) } })) } };
    }
    return { body: { error: false, body: { illustTitle: "标题/测试", userName: "画师", illustType: opts.type ?? 0, pageCount: pages } } };
  };
}

describe("Pixiv 链接识别", () => {
  const id = (u: string) => parseArtworkId(parseUrl(u)!);
  test("识别作品页，含语言前缀与查询串", () => {
    expect(id(`https://www.pixiv.net/artworks/${ID}`)).toBe(ID);
    expect(id(`https://www.pixiv.net/en/artworks/${ID}`)).toBe(ID);
    expect(id(`https://www.pixiv.net/zh_tw/artworks/${ID}?x=1`)).toBe(ID);
    expect(pixiv.claims(parseUrl(`https://pixiv.net/artworks/${ID}/`)!)).toBe(true);
  });
  test("仿冒域名与非作品页不识别", () => {
    expect(id(`https://www.pixiv.net.evil.com/artworks/${ID}`)).toBeNull();
    expect(id(`https://evilpixiv.net/artworks/${ID}`)).toBeNull();
    expect(id(`https://www.pixiv.net/users/123`)).toBeNull();
    expect(id(`https://www.pixiv.net/artworks/abc`)).toBeNull();
    expect(id(`https://www.pixiv.net/novel/show.php?id=1`)).toBeNull();
    expect(artworkUrl(ID)).toBe(`https://www.pixiv.net/artworks/${ID}`);
  });
});

describe("Pixiv 解析", () => {
  test("单页：返回原图，请求带 Cookie 与 Referer，补丁清空 Cookie", async () => {
    const { requests } = installFlux(api());
    const r = await pixiv.resolve(input(`https://www.pixiv.net/en/artworks/${ID}`, { cookies: "PHPSESSID=abc", userAgent: "UA-X" }));
    expect(r).toEqual({
      url: ORIG(0),
      fileName: `${ID}_p0.jpg`,
      request: { cookies: "", referrer: "https://www.pixiv.net/", userAgent: "UA-X", fileName: `${ID}_p0.jpg` },
    });
    expect(requests.map((q) => q.url)).toEqual([
      `https://www.pixiv.net/ajax/illust/${ID}`,
      `https://www.pixiv.net/ajax/illust/${ID}/pages`,
    ]);
    expect(header(requests[0], "cookie")).toBe("PHPSESSID=abc");
    expect(header(requests[0], "referer")).toBe("https://www.pixiv.net/");
    expect(header(requests[0], "user-agent")).toBe("UA-X");
  });

  test("多页：清单放在「作者 - 标题」目录，二段按页序号解析", async () => {
    installFlux(api({ pages: 3 }));
    const r = await pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`));
    if (!("manifest" in r)) throw new Error("应返回清单");
    expect(r.manifest.name).toBe("画师 - 标题_测试");
    expect(r.manifest.items.map((i) => i.id)).toEqual(["0", "1", "2"]);
    expect(r.manifest.items[1]).toMatchObject({ name: `${ID}_p1.png`, path: "画师 - 标题_测试" });

    const { requests } = installFlux(api({ pages: 3 }));
    const one = await pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`, { resolverItem: "1" }));
    expect(one).toMatchObject({ url: ORIG(1), fileName: `${ID}_p1.png`, request: { cookies: "", referrer: "https://www.pixiv.net/" } });
    expect(requests).toHaveLength(1);
  });

  test("二段：越界或非法条目 id 报错", async () => {
    installFlux(api({ pages: 2 }));
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`, { resolverItem: "9" }))).rejects.toMatchObject({ kind: "notFound" });
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`, { resolverItem: "x" }))).rejects.toMatchObject({ kind: "unsupported" });
  });

  test("动图：返回原始尺寸 zip，补丁清空 Cookie", async () => {
    const { requests } = installFlux(api({ type: 2 }));
    const r = await pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`));
    expect(r).toMatchObject({
      url: "https://i.pximg.net/img-zip-ugoira/a_ugoira1920x1080.zip",
      fileName: `${ID}_ugoira.zip`,
      request: { cookies: "", referrer: "https://www.pixiv.net/" },
    });
    expect(requests[1].url).toBe(`https://www.pixiv.net/ajax/illust/${ID}/ugoira_meta`);
  });

  test("无 Cookie 被拒报 login，带 Cookie 被拒报 notFound", async () => {
    installFlux(api({ error: true, status: 404 }));
    const e1 = await pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`)).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(SiteError);
    expect((e1 as SiteError).kind).toBe("login");
    installFlux(api({ error: true }));
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`, { cookies: "PHPSESSID=a" }))).rejects.toMatchObject({ kind: "notFound" });
    installFlux(api({ error: true, status: 403 }));
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`))).rejects.toMatchObject({ kind: "login" });
  });

  test("限流与服务端错误映射", async () => {
    installFlux(() => ({ status: 429, body: "slow" }));
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`))).rejects.toMatchObject({ kind: "limit" });
    installFlux(() => ({ status: 502, body: "bad" }));
    await expect(pixiv.resolve(input(`https://www.pixiv.net/artworks/${ID}`))).rejects.toMatchObject({ kind: "network" });
  });
});
