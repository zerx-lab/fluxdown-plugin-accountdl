// 按 2026-10-22 匿名实测的真实响应结构编写的哔哩哔哩 API 响应（只保留解析用到的字段）。

export const BVID = "BV1GJ411x7h7";
export const CID = "137649199";

const MCDN = (name: string) => `https://xy36x250x117x110xy.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/99/91/${name}.m4s?deadline=1&e=x`;
const UPOS = (host: string, name: string) => `https://${host}.bilivideo.com/upgcxcode/99/91/${name}.m4s?deadline=1&e=x&uipk=5`;

export interface DashVideoSpec {
  id: number;
  codecid: 7 | 12 | 13;
  bandwidth?: number;
}

/** 一条视频流：baseUrl 是 PCDN，备用地址是标准 upos（与真实响应一致）。 */
export function videoStream(spec: DashVideoSpec) {
  const name = `${CID}_${spec.id}_${spec.codecid}`;
  return {
    id: spec.id,
    baseUrl: MCDN(name),
    base_url: MCDN(name),
    backupUrl: [UPOS("upos-sz-mirrorhwo1", name), UPOS("upos-sz-mirrorhw", name)],
    bandwidth: spec.bandwidth ?? 1_000_000 + spec.id * 1000 + spec.codecid,
    mimeType: "video/mp4",
    codecs: spec.codecid === 7 ? "avc1.640032" : spec.codecid === 12 ? "hev1.1.6.L150.90" : "av01.0.08M.08.0.110.01.01.01.0",
    width: spec.id >= 80 ? 1920 : 1280,
    height: spec.id >= 80 ? 1080 : 720,
    codecid: spec.codecid,
  };
}

export function audioStream(id: number, bandwidth: number) {
  const name = `${CID}_audio_${id}`;
  return {
    id,
    baseUrl: MCDN(name),
    backupUrl: [UPOS("upos-sz-mirrorcoso1", name)],
    bandwidth,
    codecs: id === 30216 ? "mp4a.40.5" : "mp4a.40.2",
  };
}

export interface DashSpec {
  videos: DashVideoSpec[];
  /** 普通音频 id → 码率。 */
  audios?: Array<[number, number]>;
  flac?: boolean;
  dolby?: boolean;
}

export function dashBody(spec: DashSpec) {
  return {
    quality: 64,
    accept_quality: [112, 80, 64, 32, 16],
    dash: {
      duration: 213,
      video: spec.videos.map(videoStream),
      audio: (spec.audios ?? [[30280, 203786], [30232, 102931], [30216, 43962]]).map(([id, rate]) => audioStream(id, rate)),
      dolby: spec.dolby ? { type: 1, audio: [audioStream(30250, 448000)] } : { type: 0, audio: null },
      flac: spec.flac ? { display: true, audio: audioStream(30251, 900000) } : null,
    },
  };
}

/** 普通投稿 playurl 成功响应（负载在 data）。 */
export function ugcPlay(spec: DashSpec | { durl: Array<{ url: string; size: number }>; quality?: number }) {
  if ("durl" in spec) {
    return { code: 0, message: "OK", data: { quality: spec.quality ?? 32, format: "flv480", durl: spec.durl.map((d) => ({ order: 1, length: 1, size: d.size, url: d.url, backup_url: null })) } };
  }
  return { code: 0, message: "OK", data: dashBody(spec) };
}

/** 番剧 playurl 成功响应（负载在 result）。 */
export function pgcPlay(spec: DashSpec | { durl: Array<{ url: string; size: number }> }, extra: Record<string, unknown> = {}) {
  const inner = "durl" in spec ? { quality: 32, durl: spec.durl.map((d) => ({ size: d.size, url: d.url })) } : dashBody(spec);
  return { code: 0, message: "success", result: { is_preview: 0, ...inner, ...extra } };
}

export function viewBody(pages: Array<{ page: number; cid: string; part: string }>, title = "【官方 MV】Never Gonna Give You Up", extra: Record<string, unknown> = {}) {
  return { code: 0, message: "OK", data: { bvid: BVID, aid: 80433022, title, videos: pages.length, cid: pages[0]?.cid, pages, ...extra } };
}

export function seasonBody(episodes: Array<{ id: number; cid: number; title: string; long_title: string }>, title = "鬼灭之刃") {
  return { code: 0, message: "success", result: { title, season_title: title, episodes } };
}

export const NAV_BODY = {
  code: -101,
  message: "账号未登录",
  data: {
    isLogin: false,
    wbi_img: {
      img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
      sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
    },
  },
};

export const VOUCHER_BODY = { code: 0, message: "OK", data: { v_voucher: "voucher_d888f390-0ab3-458e-b022-668c6250574d" } };
