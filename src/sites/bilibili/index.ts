// 哔哩哔哩：视频（BV / av，分 P）与番剧 / 影视（ep / ss）解析为 DASH 直链（视频流 + 音频流分离，由宿主下载后合并）。
// 账号：任务带浏览器 Cookie 时用用户的登录态（高画质、会员内容）；没有 Cookie 时匿名解析（匿名实测可到 1080P）。
// 任务 URL 就是真实页面 URL（`src/sites/bilibili/link.ts` 识别），用户直接在 FluxDown 里粘贴也可以。

import type { ResolveResult, ResolveVariant } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { manifestResult, MAX_ITEMS } from "../../core/manifest";
import { safeFileName } from "../../core/names";
import type { ResolveInput, Site } from "../../core/site";
import { parseUrl } from "../../core/url";
import { fetchPgcPlay, fetchSeason, fetchUgcPlay, fetchVideo, SITE, type Auth, type Episode } from "./api";
import { parseBilibiliLink, type BiliTarget } from "./link";
import {
  chooseAudio,
  chooseVideo,
  codecName,
  listVideoChoices,
  pickStreamUrl,
  qualityName,
  type AudioPref,
  type CodecPref,
  type Play,
  type QualityPref,
} from "./streams";

/** 直链下载必须带的 Referer：upos 主机不带返回 403（匿名实测 2026-10-22）。 */
const REFERER = "https://www.bilibili.com/";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** 宿主对 variants 的上限。 */
const MAX_VARIANTS = 50;

interface Prefs {
  quality: QualityPref;
  codec: CodecPref;
  audio: AudioPref;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

/** 读插件设置；缺省或非法值回退安全默认（最高画质的 SDR、AVC 优先、普通 AAC 音频）。 */
function readPrefs(): Prefs {
  const s = flux.settings;
  return {
    quality: oneOf(s["bilibiliQuality"], ["best", "ask", "2160", "1080", "720", "480", "360"], "best"),
    codec: oneOf(s["bilibiliCodec"], ["avc", "hevc", "av1"], "avc"),
    audio: oneOf(s["bilibiliAudio"], ["standard", "best"], "standard"),
  };
}

// ---------- 命名 ----------

function pageName(title: string, page: number, part: string, multi: boolean): string {
  if (!multi) return title || "哔哩哔哩视频";
  // 分 P 标题常把投稿标题整段重复一遍：去掉重复部分，只留 P 自己的区别。
  const own = (title ? part.split(title).join("") : part).trim();
  const suffix = own ? `P${page} ${own}` : `P${page}`;
  return title ? `${title} - ${suffix}` : suffix;
}

function episodeName(seasonTitle: string, ep: Episode): string {
  const label = /^\d+(\.\d+)?$/.test(ep.title) ? `第${ep.title}话` : ep.title;
  const long = ep.longTitle && ep.longTitle !== ep.title ? ep.longTitle : "";
  const tail = [label, long].filter((s) => s !== "").join(" ");
  return [seasonTitle, tail].filter((s) => s !== "").join(" - ") || "哔哩哔哩视频";
}

// ---------- 构造结果 ----------

/** 直链请求补丁：CDN 要 Referer，不要账号 Cookie（上游直链自带签名）。 */
function downloadPatch(auth: Auth) {
  return { cookies: "", referrer: REFERER, userAgent: auth.userAgent };
}

function variantLabel(v: { id: number; codec: "avc" | "hevc" | "av1"; bandwidth: number }): string {
  const rate = v.bandwidth > 0 ? ` · ${(v.bandwidth / 1_000_000).toFixed(1)} Mbps` : "";
  return `${qualityName(v.id)} · ${codecName(v.codec)}${rate}`;
}

function dashResult(play: Extract<Play, { kind: "dash" }>, name: string, prefs: Prefs, auth: Auth): ResolveResult {
  const fileName = safeFileName(`${name}.mp4`);
  const audio = chooseAudio(play.audios, prefs.audio);
  const audioUrl = audio ? pickStreamUrl(audio.urls) : undefined;
  const mainQuality = prefs.quality === "ask" ? "best" : prefs.quality;
  const video = chooseVideo(play.videos, mainQuality, prefs.codec);
  const result: ResolveResult = {
    url: pickStreamUrl(video.urls),
    ...(audioUrl ? { audioUrl } : {}),
    fileName,
    request: downloadPatch(auth),
  };
  if (prefs.quality !== "ask") return result;

  const choices = listVideoChoices(play.videos, prefs.codec).slice(0, MAX_VARIANTS);
  const variants: ResolveVariant[] = choices.map((v) => ({
    label: variantLabel(v),
    url: pickStreamUrl(v.urls),
    ...(audioUrl ? { audioUrl } : {}),
    fileName,
    bandwidth: Math.round(v.bandwidth),
    width: Math.round(v.width),
    height: Math.round(v.height),
    container: "mp4",
  }));
  const preferred = choices.findIndex((v) => v === video);
  return { ...result, variants, defaultVariantIndex: preferred >= 0 ? preferred : 0 };
}

/** 无 DASH 时的回退：单段直接下；多段 FLV 首段返回按段清单，二段按 `s<序号>` 取一段。 */
function durlResult(
  play: Extract<Play, { kind: "durl" }>,
  name: string,
  input: ResolveInput,
  auth: Auth,
  /** 分段清单只能在单任务的初段返回（清单的二段解析不能再返回清单）。 */
  canSplit: boolean,
): ResolveResult {
  const extOf = (url: string) => (/\.(mp4|flv)(?:$|\?)/i.exec(url)?.[1] ?? "mp4").toLowerCase();
  const segment = /^s(\d+)$/.exec(input.resolverItem);
  if (play.parts.length === 1 || segment) {
    const index = segment ? Number(segment[1]) - 1 : 0;
    const part = play.parts[index];
    if (!part) throw new SiteError(SITE, "获取视频流", `没有第 ${index + 1} 段（共 ${play.parts.length} 段）`, "notFound");
    const url = pickStreamUrl(part.urls);
    const label = play.parts.length > 1 ? ` - 片段${index + 1}` : "";
    return { url, fileName: safeFileName(`${name}${label}.${extOf(url)}`), request: downloadPatch(auth) };
  }
  if (!canSplit) {
    throw new SiteError(SITE, "获取视频流", "该内容只有分段 FLV 流，请单独打开它自己的页面下载", "unsupported");
  }
  return manifestResult(
    SITE,
    name,
    play.parts.map((part, i) => ({ id: `s${i + 1}`, name: `${name} - 片段${i + 1}.${extOf(part.urls[0])}`, size: part.size })),
  );
}

function playResult(play: Play, name: string, input: ResolveInput, auth: Auth, prefs: Prefs, canSplit: boolean): ResolveResult {
  return play.kind === "dash" ? dashResult(play, name, prefs, auth) : durlResult(play, name, input, auth, canSplit);
}

// ---------- 分发 ----------

async function resolveVideo(target: Extract<BiliTarget, { kind: "video" }>, input: ResolveInput, auth: Auth, prefs: Prefs): Promise<ResolveResult> {
  const info = await fetchVideo(target, auth);
  if (info.redirectUrl) {
    // 稿件其实是番剧 / 影视：站点给了正片页地址，按番剧解析。
    const redirected = parseUrl(info.redirectUrl);
    const next = redirected ? parseBilibiliLink(redirected) : null;
    if (next && next.kind !== "video") return resolveBangumi(next, input, auth, prefs);
    throw new SiteError(SITE, "获取视频信息", "该稿件不是普通视频，暂不支持", "unsupported");
  }
  const multi = info.pages.length > 1;
  const itemPage = /^p(\d+)$/.exec(input.resolverItem);
  const wanted = itemPage ? Number(itemPage[1]) : target.page;
  if (wanted === null && multi) {
    return manifestResult(
      SITE,
      info.title || "哔哩哔哩视频",
      info.pages.map((p) => ({ id: `p${p.page}`, name: `${pageName(info.title, p.page, p.part, true)}.mp4` })),
    );
  }
  const page = info.pages.find((p) => p.page === (wanted ?? 1));
  if (!page) throw new SiteError(SITE, "获取视频信息", `没有第 ${wanted} P（共 ${info.pages.length} P）`, "notFound");
  if (info.bvid === "") throw new SiteError(SITE, "获取视频信息", "返回缺少 BV 号（站点可能改版）", "network");
  const play = await fetchUgcPlay(info.bvid, page.cid, auth);
  return playResult(play, pageName(info.title, page.page, page.part, multi), input, auth, prefs, !itemPage);
}

async function resolveBangumi(
  target: Extract<BiliTarget, { kind: "episode" | "season" }>,
  input: ResolveInput,
  auth: Auth,
  prefs: Prefs,
): Promise<ResolveResult> {
  // 整季任务的二段解析：条目 id `e<ep 号>`，改按单集处理。
  const itemEp = target.kind === "season" ? /^e(\d{1,12})$/.exec(input.resolverItem) : null;
  const effective: Extract<BiliTarget, { kind: "episode" | "season" }> = itemEp ? { kind: "episode", id: itemEp[1] } : target;
  const season = await fetchSeason(effective, auth);
  if (effective.kind === "season") {
    if (season.episodes.length > MAX_ITEMS) {
      throw new SiteError(SITE, "获取番剧信息", `共 ${season.episodes.length} 集，超过单次 ${MAX_ITEMS} 集上限，请从网页打开具体剧集下载`, "limit");
    }
    return manifestResult(
      SITE,
      season.title || "哔哩哔哩番剧",
      season.episodes.map((ep) => ({ id: `e${ep.id}`, name: `${episodeName("", ep)}.mp4` })),
    );
  }
  const ep = season.episodes.find((e) => e.id === effective.id);
  if (!ep) throw new SiteError(SITE, "获取番剧信息", "没有找到这一集（可能已下架）", "notFound");
  const play = await fetchPgcPlay(ep.id, ep.cid, auth);
  return playResult(play, episodeName(season.title, ep), input, auth, prefs, !itemEp);
}

export const bilibili: Site = {
  id: "bilibili",
  name: SITE,
  claims: (url) => parseBilibiliLink(url) !== null,
  async resolve(input) {
    const target = parseBilibiliLink(input.parsed);
    if (!target) throw new SiteError(SITE, "识别链接", "不是受支持的哔哩哔哩视频或番剧链接", "unsupported");
    const auth: Auth = { cookies: input.cookies, userAgent: input.userAgent || DEFAULT_UA };
    const prefs = readPrefs();
    return target.kind === "video" ? resolveVideo(target, input, auth, prefs) : resolveBangumi(target, input, auth, prefs);
  },
};
