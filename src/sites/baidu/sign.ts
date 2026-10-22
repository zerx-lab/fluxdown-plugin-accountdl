// pcs locatedownload 签名（安卓客户端算法，移植自 ops baidu_transfer.go `baiduLocateSign`，
// 来源 BaiduPCS-Rust sign/locate.rs）：
//   devuid = upper(md5(BDUSS)) + "|0"
//   rand   = sha1(hex(sha1(BDUSS)) + uid + MAGIC + time + devuid)

import { md5, sha1 } from "../../core/hash";

/** 安卓客户端 locatedownload 签名的固定盐。 */
export const LOCATE_MAGIC = "ebrcUYiuxaZv2XGu7KIYKxUrqfnOfpDF";

export interface LocateSign {
  time: string;
  rand: string;
  devuid: string;
  cuid: string;
}

/** `unix` 为秒级时间戳；`uid` 为账号 uk。 */
export function locateSign(uid: string, bduss: string, unix: number): LocateSign {
  const devuid = `${md5(bduss).toUpperCase()}|0`;
  const time = String(unix);
  const rand = sha1(sha1(bduss) + uid + LOCATE_MAGIC + time + devuid);
  return { time, rand, devuid, cuid: devuid };
}
