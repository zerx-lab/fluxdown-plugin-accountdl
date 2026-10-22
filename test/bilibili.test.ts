import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { SiteError } from "../src/core/errors";
import { parseQuery, parseUrl } from "../src/core/url";
import { bilibili } from "../src/sites/bilibili";
import { canonicalUrl, parseBilibiliLink } from "../src/sites/bilibili/link";
import {
  chooseAudio,
  chooseVideo,
  listVideoChoices,
  parsePlay,
  pickStreamUrl,
  type AudioStream,
  type VideoStream,
} from "../src/sites/bilibili/streams";
import { mixinKey, signWbi, wbiKeyFromUrl } from "../src/sites/bilibili/wbi";
import {
  BVID,
  CID,
  NAV_BODY,
  VOUCHER_BODY,
  dashBody,
  pgcPlay,
  seasonBody,
  ugcPlay,
  viewBody,
  type DashSpec,
} from "./fixtures/bilibili/responses";
import { header, installFlux, type MockRequest, type MockResponse } from "./helpers";

// ---------- 链接识别 ----------

function link(url: string) {
  const parsed = parseUrl(url);
  return parsed ? parseBilibiliLink(parsed) : null;
}

describe("哔哩哔哩链接识别", () => {
  test("BV / av / 分 P / 尾斜杠 / 移动端与裸域名", () => {
    expect(link("https://www.bilibili.com/video/BV1GJ411x7h7")).toEqual({ kind: "video", idKey: "bvid", id: "BV1GJ411x7h7", page: null });
    expect(link("https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&spm_id_from=333")).toEqual({ kind: "video", idKey: "bvid", id: "BV1GJ411x7h7", page: 3 });
    expect(link("https://www.bilibili.com/video/av80433022")).toEqual({ kind: "video", idKey: "aid", id: "80433022", page: null });
    expect(link("https://m.bilibili.com/video/AV80433022?p=2")).toEqual({ kind: "video", idKey: "aid", id: "80433022", page: 2 });
    expect(link("http://bilibili.com/video/bv1GJ411x7h7")).toEqual({ kind: "video", idKey: "bvid", id: "BV1GJ411x7h7", page: null });
  });

  test("p 参数非法（0、负数、非数字）视为未指定", () => {
    for (const p of ["0", "-1", "abc", "", "1.5"]) {
      expect(link(`https://www.bilibili.com/video/BV1GJ411x7h7?p=${p}`)).toMatchObject({ page: null });
    }
  });

  test("番剧 / 影视：单集 ep 与整季 ss", () => {
    expect(link("https://www.bilibili.com/bangumi/play/ep267851")).toEqual({ kind: "episode", id: "267851" });
    expect(link("https://www.bilibili.com/bangumi/play/ep267851?from_spmid=666")).toEqual({ kind: "episode", id: "267851" });
    expect(link("https://www.bilibili.com/bangumi/play/ss26801/")).toEqual({ kind: "season", id: "26801" });
  });

  test("仿冒域名与不支持的路径不认领", () => {
    for (const url of [
      "https://www.bilibili.com.evil.com/video/BV1GJ411x7h7",
      "https://evilbilibili.com/video/BV1GJ411x7h7",
      "https://bilibili.com.cn/video/BV1GJ411x7h7",
      "https://space.bilibili.com/video/BV1GJ411x7h7",
      "https://www.bilibili.com/video/BV1GJ411x7h7/extra",
      "https://www.bilibili.com/video/BV1GJ411",
      "https://www.bilibili.com/video/av",
      "https://www.bilibili.com/bangumi/play/",
      "https://www.bilibili.com/bangumi/media/md28229",
      "https://www.bilibili.com/read/cv123",
      "https://example.com/?u=https://www.bilibili.com/video/BV1GJ411x7h7",
    ]) {
      expect(link(url)).toBeNull();
    }
  });

  test("规范化 URL 往返：去掉跟踪参数，保留分 P", () => {
    const t = link("https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=1&p=4&vd_source=abc")!;
    expect(canonicalUrl(t)).toBe("https://www.bilibili.com/video/BV1GJ411x7h7?p=4");
    expect(canonicalUrl(t, 1)).toBe("https://www.bilibili.com/video/BV1GJ411x7h7?p=1");
    expect(canonicalUrl(link("https://www.bilibili.com/video/av80433022")!)).toBe("https://www.bilibili.com/video/av80433022");
    expect(canonicalUrl(link("https://www.bilibili.com/bangumi/play/ep267851?x=1")!)).toBe("https://www.bilibili.com/bangumi/play/ep267851");
    for (const t2 of [t, link("https://www.bilibili.com/bangumi/play/ss26801")!]) {
      expect(link(canonicalUrl(t2))).toEqual(t2);
    }
  });
});

// ---------- WBI ----------

describe("WBI 签名", () => {
  test("密钥取自 wbi_img 的文件名；形状不对为空", () => {
    expect(wbiKeyFromUrl("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png")).toBe("7cd084941338484aae1ad9425b84077c");
    expect(wbiKeyFromUrl("https://i0.hdslb.com/bfs/wbi/short.png")).toBe("");
    expect(wbiKeyFromUrl("")).toBe("");
  });

  test("混淆密钥为 32 位且取自两段密钥；密钥过短返回空", () => {
    const img = "7cd084941338484aae1ad9425b84077c";
    const sub = "4932caff0ff746eab6f01bf08b70ac45";
    const mixin = mixinKey(img, sub);
    expect(mixin).toHaveLength(32);
    for (const ch of mixin) expect(img + sub).toContain(ch);
    expect(mixinKey("abc", "def")).toBe("");
  });

  test("参数排序、剔除 !'()*、追加 wts，w_rid 为 md5(查询串 + 混淆密钥)", () => {
    const mixin = "ea1db124af3c7062474693fa704f4ff8";
    const query = signWbi({ zab: "1919810", foo: "a!b'c(d)e*f", bar: "中 文" }, mixin, 1684746387);
    const base = "bar=%E4%B8%AD%20%E6%96%87&foo=abcdef&wts=1684746387&zab=1919810";
    expect(query).toBe(`${base}&w_rid=${createHash("md5").update(base + mixin).digest("hex")}`);
  });
});

// ---------- 流选择 ----------

function vs(id: number, codec: VideoStream["codec"], bandwidth = 1000): VideoStream {
  return { id, codec, bandwidth, width: 0, height: 0, urls: [`https://upos-sz-x.bilivideo.com/${id}-${codec}.m4s`] };
}
function as(id: number, kind: AudioStream["kind"], bandwidth: number): AudioStream {
  return { id, kind, bandwidth, urls: [`https://upos-sz-x.bilivideo.com/a${id}.m4s`] };
}

describe("画质与编码选择", () => {
  const ladder = [112, 80, 64, 32, 16].flatMap((id) => [vs(id, "avc"), vs(id, "hevc"), vs(id, "av1")]);

  test("按偏好上限选不超过上限的最高画质，同档按编码偏好", () => {
    expect(chooseVideo(ladder, "best", "avc")).toMatchObject({ id: 112, codec: "avc" });
    expect(chooseVideo(ladder, "1080", "hevc")).toMatchObject({ id: 112, codec: "hevc" });
    expect(chooseVideo(ladder, "720", "av1")).toMatchObject({ id: 64, codec: "av1" });
    expect(chooseVideo(ladder, "480", "avc")).toMatchObject({ id: 32 });
    expect(chooseVideo(ladder, "360", "avc")).toMatchObject({ id: 16 });
  });

  test("偏好编码缺失时按兼容顺序回退", () => {
    const only = [vs(80, "hevc"), vs(80, "av1")];
    expect(chooseVideo(only, "best", "avc").codec).toBe("hevc");
    expect(chooseVideo([vs(80, "avc"), vs(80, "hevc")], "best", "av1").codec).toBe("hevc");
    expect(chooseVideo([vs(80, "avc"), vs(80, "av1")], "best", "hevc").codec).toBe("avc");
  });

  test("账号画质全部高于上限时取最低一档，而不是最高", () => {
    expect(chooseVideo([vs(80, "avc"), vs(64, "avc")], "360", "avc").id).toBe(64);
  });

  test("自动选择不挑 HDR / 杜比视界；高于 4K 才是 8K", () => {
    const withHdr = [vs(126, "hevc"), vs(125, "hevc"), vs(120, "hevc"), vs(80, "avc")];
    expect(chooseVideo(withHdr, "best", "avc").id).toBe(120);
    expect(chooseVideo([...withHdr, vs(127, "av1")], "best", "avc").id).toBe(127);
    expect(chooseVideo([...withHdr, vs(127, "av1")], "2160", "avc").id).toBe(120);
    // 只有 HDR 时仍能选出结果
    expect(chooseVideo([vs(126, "hevc"), vs(125, "hevc")], "best", "avc").id).toBe(125);
  });

  test("变体列表：清晰度高→低，HDR / 杜比视界也列出，同档按编码偏好", () => {
    const list = listVideoChoices([vs(80, "av1"), vs(80, "avc"), vs(126, "hevc"), vs(120, "hevc"), vs(64, "avc")], "avc");
    expect(list.map((v) => `${v.id}/${v.codec}`)).toEqual(["126/hevc", "120/hevc", "80/avc", "80/av1", "64/avc"]);
  });

  test("音频：standard 取码率最高的 AAC；best 依次 FLAC > 杜比 > AAC", () => {
    const all = [as(30216, "aac", 43962), as(30280, "aac", 203786), as(30232, "aac", 102931), as(30250, "dolby", 448000), as(30251, "flac", 900000)];
    expect(chooseAudio(all, "standard")?.id).toBe(30280);
    expect(chooseAudio(all, "best")?.id).toBe(30251);
    expect(chooseAudio(all.filter((a) => a.kind !== "flac"), "best")?.id).toBe(30250);
    expect(chooseAudio(all.filter((a) => a.kind === "aac"), "best")?.id).toBe(30280);
    expect(chooseAudio([], "best")).toBeNull();
  });

  test("直链优先标准 upos，避开 PCDN（mcdn / szbdyd / 裸 IP）", () => {
    const mcdn = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v1/a.m4s";
    const upos = "https://upos-sz-mirrorhw.bilivideo.com/a.m4s";
    expect(pickStreamUrl([mcdn, upos])).toBe(upos);
    expect(pickStreamUrl(["https://x.szbdyd.com/a.m4s", "https://1.2.3.4/a.m4s", upos])).toBe(upos);
    expect(pickStreamUrl([mcdn])).toBe(mcdn);
  });

  test("解析 playurl：同画质同编码保留码率最高、跳过无地址的流、备用地址 null 不报错", () => {
    const body = dashBody({ videos: [{ id: 80, codecid: 7, bandwidth: 5 }, { id: 80, codecid: 7, bandwidth: 9 }, { id: 64, codecid: 12 }], flac: true, dolby: true });
    const dash = body.dash as { video: Array<Record<string, unknown>> };
    dash.video.push({ id: 32, codecid: 7, baseUrl: "", backupUrl: null });
    dash.video.push({ id: 16, codecid: 7, baseUrl: "https://upos-sz-x.bilivideo.com/x.m4s", backupUrl: null, bandwidth: 1 });
    const play = parsePlay(body as never);
    expect(play?.kind).toBe("dash");
    if (play?.kind !== "dash") throw new Error("应为 dash");
    expect(play.videos.map((v) => `${v.id}/${v.codec}/${v.bandwidth}`).sort()).toEqual(["16/avc/1", "64/hevc/" + (1_000_000 + 64_000 + 12), "80/avc/9"].sort());
    expect(play.audios.map((a) => a.kind).sort()).toEqual(["aac", "aac", "aac", "dolby", "flac"]);
    expect(parsePlay({})).toBeNull();
  });
});

// ---------- resolver ----------

interface Routes {
  view?: () => MockResponse;
  season?: () => MockResponse;
  play?: (req: MockRequest) => MockResponse;
  pgc?: (req: MockRequest) => MockResponse;
  nav?: () => MockResponse;
  wbi?: (req: MockRequest) => MockResponse;
}

function router(routes: Routes) {
  return (req: MockRequest): MockResponse => {
    const u = parseUrl(req.url)!;
    const table: Record<string, ((r: MockRequest) => MockResponse) | undefined> = {
      "/x/web-interface/view": routes.view,
      "/pgc/view/web/season": routes.season,
      "/x/player/playurl": routes.play,
      "/pgc/player/web/playurl": routes.pgc,
      "/x/web-interface/nav": routes.nav,
      "/x/player/wbi/playurl": routes.wbi,
    };
    const h = table[u.path];
    if (!h) throw new Error(`未预期的请求 ${u.path}`);
    return h(req);
  };
}

interface RunOpts {
  cookies?: string;
  userAgent?: string;
  item?: string;
  settings?: Record<string, string | number | boolean | null>;
}

async function run(url: string, routes: Routes, opts: RunOpts = {}) {
  const { requests } = installFlux(router(routes), opts.settings ?? {});
  const parsed = parseUrl(url)!;
  try {
    const res = await bilibili.resolve({
      taskId: "t1",
      url,
      parsed,
      cookies: opts.cookies ?? "",
      userAgent: opts.userAgent ?? "",
      referrer: "",
      resolverItem: opts.item ?? "",
    });
    return { res, requests };
  } catch (e) {
    return { err: e as SiteError, requests };
  }
}

async function ok(url: string, routes: Routes, opts: RunOpts = {}) {
  const r = await run(url, routes, opts);
  if (r.err) throw r.err;
  return { res: r.res!, requests: r.requests };
}

async function fail(url: string, routes: Routes, opts: RunOpts = {}) {
  const r = await run(url, routes, opts);
  if (!r.err) throw new Error("应当失败");
  return r.err;
}

const ONE_PAGE = [{ page: 1, cid: CID, part: "" }];
const FULL: DashSpec = { videos: [80, 64, 32].flatMap((id) => ([7, 12, 13] as const).map((codecid) => ({ id, codecid }))) };
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0 Safari/537.36";

function q(req: MockRequest) {
  return parseQuery(parseUrl(req.url)!.query);
}

describe("单个视频解析", () => {
  test("DASH：视频流 + 音频流取标准 upos 直链，文件名带标题，补丁显式清空 Cookie 并带 Referer 与 UA", async () => {
    const { res, requests } = await ok(VIDEO_URL, { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay(FULL) }) }, { cookies: "SESSDATA=s; buvid3=b", userAgent: BROWSER_UA });
    expect(res.url).toContain("upos-sz-mirrorhwo1.bilivideo.com");
    expect(res.url).toContain(`_80_7`); // 1080P + AVC（默认偏好）
    expect(res.audioUrl).toContain("upos-sz-mirrorcoso1.bilivideo.com");
    expect(res.audioUrl).toContain("30280");
    expect(res.fileName).toBe("【官方 MV】Never Gonna Give You Up.mp4");
    expect(res.request).toEqual({ cookies: "", referrer: "https://www.bilibili.com/", userAgent: BROWSER_UA });
    expect(res.manifest).toBeUndefined();

    // API 请求带账号 Cookie 与 UA，且不带 Referer / Origin（带了会被站点 412 风控）
    expect(requests.map((r) => parseUrl(r.url)!.path)).toEqual(["/x/web-interface/view", "/x/player/playurl"]);
    for (const r of requests) {
      expect(header(r, "cookie")).toBe("SESSDATA=s; buvid3=b");
      expect(header(r, "user-agent")).toBe(BROWSER_UA);
      expect(header(r, "referer")).toBeUndefined();
      expect(header(r, "origin")).toBeUndefined();
    }
    expect(q(requests[0])).toEqual({ bvid: BVID });
    expect(q(requests[1])).toMatchObject({ bvid: BVID, cid: CID, fnval: "4048", fourk: "1", qn: "127" });
  });

  test("匿名：不带 Cookie 头、补 try_look、任务 UA 为空时用默认浏览器 UA；登录账号不加 try_look", async () => {
    const routes = { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay(FULL) }) };
    const anon = await ok(VIDEO_URL, routes);
    expect(header(anon.requests[0], "cookie")).toBeUndefined();
    expect(q(anon.requests[1])["try_look"]).toBe("1");
    expect(anon.res.request?.userAgent).toContain("Mozilla/5.0");
    expect(anon.res.request?.cookies).toBe("");
    expect(header(anon.requests[0], "user-agent")).toBe(anon.res.request?.userAgent);

    const logged = await ok(VIDEO_URL, routes, { cookies: "SESSDATA=s" });
    expect(q(logged.requests[1])["try_look"]).toBeUndefined();
  });

  test("av 号用 aid 参数请求，BV 号由 view 返回", async () => {
    const { requests, res } = await ok("https://www.bilibili.com/video/av80433022", { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay(FULL) }) });
    expect(q(requests[0])).toEqual({ aid: "80433022" });
    expect(q(requests[1])["bvid"]).toBe(BVID);
    expect(res.url).toBeTruthy();
  });

  test("单 P 视频即使 URL 没带 p 也直接返回单文件", async () => {
    const { res } = await ok(VIDEO_URL, { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay(FULL) }) });
    expect(res.url).toBeTruthy();
    expect(res.manifest).toBeUndefined();
  });

  test("没有音频流时不返回 audioUrl", async () => {
    const { res } = await ok(VIDEO_URL, { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay({ ...FULL, audios: [] }) }) });
    expect(res.audioUrl).toBeUndefined();
    expect(res.url).toBeTruthy();
  });
});

describe("多 P 视频", () => {
  const PAGES = [
    { page: 1, cid: "1001", part: "开场" },
    { page: 2, cid: "1002", part: "【官方 MV】Never Gonna Give You Up 第二部分" },
    { page: 3, cid: "1003", part: "" },
  ];
  const routes = (seen: string[] = []): Routes => ({
    view: () => ({ body: viewBody(PAGES) }),
    play: (req) => {
      seen.push(q(req)["cid"]);
      return { body: ugcPlay(FULL) };
    },
  });

  test("URL 没指定 p：每 P 一项的清单，只请求 view；分 P 标题里重复的投稿标题被去掉", async () => {
    const { res, requests } = await ok(VIDEO_URL, routes());
    expect(requests).toHaveLength(1);
    expect(res.manifest?.name).toBe("【官方 MV】Never Gonna Give You Up");
    expect(res.manifest?.items.map((i) => i.id)).toEqual(["p1", "p2", "p3"]);
    expect(res.manifest?.items.map((i) => i.name)).toEqual([
      "【官方 MV】Never Gonna Give You Up - P1 开场.mp4",
      "【官方 MV】Never Gonna Give You Up - P2 第二部分.mp4",
      "【官方 MV】Never Gonna Give You Up - P3.mp4",
    ]);
  });

  test("URL 指定 ?p=2：直接解析该 P（用该 P 的 cid），文件名带 P 序号", async () => {
    const seen: string[] = [];
    const { res } = await ok(`${VIDEO_URL}?p=2`, routes(seen));
    expect(seen).toEqual(["1002"]);
    expect(res.fileName).toBe("【官方 MV】Never Gonna Give You Up - P2 第二部分.mp4");
  });

  test("清单二段解析：条目 id p3 → 第 3 P 的直链，任务 URL 不变", async () => {
    const seen: string[] = [];
    const { res } = await ok(VIDEO_URL, routes(seen), { item: "p3" });
    expect(seen).toEqual(["1003"]);
    expect(res.manifest).toBeUndefined();
    expect(res.request?.cookies).toBe("");
  });

  test("p 超出范围报 notFound", async () => {
    const err = await fail(`${VIDEO_URL}?p=9`, routes());
    expect(err.kind).toBe("notFound");
    expect(err.message).toContain("共 3 P");
  });
});

describe("画质、编码与音频设置", () => {
  const routes = (spec: DashSpec = FULL): Routes => ({ view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: ugcPlay(spec) }) });

  test("quality=720 取 720P；codec=hevc 取 HEVC 流", async () => {
    const { res } = await ok(VIDEO_URL, routes(), { settings: { bilibiliQuality: "720", bilibiliCodec: "hevc" } });
    expect(res.url).toContain("_64_12");
  });

  test("缺省与非法设置值回退安全默认（最高 SDR 画质 + AVC + 普通音频）", async () => {
    for (const settings of [{}, { bilibiliQuality: "ultra", bilibiliCodec: 7, bilibiliAudio: null }]) {
      const { res } = await ok(VIDEO_URL, routes({ ...FULL, flac: true }), { settings });
      expect(res.url).toContain("_80_7");
      expect(res.audioUrl).toContain("30280");
      expect(res.variants).toBeUndefined();
    }
  });

  test("audio=best 取 Hi-Res FLAC，没有 FLAC 时取杜比，standard 始终取 AAC", async () => {
    const best = { settings: { bilibiliAudio: "best" } };
    expect((await ok(VIDEO_URL, routes({ ...FULL, flac: true, dolby: true }), best)).res.audioUrl).toContain("30251");
    expect((await ok(VIDEO_URL, routes({ ...FULL, dolby: true }), best)).res.audioUrl).toContain("30250");
    expect((await ok(VIDEO_URL, routes({ ...FULL, flac: true, dolby: true }))).res.audioUrl).toContain("30280");
  });

  test("quality=ask：返回变体列表（含 HDR / 杜比视界），默认项是自动选择的那条", async () => {
    const spec: DashSpec = { videos: [{ id: 126, codecid: 12 }, { id: 120, codecid: 12 }, { id: 80, codecid: 7 }, { id: 80, codecid: 12 }, { id: 64, codecid: 7 }] };
    const { res } = await ok(VIDEO_URL, routes(spec), { settings: { bilibiliQuality: "ask" } });
    expect(res.variants?.map((v) => v.label.split(" · ").slice(0, 2).join(" · "))).toEqual([
      "杜比视界 · HEVC",
      "4K 超清 · HEVC",
      "1080P 高清 · AVC",
      "1080P 高清 · HEVC",
      "720P 高清 · AVC",
    ]);
    // 自动选择 = 不含 HDR / 杜比视界的最高档 4K
    expect(res.defaultVariantIndex).toBe(1);
    expect(res.url).toBe(res.variants![1].url);
    for (const v of res.variants!) {
      expect(v.audioUrl).toBe(res.audioUrl);
      expect(Number.isInteger(v.bandwidth) && Number.isInteger(v.width) && Number.isInteger(v.height)).toBe(true);
    }
    expect(res.request?.cookies).toBe("");
  });
});

describe("无 DASH 时回退 durl", () => {
  const SEG = (n: number) => `https://upos-sz-estgcos.bilivideo.com/upgcxcode/36/27/${CID}/${CID}-${n}-32.flv?e=x`;
  const durlRoutes = (parts: number): Routes => ({
    view: () => ({ body: viewBody(ONE_PAGE) }),
    play: () => ({ body: ugcPlay({ durl: Array.from({ length: parts }, (_, i) => ({ url: SEG(i + 1), size: 1000 * (i + 1) })) }) }),
  });

  test("单段：返回该段直链，扩展名取自链接，补丁完整", async () => {
    const { res } = await ok(VIDEO_URL, durlRoutes(1));
    expect(res.url).toBe(SEG(1));
    expect(res.audioUrl).toBeUndefined();
    expect(res.fileName).toBe("【官方 MV】Never Gonna Give You Up.flv");
    expect(res.request).toMatchObject({ cookies: "", referrer: "https://www.bilibili.com/" });
  });

  test("多段 FLV：初段返回按段清单（带大小），二段 s2 取第 2 段", async () => {
    const first = await ok(VIDEO_URL, durlRoutes(3));
    expect(first.res.manifest?.items.map((i) => [i.id, i.size])).toEqual([["s1", 1000], ["s2", 2000], ["s3", 3000]]);
    expect(first.res.manifest?.items[1].name).toBe("【官方 MV】Never Gonna Give You Up - 片段2.flv");
    const second = await ok(VIDEO_URL, durlRoutes(3), { item: "s2" });
    expect(second.res.url).toBe(SEG(2));
    expect(second.res.fileName).toBe("【官方 MV】Never Gonna Give You Up - 片段2.flv");
  });

  test("多 P 清单的二段解析遇到多段 FLV：清单不能再嵌套，明确报 unsupported", async () => {
    const pages = [{ page: 1, cid: "1", part: "a" }, { page: 2, cid: "2", part: "b" }];
    const err = await fail(VIDEO_URL, { view: () => ({ body: viewBody(pages) }), play: () => ugcDurl(2) }, { item: "p2" });
    expect(err.kind).toBe("unsupported");
  });

  function ugcDurl(n: number): MockResponse {
    return { body: ugcPlay({ durl: Array.from({ length: n }, (_, i) => ({ url: SEG(i + 1), size: 1 })) }) };
  }

  test("响应既无 dash 也无 durl 时报 network", async () => {
    const err = await fail(VIDEO_URL, { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: { code: 0, message: "OK", data: { quality: 64 } } }) });
    expect(err.kind).toBe("network");
  });
});

describe("风控与 WBI 回退", () => {
  test("未签名 playurl 返回风控凭证 → 取 nav 密钥，用 WBI 签名重试成功", async () => {
    let signed = "";
    const { res, requests } = await ok(VIDEO_URL, {
      view: () => ({ body: viewBody(ONE_PAGE) }),
      play: () => ({ body: VOUCHER_BODY }),
      nav: () => ({ body: NAV_BODY }),
      wbi: (req) => {
        signed = parseUrl(req.url)!.query;
        return { body: ugcPlay(FULL) };
      },
    });
    expect(res.url).toContain("upos-sz-mirrorhwo1");
    expect(requests.map((r) => parseUrl(r.url)!.path)).toEqual(["/x/web-interface/view", "/x/player/playurl", "/x/web-interface/nav", "/x/player/wbi/playurl"]);
    const params = parseQuery(signed);
    expect(params["bvid"]).toBe(BVID);
    expect(params["wts"]).toMatch(/^\d{10}$/);
    // w_rid 能用 nav 里的密钥复算
    const mixin = mixinKey("7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45");
    const body = signed.slice(0, signed.lastIndexOf("&w_rid="));
    expect(params["w_rid"]).toBe(createHash("md5").update(body + mixin).digest("hex"));
    expect(Object.keys(parseQuery(body))).toEqual(Object.keys(parseQuery(body)).slice().sort());
  });

  test("HTTP 412 的 playurl 同样走 WBI 回退", async () => {
    const { res } = await ok(VIDEO_URL, {
      view: () => ({ body: viewBody(ONE_PAGE) }),
      play: () => ({ status: 412, headers: {}, body: "<html>412</html>" }),
      nav: () => ({ body: NAV_BODY }),
      wbi: () => ({ body: ugcPlay(FULL) }),
    });
    expect(res.url).toBeTruthy();
  });

  test("WBI 重试仍被风控：limit 错误；nav 没有密钥：network 错误", async () => {
    const base = { view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body: VOUCHER_BODY }) };
    const stillBlocked = await fail(VIDEO_URL, { ...base, nav: () => ({ body: NAV_BODY }), wbi: () => ({ body: VOUCHER_BODY }) });
    expect(stillBlocked.kind).toBe("limit");
    expect(stillBlocked.message).not.toContain("voucher_");
    const noKeys = await fail(VIDEO_URL, { ...base, nav: () => ({ body: { code: -101, data: {} } }) });
    expect(noKeys.kind).toBe("network");
  });

  test("view 返回 HTTP 412 或 -352：limit（风控）", async () => {
    expect((await fail(VIDEO_URL, { view: () => ({ status: 412, headers: {}, body: "<html></html>" }) })).kind).toBe("limit");
    expect((await fail(VIDEO_URL, { view: () => ({ body: { code: -352, message: "风控校验失败" } }) })).kind).toBe("limit");
  });
});

describe("错误码映射", () => {
  const withView = (body: unknown): Routes => ({ view: () => ({ body }) });
  const withPlay = (body: unknown): Routes => ({ view: () => ({ body: viewBody(ONE_PAGE) }), play: () => ({ body }) });

  test("view：-404 / 62002 / 62004 → notFound；62012 → limit；-400 → other", async () => {
    for (const code of [-404, 62002, 62004]) {
      expect((await fail(VIDEO_URL, withView({ code, message: "啥都木有" }))).kind).toBe("notFound");
    }
    expect((await fail(VIDEO_URL, withView({ code: 62012, message: "仅 UP 主自己可见" }))).kind).toBe("limit");
    expect((await fail(VIDEO_URL, withView({ code: -400, message: "请求错误" }))).kind).toBe("other");
  });

  test("-403：未带登录 Cookie 提示登录，已登录则是无权限", async () => {
    expect((await fail(VIDEO_URL, withView({ code: -403, message: "权限不足" }))).kind).toBe("login");
    expect((await fail(VIDEO_URL, withView({ code: -403, message: "权限不足" }), { cookies: "SESSDATA=s" })).kind).toBe("limit");
  });

  test("playurl：-101 → login；-404 → notFound；-10403 → limit", async () => {
    expect((await fail(VIDEO_URL, withPlay({ code: -101, message: "账号未登录" }))).kind).toBe("login");
    expect((await fail(VIDEO_URL, withPlay({ code: -404, message: "啥都木有" }))).kind).toBe("notFound");
    expect((await fail(VIDEO_URL, withPlay({ code: -10403, message: "" }))).kind).toBe("limit");
  });

  test("地区限制与需大会员按消息归为 limit 并给出原因", async () => {
    const region = await fail(VIDEO_URL, withPlay({ code: -10403, message: "抱歉您所在地区不可观看！" }));
    expect(region.kind).toBe("limit");
    expect(region.detail).toContain("地区");
    const vip = await fail(VIDEO_URL, withPlay({ code: -10403, message: "大会员专享" }));
    expect(vip.kind).toBe("limit");
    expect(vip.detail).toContain("大会员");
  });

  test("试看片段：匿名 → login，已登录 → limit，都不当成完整内容下载", async () => {
    const preview = { code: 0, message: "OK", data: { ...dashBody(FULL), is_preview: 1 } };
    expect((await fail(VIDEO_URL, withPlay(preview))).kind).toBe("login");
    expect((await fail(VIDEO_URL, withPlay(preview), { cookies: "SESSDATA=s" })).kind).toBe("limit");
  });

  test("错误消息不含 Cookie 与带签名的直链", async () => {
    const err = await fail(VIDEO_URL, withPlay({ code: -10403, message: "地区" }), { cookies: "SESSDATA=secret-token" });
    expect(err.message).not.toContain("secret-token");
    expect(err.message).not.toContain("deadline");
  });

  test("传输失败 / 非 JSON：network", async () => {
    expect((await fail(VIDEO_URL, { view: () => ({ status: 500, body: "oops" }) })).kind).toBe("network");
    expect((await fail(VIDEO_URL, { view: () => ({ body: "<html>维护中</html>" }) })).kind).toBe("network");
  });
});

describe("番剧 / 影视", () => {
  const EPISODES = [
    { id: 267851, cid: 125463156, title: "1", long_title: "残酷" },
    { id: 267852, cid: 125463157, title: "2", long_title: "培育师鳞泷左近次" },
    { id: 267900, cid: 125463200, title: "正片", long_title: "" },
  ];
  const routes = (seen: string[] = [], pgc: DashSpec | { durl: Array<{ url: string; size: number }> } = FULL): Routes => ({
    season: () => ({ body: seasonBody(EPISODES) }),
    pgc: (req) => {
      seen.push(`${q(req)["ep_id"]}/${q(req)["cid"]}`);
      return { body: pgcPlay(pgc) };
    },
  });

  test("单集 ep：按 ep 号取 cid，用 pgc 接口，文件名为「番名 - 第N话 标题」，补丁完整", async () => {
    const seen: string[] = [];
    const { res, requests } = await ok("https://www.bilibili.com/bangumi/play/ep267852", routes(seen), { cookies: "SESSDATA=vip" });
    expect(requests.map((r) => parseUrl(r.url)!.path)).toEqual(["/pgc/view/web/season", "/pgc/player/web/playurl"]);
    expect(q(requests[0])).toEqual({ ep_id: "267852" });
    expect(seen).toEqual(["267852/125463157"]);
    expect(q(requests[1])).toMatchObject({ fnval: "4048", qn: "127" });
    expect(header(requests[1], "cookie")).toBe("SESSDATA=vip");
    expect(res.fileName).toBe("鬼灭之刃 - 第2话 培育师鳞泷左近次.mp4");
    expect(res.audioUrl).toBeTruthy();
    expect(res.request).toMatchObject({ cookies: "", referrer: "https://www.bilibili.com/" });
  });

  test("非数字集标题（正片）不加「第 话」", async () => {
    const { res } = await ok("https://www.bilibili.com/bangumi/play/ep267900", routes());
    expect(res.fileName).toBe("鬼灭之刃 - 正片.mp4");
  });

  test("整季 ss：每集一项的清单；二段 e<ep 号> 解析该集", async () => {
    const first = await ok("https://www.bilibili.com/bangumi/play/ss26801", routes());
    expect(first.requests).toHaveLength(1);
    expect(q(first.requests[0])).toEqual({ season_id: "26801" });
    expect(first.res.manifest?.name).toBe("鬼灭之刃");
    expect(first.res.manifest?.items.map((i) => [i.id, i.name])).toEqual([
      ["e267851", "第1话 残酷.mp4"],
      ["e267852", "第2话 培育师鳞泷左近次.mp4"],
      ["e267900", "正片.mp4"],
    ]);

    const seen: string[] = [];
    const second = await ok("https://www.bilibili.com/bangumi/play/ss26801", routes(seen), { item: "e267852" });
    expect(seen).toEqual(["267852/125463157"]);
    expect(second.res.fileName).toBe("鬼灭之刃 - 第2话 培育师鳞泷左近次.mp4");
  });

  test("整季超过 1000 集：明确提示从网页打开具体剧集", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: 1000 + i, cid: i + 1, title: String(i + 1), long_title: "" }));
    const err = await fail("https://www.bilibili.com/bangumi/play/ss33378", { season: () => ({ body: seasonBody(many, "名侦探柯南") }) });
    expect(err.kind).toBe("limit");
    expect(err.message).toContain("1001");
  });

  test("ep 不在该季返回的剧集里：notFound；season 接口 -404：notFound", async () => {
    expect((await fail("https://www.bilibili.com/bangumi/play/ep1", routes())).kind).toBe("notFound");
    const err = await fail("https://www.bilibili.com/bangumi/play/ep1", { season: () => ({ body: { code: -404, message: "啥都木有" } }) });
    expect(err.kind).toBe("notFound");
  });

  test("番剧试看（需大会员）与 -10403：不当成完整内容下载", async () => {
    const preview = { ...routes(), pgc: () => ({ body: pgcPlay(FULL, { is_preview: 1 }) }) };
    expect((await fail("https://www.bilibili.com/bangumi/play/ep267851", preview)).kind).toBe("login");
    expect((await fail("https://www.bilibili.com/bangumi/play/ep267851", preview, { cookies: "SESSDATA=s" })).kind).toBe("limit");
    const blocked = { ...routes(), pgc: () => ({ body: { code: -10403, message: "抱歉您所在地区不可观看！" } }) };
    expect((await fail("https://www.bilibili.com/bangumi/play/ep267851", blocked)).kind).toBe("limit");
  });

  test("番剧老片只有分段 FLV：单集初段给分段清单，二段 s<N> 取该段", async () => {
    const durl = { durl: [{ url: "https://upos-sz-estgcos.bilivideo.com/a-1.flv?e=x", size: 11 }, { url: "https://upos-sz-estgcos.bilivideo.com/a-2.flv?e=x", size: 22 }] };
    const first = await ok("https://www.bilibili.com/bangumi/play/ep267851", routes([], durl));
    expect(first.res.manifest?.items.map((i) => i.id)).toEqual(["s1", "s2"]);
    const second = await ok("https://www.bilibili.com/bangumi/play/ep267851", routes([], durl), { item: "s2" });
    expect(second.res.url).toContain("a-2.flv");
  });

  test("普通 BV 其实是番剧：view 返回 redirect_url 时按番剧解析", async () => {
    const seen: string[] = [];
    const { res } = await ok(VIDEO_URL, {
      ...routes(seen),
      view: () => ({ body: viewBody([], "鬼灭之刃", { redirect_url: "https://www.bilibili.com/bangumi/play/ep267851" }) }),
    });
    expect(seen).toEqual(["267851/125463156"]);
    expect(res.fileName).toBe("鬼灭之刃 - 第1话 残酷.mp4");
  });

  test("redirect_url 不是番剧页：unsupported", async () => {
    const err = await fail(VIDEO_URL, { view: () => ({ body: viewBody([], "x", { redirect_url: "https://www.bilibili.com/cheese/play/ep1" }) }) });
    expect(err.kind).toBe("unsupported");
  });
});

describe("认领", () => {
  test("claims 只认领受支持的页面", () => {
    expect(bilibili.claims(parseUrl("https://www.bilibili.com/video/BV1GJ411x7h7")!)).toBe(true);
    expect(bilibili.claims(parseUrl("https://www.bilibili.com/bangumi/play/ep1")!)).toBe(true);
    expect(bilibili.claims(parseUrl("https://www.bilibili.com.evil.com/video/BV1GJ411x7h7")!)).toBe(false);
    expect(bilibili.claims(parseUrl("https://www.bilibili.com/")!)).toBe(false);
  });

  test("清单条目 id 在宿主上限内", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({ page: i + 1, cid: String(i + 1), part: `第${i + 1}节` }));
    const { res } = await ok(VIDEO_URL, { view: () => ({ body: viewBody(pages) }) });
    expect(res.manifest?.items).toHaveLength(30);
    for (const item of res.manifest!.items) expect(item.id.length).toBeLessThanOrEqual(200);
  });
});

