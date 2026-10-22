// 蓝奏云 CDN（阿里云 ESA）的 `acw_sc__v2` 反爬挑战：未带该 Cookie 的请求先收到一页 `var arg1='<40 位十六进制>'`
// 的脚本，浏览器执行后算出 Cookie 再刷新。算法（与 OpenList drivers/lanzou、hanximeng/LanzouAPI 一致，2026-10 实测
// 向真实直链验证通过）：arg1 按固定位置表重排，再与固定掩码逐字节异或。这里只实现算法，不执行远端脚本。

const POSITIONS = [
  6, 28, 34, 31, 33, 18, 30, 23, 9, 8, 19, 38, 17, 24, 0, 5, 32, 21, 10, 22, 25, 14, 15, 3, 16, 27, 13, 35, 2, 29, 11, 26,
  4, 36, 1, 39, 37, 7, 20, 12,
];
const MASK = "3000176000856006061501533003690027800375";

const ARG1_RE = /\barg1\s*=\s*['"]([0-9A-Fa-f]{40})['"]/;

/** 页面里的挑战参数 `arg1`；没有挑战返回 null。 */
export function findChallenge(body: string): string | null {
  return ARG1_RE.exec(body)?.[1] ?? null;
}

/** arg1（40 位十六进制）→ `acw_sc__v2` 的值（40 位小写十六进制）。 */
export function calcAcwScV2(arg1: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(arg1)) throw new Error("arg1 必须是 40 位十六进制");
  const shuffled: string[] = new Array(40).fill("");
  POSITIONS.forEach((to, from) => {
    shuffled[to] = arg1[from];
  });
  const mixed = shuffled.join("");
  let out = "";
  for (let i = 0; i < 40; i += 2) {
    const x = parseInt(mixed.slice(i, i + 2), 16) ^ parseInt(MASK.slice(i, i + 2), 16);
    out += x.toString(16).padStart(2, "0");
  }
  return out;
}
