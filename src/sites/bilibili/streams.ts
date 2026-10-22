// playurl 响应解析与画质 / 编码 / 音频选择：纯函数，不依赖 flux。
// 响应形状（匿名实测 2026-10-22，`x/player/playurl` 与 `pgc/player/web/playurl`）：
//   dash.video[] / dash.audio[]：id、baseUrl、backupUrl（可为 null）、bandwidth、codecid（7 AVC / 12 HEVC / 13 AV1）、width、height；
//   dash.flac.audio（对象或 null）、dash.dolby.audio（数组或 null）；无 dash 时回退 durl[]：{url, size, backup_url}。
// 注意 `accept_quality` 列的是站点「支持」的画质，不是账号「拿得到」的：匿名也会列出 112，但 dash.video 里没有，
// 所以一律以 dash.video 里实际出现的 id 为准。

import { asArray, asNumber, asObject, asString, type JsonObject } from "../../core/json";
import { parseUrl } from "../../core/url";

export type Codec = "avc" | "hevc" | "av1";
export type QualityPref = "best" | "ask" | "2160" | "1080" | "720" | "480" | "360";
export type CodecPref = Codec;
export type AudioPref = "standard" | "best";

export interface VideoStream {
  /** 画质 id（qn）。 */
  id: number;
  codec: Codec;
  bandwidth: number;
  width: number;
  height: number;
  /** baseUrl 在前，其后是备用地址。 */
  urls: string[];
}

export interface AudioStream {
  id: number;
  kind: "aac" | "flac" | "dolby";
  bandwidth: number;
  urls: string[];
}

export interface DurlPart {
  urls: string[];
  size: number;
}

export type Play =
  | { kind: "dash"; videos: VideoStream[]; audios: AudioStream[] }
  | { kind: "durl"; parts: DurlPart[]; quality: number };

const CODEC_BY_ID: Readonly<Record<number, Codec>> = { 7: "avc", 12: "hevc", 13: "av1" };
const CODEC_ORDER: Readonly<Record<CodecPref, readonly Codec[]>> = {
  avc: ["avc", "hevc", "av1"],
  hevc: ["hevc", "avc", "av1"],
  av1: ["av1", "hevc", "avc"],
};

/** 普通（SDR）画质由低到高。125（HDR）与 126（杜比视界）数值更大但不在此列：兼容性差，只在「每次询问」里出现。 */
const SDR_RANK: readonly number[] = [6, 16, 32, 64, 74, 80, 112, 116, 120, 127];
/** 各画质偏好允许的最高 id（含）。 */
const CAP_BY_PREF: Readonly<Record<Exclude<QualityPref, "ask">, number>> = {
  best: 127,
  "2160": 120,
  "1080": 116,
  "720": 74,
  "480": 32,
  "360": 16,
};

const QUALITY_NAMES: Readonly<Record<number, string>> = {
  127: "8K 超高清",
  126: "杜比视界",
  125: "HDR 真彩",
  120: "4K 超清",
  116: "1080P60 高帧率",
  112: "1080P+ 高码率",
  80: "1080P 高清",
  74: "720P60 高帧率",
  64: "720P 高清",
  32: "480P 清晰",
  16: "360P 流畅",
  6: "240P 极速",
};
const CODEC_NAMES: Readonly<Record<Codec, string>> = { avc: "AVC", hevc: "HEVC", av1: "AV1" };

export function qualityName(id: number): string {
  return QUALITY_NAMES[id] ?? `画质 ${id}`;
}
export function codecName(codec: Codec): string {
  return CODEC_NAMES[codec];
}

function sdrRank(id: number): number {
  return SDR_RANK.indexOf(id);
}

/** 画质排序键：SDR 按清晰度；HDR / 杜比视界排在同档 4K 之上、8K 之下。 */
function sortKey(id: number): number {
  if (id === 125) return SDR_RANK.indexOf(120) + 0.5;
  if (id === 126) return SDR_RANK.indexOf(120) + 0.6;
  const r = sdrRank(id);
  return r >= 0 ? r : -1;
}

// ---------- 解析 ----------

function urlList(o: JsonObject): string[] {
  const out: string[] = [];
  const base = asString(o["baseUrl"]) || asString(o["base_url"]) || asString(o["url"]);
  if (base) out.push(base);
  for (const b of asArray(o["backupUrl"] ?? o["backup_url"])) {
    const u = asString(b);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function codecOf(o: JsonObject): Codec | null {
  const byId = CODEC_BY_ID[asNumber(o["codecid"]) ?? -1];
  if (byId) return byId;
  const codecs = asString(o["codecs"]).toLowerCase();
  if (codecs.startsWith("avc")) return "avc";
  if (codecs.startsWith("hev") || codecs.startsWith("hvc")) return "hevc";
  if (codecs.startsWith("av01")) return "av1";
  return null;
}

function audioOf(o: JsonObject | null, kind: AudioStream["kind"]): AudioStream | null {
  if (!o) return null;
  const urls = urlList(o);
  const id = asNumber(o["id"]);
  if (urls.length === 0 || id === null) return null;
  return { id, kind, bandwidth: asNumber(o["bandwidth"]) ?? 0, urls };
}

/**
 * 从 playurl 的 data（或 pgc 的 result / result.video_info）取流。dash 与 durl 都没有返回 null。
 * 同一画质同一编码出现多条时保留码率最高的。
 */
export function parsePlay(data: JsonObject): Play | null {
  const dash = asObject(data["dash"]);
  if (dash) {
    const best = new Map<string, VideoStream>();
    for (const item of asArray(dash["video"])) {
      const o = asObject(item);
      if (!o) continue;
      const id = asNumber(o["id"]);
      const codec = codecOf(o);
      const urls = urlList(o);
      if (id === null || codec === null || urls.length === 0) continue;
      const stream: VideoStream = {
        id,
        codec,
        bandwidth: asNumber(o["bandwidth"]) ?? 0,
        width: asNumber(o["width"]) ?? 0,
        height: asNumber(o["height"]) ?? 0,
        urls,
      };
      const key = `${id}/${codec}`;
      const prev = best.get(key);
      if (!prev || stream.bandwidth > prev.bandwidth) best.set(key, stream);
    }
    const audios: AudioStream[] = [];
    for (const item of asArray(dash["audio"])) {
      const a = audioOf(asObject(item), "aac");
      if (a) audios.push(a);
    }
    const flac = audioOf(asObject(asObject(dash["flac"])?.["audio"]), "flac");
    if (flac) audios.push(flac);
    for (const item of asArray(asObject(dash["dolby"])?.["audio"])) {
      const a = audioOf(asObject(item), "dolby");
      if (a) audios.push(a);
    }
    if (best.size > 0) return { kind: "dash", videos: [...best.values()], audios };
  }
  const parts: DurlPart[] = [];
  for (const item of asArray(data["durl"])) {
    const o = asObject(item);
    if (!o) continue;
    const urls = urlList(o);
    if (urls.length > 0) parts.push({ urls, size: asNumber(o["size"]) ?? 0 });
  }
  if (parts.length > 0) return { kind: "durl", parts, quality: asNumber(data["quality"]) ?? 0 };
  return null;
}

// ---------- 选择 ----------

/** 按偏好挑一条视频流：先定画质（不超过偏好上限的最高 SDR 档；都超限就取最低档），再在该档里按编码偏好取。 */
export function chooseVideo(videos: readonly VideoStream[], quality: Exclude<QualityPref, "ask">, codec: CodecPref): VideoStream {
  const cap = CAP_BY_PREF[quality];
  const ids = [...new Set(videos.map((v) => v.id))];
  const sdr = ids.filter((id) => sdrRank(id) >= 0).sort((a, b) => sdrRank(a) - sdrRank(b));
  let id: number;
  if (sdr.length > 0) {
    const within = sdr.filter((x) => x <= cap);
    id = within.length > 0 ? within[within.length - 1] : sdr[0];
  } else {
    // 只有 HDR / 杜比视界 / 未知画质：取最低的一档，免得凭空选最重的。
    id = ids.sort((a, b) => sortKey(a) - sortKey(b))[0];
  }
  return pickCodec(videos.filter((v) => v.id === id), codec);
}

function pickCodec(candidates: readonly VideoStream[], codec: CodecPref): VideoStream {
  for (const c of CODEC_ORDER[codec]) {
    const hit = candidates.find((v) => v.codec === c);
    if (hit) return hit;
  }
  return candidates[0];
}

/** 全部可选组合，清晰度高→低，同档按编码偏好排（供「每次询问」的变体列表）。 */
export function listVideoChoices(videos: readonly VideoStream[], codec: CodecPref): VideoStream[] {
  const order = CODEC_ORDER[codec];
  return [...videos].sort((a, b) => sortKey(b.id) - sortKey(a.id) || order.indexOf(a.codec) - order.indexOf(b.codec));
}

/**
 * 音频：`standard` 取码率最高的普通 AAC（30280 > 30232 > 30216）；`best` 依次 Hi-Res FLAC > 杜比全景声 > 普通。
 * 没有音频返回 null（无声视频）。
 */
export function chooseAudio(audios: readonly AudioStream[], pref: AudioPref): AudioStream | null {
  const byRate = (a: AudioStream, b: AudioStream) => b.bandwidth - a.bandwidth;
  const aac = audios.filter((a) => a.kind === "aac").sort(byRate);
  if (pref === "best") {
    const flac = audios.find((a) => a.kind === "flac");
    if (flac) return flac;
    const dolby = audios.filter((a) => a.kind === "dolby").sort(byRate)[0];
    if (dolby) return dolby;
  }
  return aac[0] ?? audios.slice().sort(byRate)[0] ?? null;
}

/**
 * 多个候选地址里挑一个：baseUrl 常是 PCDN（`*.mcdn.bilivideo.cn:8082` 等，不稳定、依赖用户侧节点），
 * 备用地址里有标准 `upos-*.bilivideo.com`。优先非 PCDN，都是 PCDN 才用第一个。
 * （匿名实测 2026-10-22：upos 主机不带 Referer 返回 403，mcdn 不要求。）
 */
export function pickStreamUrl(urls: readonly string[]): string {
  const ok = urls.find((u) => {
    const host = parseUrl(u)?.host ?? "";
    return host !== "" && !/(^|\.)mcdn\.bilivideo\.(cn|com)$/.test(host) && !host.endsWith(".szbdyd.com") && !/^\d+(\.\d+){3}$/.test(host);
  });
  return ok ?? urls[0];
}
