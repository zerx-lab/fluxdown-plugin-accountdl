// 123 云盘接口签名：每个请求的查询串追加一对 `<key>=<value>`。
// 算法与网页脚本（statics.123pan.com 分享页 bundle 的 A 函数）和 ops `pan123.go` 的 `signPath` 一致：
// - key = CRC32(UTC+8 时间戳 `YYYYMMDDHHmm` 的每个数字按 SIGN_TABLE 映射成字母)，十进制；
// - value = `<unix 秒>-<随机数>-<CRC32(unix|随机数|路径|web|3|key)>`。
// 匿名实测（2026-10-22）：share/get 缺签名也返回业务响应，服务端当前未强制校验；照常签名以贴近网页行为。

import { utf8Bytes } from "../../core/hash";

/** 只用到下标 0~9（数字 → 字母）。 */
const SIGN_TABLE = "adefghlmyijnopkqrstubcvwsz";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const b of utf8Bytes(text)) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * @param path 请求路径（不含主机与查询串），例如 `/b/api/share/get`
 * @param nowMs 当前毫秒时间戳
 * @param random 随机整数（网页取 0~1e7）
 * @returns 查询参数名与值
 */
export function signPath(path: string, nowMs: number, random: number): [key: string, value: string] {
  const unix = Math.floor(nowMs / 1000);
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const stamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const mapped = Array.from(stamp, (c) => SIGN_TABLE[Number(c)]).join("");
  const key = String(crc32(mapped));
  return [key, `${unix}-${random}-${crc32(`${unix}|${random}|${path}|web|3|${key}`)}`];
}
