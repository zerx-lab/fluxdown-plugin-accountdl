// Pixiv：作品页 → 原图直链（插画/漫画/动图）。Cookie（PHPSESSID）可选：R-18、仅登录可见的作品需要；
// 没有 Cookie 时匿名尝试，被拒绝则报 login。i.pximg.net 只校验 Referer，不需要登录 Cookie。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "../../core/errors";
import { parseJsonObject, request } from "../../core/http";
import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { manifestResult } from "../../core/manifest";
import type { ResolveInput, Site } from "../../core/site";
import { artworkUrl, parseArtworkId } from "./link";

const NAME = "Pixiv";
const REFERER = "https://www.pixiv.net/";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 下载补丁：只要 Referer；图片 CDN 不需要也不应收到登录 Cookie。 */
function imagePatch(userAgent: string, fileName?: string) {
  return { cookies: "", referrer: REFERER, userAgent, ...(fileName ? { fileName } : {}) };
}

async function ajax(input: ResolveInput, stage: string, id: string, suffix: string): Promise<unknown> {
  const res = await request(NAME, stage, {
    url: `https://www.pixiv.net/ajax/illust/${id}${suffix}`,
    headers: { Accept: "application/json", "Accept-Language": "ja,en;q=0.8" },
    cookies: input.cookies,
    userAgent: input.userAgent || DEFAULT_UA,
    referer: REFERER,
  });
  if (res.status === 429) throw new SiteError(NAME, stage, "请求过于频繁，请稍后再试", "limit");
  if (res.status >= 500) throw new SiteError(NAME, stage, `HTTP ${res.status}`, "network");
  const denied = (): SiteError =>
    input.cookies
      ? new SiteError(NAME, stage, "作品不存在、已删除，或当前账号无权查看", "notFound")
      : new SiteError(NAME, stage, "作品不存在，或需要登录才能查看；请先在浏览器登录 Pixiv，再从作品页按钮发起", "login");
  if (res.status === 401 || res.status === 403) throw denied();
  let json: JsonObject;
  try {
    json = parseJsonObject(NAME, stage, res.body);
  } catch (e) {
    if (res.status >= 400) throw denied();
    throw e;
  }
  if (json["error"] === true || res.status >= 400) {
    // Pixiv 对「不存在」与「无权限」都返回 error:true 且 message 常为空，只能按是否带登录态区分。
    throw denied();
  }
  const body: unknown = json["body"];
  if (body === undefined || body === null) throw new SiteError(NAME, stage, "返回内容缺少 body", "network");
  return body;
}

function extOf(url: string): string {
  const m = /\.([A-Za-z0-9]{1,5})(?:\?|$)/.exec(url);
  return m ? m[1].toLowerCase() : "jpg";
}

function pageFileName(id: string, index: number, url: string): string {
  return `${id}_p${index}.${extOf(url)}`;
}

interface Illust {
  title: string;
  author: string;
  isUgoira: boolean;
  pageCount: number;
}

async function loadIllust(input: ResolveInput, id: string): Promise<Illust> {
  const body = asObject(await ajax(input, "读取作品", id, ""));
  if (!body) throw new SiteError(NAME, "读取作品", "返回内容格式异常", "network");
  return {
    title: asString(body["illustTitle"]) || asString(body["title"]) || id,
    author: asString(body["userName"]),
    isUgoira: asNumber(body["illustType"]) === 2,
    pageCount: asNumber(body["pageCount"]) ?? 1,
  };
}

async function loadPages(input: ResolveInput, id: string): Promise<string[]> {
  const body = await ajax(input, "读取图片列表", id, "/pages");
  const urls: string[] = [];
  for (const page of asArray(body)) {
    const original = asString(asObject(asObject(page)?.["urls"])?.["original"]);
    if (original) urls.push(original);
  }
  if (urls.length === 0) throw new SiteError(NAME, "读取图片列表", "没有找到原图地址", "notFound");
  return urls;
}

async function resolveUgoira(input: ResolveInput, id: string): Promise<ResolveResult> {
  const body = asObject(await ajax(input, "读取动图", id, "/ugoira_meta"));
  if (!body) throw new SiteError(NAME, "读取动图", "返回内容格式异常", "network");
  const src = asString(body["originalSrc"]) || asString(body["src"]);
  if (!src) throw new SiteError(NAME, "读取动图", "没有找到动图压缩包地址", "notFound");
  const fileName = `${id}_ugoira.zip`;
  return { url: src, fileName, request: imagePatch(input.userAgent || DEFAULT_UA, fileName) };
}

export const pixiv: Site = {
  id: "pixiv",
  name: NAME,
  claims: (url) => parseArtworkId(url) !== null,

  async resolve(input) {
    const id = parseArtworkId(input.parsed);
    if (!id) throw new SiteError(NAME, "识别链接", "不是 Pixiv 作品页链接", "unsupported");
    const ua = input.userAgent || DEFAULT_UA;

    // 二段：条目 id = 页序号（从 0 起）。
    if (input.resolverItem !== "") {
      if (!/^\d{1,4}$/.test(input.resolverItem)) throw new SiteError(NAME, "解析条目", "条目标识无效", "unsupported");
      const index = Number(input.resolverItem);
      const urls = await loadPages(input, id);
      const url = urls[index];
      if (!url) throw new SiteError(NAME, "解析条目", "该页已不存在", "notFound");
      const fileName = pageFileName(id, index, url);
      return { url, fileName, request: imagePatch(ua, fileName) };
    }

    const illust = await loadIllust(input, id);
    if (illust.isUgoira) return resolveUgoira(input, id);

    const urls = await loadPages(input, id);
    if (urls.length === 1) {
      const fileName = pageFileName(id, 0, urls[0]);
      return { url: urls[0], fileName, request: imagePatch(ua, fileName) };
    }
    const dir = illust.author ? `${illust.author} - ${illust.title}` : illust.title;
    return manifestResult(
      NAME,
      dir,
      urls.map((u, i) => ({ id: String(i), name: pageFileName(id, i, u), dirs: [dir] })),
    );
  },
};

export { artworkUrl };
