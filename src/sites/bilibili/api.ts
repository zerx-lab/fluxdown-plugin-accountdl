// 哔哩哔哩 API 请求与错误码映射。接口与错误码来源：SocialSisterYi/bilibili-API-collect，匿名实测 2026-10-22。
//
// 关于请求头（匿名实测）：api.bilibili.com 对带 `Referer: https://www.bilibili.com/` 的 view 请求、对带视频页 Referer 的
// wbi playurl 请求返回 HTTP 412（HTML 风控页），不带 Referer 一律正常，所以 API 请求不发 Referer / Origin。
// 直链（CDN）则相反：upos 主机不带 Referer 返回 403，见 index.ts 的下载补丁。

import { parseCookies } from "../../core/cookies";
import { SiteError, type ErrorKind } from "../../core/errors";
import { parseJsonObject, request } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { type BiliTarget } from "./link";
import { parsePlay, type Play } from "./streams";
import { mixinKey, signWbi, wbiKeyFromUrl } from "./wbi";

export const SITE = "哔哩哔哩";
const API = "https://api.bilibili.com";

export interface Auth {
  cookies: string;
  userAgent: string;
}

/** 响应信封。`risk` = HTTP 412 / 风控码 / 风控凭证（v_voucher）：换签名方式重试或提示用户。 */
interface Envelope {
  code: number;
  message: string;
  data: JsonObject | null;
  risk: boolean;
}

export function hasSession(cookies: string): boolean {
  return parseCookies(cookies).has("SESSDATA");
}

async function get(stage: string, path: string, query: string, auth: Auth): Promise<Envelope> {
  const res = await request(SITE, stage, { url: `${API}${path}?${query}`, cookies: auth.cookies, userAgent: auth.userAgent });
  if (res.status === 412 || res.status === 429) return { code: -412, message: "", data: null, risk: true };
  if (res.status < 200 || res.status >= 300) throw new SiteError(SITE, stage, `HTTP ${res.status}`, "network");
  const body = parseJsonObject(SITE, stage, res.body);
  const code = asNumber(body["code"]);
  if (code === null) throw new SiteError(SITE, stage, "返回缺少 code 字段（站点可能改版）", "network");
  // 普通接口的负载在 data，番剧（pgc）接口在 result。
  const data = asObject(body["data"]) ?? asObject(body["result"]);
  const voucher = data !== null && asString(data["v_voucher"]) !== "";
  return { code, message: asString(body["message"]) || asString(body["msg"]), data, risk: voucher || code === -352 || code === -412 };
}

const RISK_DETAIL = "被站点风控拦截（请在浏览器里正常打开该视频页并通过验证后重试，或稍后再试）";

/** 站点错误码 → 带类别的错误。`session` 为任务是否带了登录 Cookie（决定 -403 是「要登录」还是「无权限」）。 */
export function mapCode(stage: string, code: number, message: string, session: boolean): SiteError {
  const text = message ? `${message}（${code}）` : `接口返回 ${code}`;
  const fail = (kind: ErrorKind, detail: string) => new SiteError(SITE, stage, detail, kind);
  if (/大会员|会员专享|付费|购买|充电/.test(message)) return fail("limit", `需要大会员、付费或充电后才能观看：${text}`);
  if (/地区|区域/.test(message)) return fail("limit", `所在地区不可观看：${text}`);
  switch (code) {
    case -101:
      return fail("login", "未登录或登录已失效，请先在浏览器里登录哔哩哔哩，再从网页按钮发起下载");
    case -404:
    case 62002:
    case 62004:
    case 62003:
      return fail("notFound", `视频不存在、已删除或不可见：${text}`);
    case 62012:
      return fail("limit", `仅 UP 主自己可见：${text}`);
    case -403:
      return session ? fail("limit", `账号无权观看：${text}`) : fail("login", `需要登录后观看：${text}`);
    case -10403:
      return fail("limit", `无权观看（可能需要大会员或所在地区受限）：${text}`);
    case -352:
    case -412:
    case -799:
      return fail("limit", RISK_DETAIL);
    case -400:
      return fail("other", `请求参数错误：${text}`);
    default:
      return fail("other", text);
  }
}

function requireOk(stage: string, env: Envelope, session: boolean): JsonObject {
  if (env.code !== 0) throw mapCode(stage, env.code, env.message, session);
  if (env.data === null) throw new SiteError(SITE, stage, "返回缺少数据（站点可能改版）", "network");
  return env.data;
}

// ---------- 投稿与分 P ----------

export interface VideoPage {
  page: number;
  cid: string;
  part: string;
}

export interface VideoInfo {
  bvid: string;
  title: string;
  pages: VideoPage[];
  /** 该稿件其实是番剧 / 影视时站点给的跳转地址。 */
  redirectUrl: string;
}

export async function fetchVideo(target: Extract<BiliTarget, { kind: "video" }>, auth: Auth): Promise<VideoInfo> {
  const stage = "获取视频信息";
  const data = requireOk(stage, await get(stage, "/x/web-interface/view", `${target.idKey}=${target.id}`, auth), hasSession(auth.cookies));
  const redirectUrl = asString(data["redirect_url"]);
  const pages: VideoPage[] = [];
  asArray(data["pages"]).forEach((item, i) => {
    const o = asObject(item);
    const cid = o ? asString(o["cid"]) : "";
    if (o && cid) pages.push({ page: asNumber(o["page"]) ?? i + 1, cid, part: asString(o["part"]).trim() });
  });
  if (pages.length === 0 && redirectUrl === "") {
    const cid = asString(data["cid"]);
    if (!cid) throw new SiteError(SITE, stage, "视频没有可下载的分 P", "notFound");
    pages.push({ page: 1, cid, part: "" });
  }
  return { bvid: asString(data["bvid"]) || (target.idKey === "bvid" ? target.id : ""), title: asString(data["title"]).trim(), pages, redirectUrl };
}

// ---------- 番剧 / 影视 ----------

export interface Episode {
  id: string;
  cid: string;
  /** 集标题：数字（第几话）或「正片」「PV」等。 */
  title: string;
  longTitle: string;
}

export interface Season {
  title: string;
  episodes: Episode[];
}

export async function fetchSeason(target: Extract<BiliTarget, { kind: "episode" | "season" }>, auth: Auth): Promise<Season> {
  const stage = "获取番剧信息";
  const query = target.kind === "episode" ? `ep_id=${target.id}` : `season_id=${target.id}`;
  const data = requireOk(stage, await get(stage, "/pgc/view/web/season", query, auth), hasSession(auth.cookies));
  const episodes: Episode[] = [];
  for (const item of asArray(data["episodes"])) {
    const o = asObject(item);
    const id = o ? asString(o["id"]) || asString(o["ep_id"]) : "";
    const cid = o ? asString(o["cid"]) : "";
    if (o && id && cid) episodes.push({ id, cid, title: asString(o["title"]).trim(), longTitle: asString(o["long_title"]).trim() });
  }
  return { title: (asString(data["title"]) || asString(data["season_title"])).trim(), episodes };
}

// ---------- playurl ----------

/** 请求 DASH：16 DASH | 64 HDR | 128 4K | 256 杜比音频 | 512 杜比视界 | 1024 8K | 2048 AV1 = 4048。 */
const PLAY_PARAMS = { qn: "127", fnval: "4048", fourk: "1" } as const;

/** 按「是否带登录态」加 try_look：匿名实测，不加只给 480P，加了给到 1080P（登录账号忽略该参数）。 */
function playParams(base: Record<string, string>, auth: Auth): Record<string, string> {
  return { ...base, ...PLAY_PARAMS, ...(hasSession(auth.cookies) ? {} : { try_look: "1" }) };
}

function toQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function playOf(stage: string, data: JsonObject, session: boolean): Play {
  // 试看：不是完整内容（会员 / 付费剧集匿名或非会员只给片头片段）。
  const info = asObject(data["video_info"]) ?? data;
  if (asNumber(data["is_preview"]) === 1 || asNumber(info["is_preview"]) === 1) {
    throw new SiteError(SITE, stage, session ? "该内容需要大会员或付费，当前账号只能试看" : "该内容需要登录并开通大会员，匿名只能试看", session ? "limit" : "login");
  }
  const play = parsePlay(info);
  if (!play) throw new SiteError(SITE, stage, "没有可用的视频流（站点可能改版）", "network");
  return play;
}

/** 普通投稿：先走未签名的 `x/player/playurl`，被风控再换 WBI 签名的 `x/player/wbi/playurl`。 */
export async function fetchUgcPlay(bvid: string, cid: string, auth: Auth): Promise<Play> {
  const stage = "获取视频流";
  const session = hasSession(auth.cookies);
  const params = playParams({ bvid, cid }, auth);
  let env = await get(stage, "/x/player/playurl", toQuery(params), auth);
  if (env.risk) env = await getSigned(stage, "/x/player/wbi/playurl", params, auth);
  if (env.risk) throw new SiteError(SITE, stage, RISK_DETAIL, "limit");
  return playOf(stage, requireOk(stage, env, session), session);
}

async function getSigned(stage: string, path: string, params: Record<string, string>, auth: Auth): Promise<Envelope> {
  const nav = await get(stage, "/x/web-interface/nav", "", auth);
  // nav 未登录时 code 为 -101 但 data.wbi_img 仍在，所以不看 code。
  const wbi = nav.data ? asObject(nav.data["wbi_img"]) : null;
  const mixin = wbi ? mixinKey(wbiKeyFromUrl(asString(wbi["img_url"])), wbiKeyFromUrl(asString(wbi["sub_url"]))) : "";
  if (mixin === "") throw new SiteError(SITE, stage, "取不到 WBI 签名密钥（站点可能改版）", "network");
  return get(stage, path, signWbi(params, mixin, Math.floor(Date.now() / 1000)), auth);
}

/** 番剧 / 影视单集。 */
export async function fetchPgcPlay(epId: string, cid: string, auth: Auth): Promise<Play> {
  const stage = "获取视频流";
  const session = hasSession(auth.cookies);
  const env = await get(stage, "/pgc/player/web/playurl", toQuery(playParams({ ep_id: epId, cid }, auth)), auth);
  if (env.risk) throw new SiteError(SITE, stage, RISK_DETAIL, "limit");
  return playOf(stage, requireOk(stage, env, session), session);
}
