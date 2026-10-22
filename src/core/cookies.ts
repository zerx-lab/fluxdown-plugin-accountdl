// Cookie 串处理。任务 Cookie（ResolveContext.cookies）来自浏览器扩展：网页脚本调 `fluxdown.download`
// 时，扩展按任务 URL 用 `cookies.getAll` 取浏览器里该站点的全部 Cookie（含 HttpOnly，FluxDown
// `fluxDown/background/sender.ts` sendToFluxDown 策略 2），所以 resolver 拿到的是用户自己的登录态。

/** 解析 `a=1; b=2`（同名保留最后一个，与浏览器发送顺序无关的场景足够）。 */
export function parseCookies(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    jar.set(name, part.slice(eq + 1).trim());
  }
  return jar;
}

export function formatCookies(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 只保留指定名字的 Cookie（下发给 CDN 时最小化）。缺失的名字跳过。 */
export function pickCookies(header: string, names: readonly string[]): string {
  const jar = parseCookies(header);
  const out = new Map<string, string>();
  for (const name of names) {
    const value = jar.get(name);
    if (value !== undefined) out.set(name, value);
  }
  return formatCookies(out);
}

/**
 * 把响应的 Set-Cookie（flux.fetch 把多个值用 `\n` 连接，见 FluxDown `native/engine/src/plugin/bridge.rs`）
 * 合并进 Cookie 串：同名覆盖，`Max-Age=0` 或过期删除。不处理 Domain/Path 作用域，调用方只对同站请求合并。
 */
export function mergeSetCookie(header: string, setCookie: string | undefined): string {
  if (!setCookie) return header;
  const jar = parseCookies(header);
  for (const line of setCookie.split("\n")) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const removed =
      value === "" ||
      attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
      attrs.some((a) => /^\s*expires\s*=.*\b(19[0-9]{2}|1970)\b/i.test(a));
    if (removed) jar.delete(name);
    else jar.set(name, value);
  }
  return formatCookies(jar);
}
