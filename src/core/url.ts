// QuickJS 没有 URL / URLSearchParams：只做本插件需要的最小 URL 拆分与查询串处理。

export interface ParsedUrl {
  scheme: string;
  /** 小写主机名，不含端口。 */
  host: string;
  /** 以 `/` 开头的路径（未解码）。 */
  path: string;
  /** 不含 `?` 的查询串。 */
  query: string;
  /** 不含 `#` 的片段。 */
  fragment: string;
}

const URL_RE = /^(https?):\/\/([^/?#@\s]+@)?([^/?#:\s]+)(?::\d+)?([^?#\s]*)(?:\?([^#\s]*))?(?:#(\S*))?$/i;

export function parseUrl(url: string): ParsedUrl | null {
  const m = URL_RE.exec(url.trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: m[3].toLowerCase(),
    path: m[4] || "/",
    query: m[5] ?? "",
    fragment: m[6] ?? "",
  };
}

/** 解码百分号编码；畸形输入原样返回。 */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** 解析 `a=1&b=2`（同名取第一个）。 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const name = safeDecode(eq < 0 ? part : part.slice(0, eq));
    if (name in out) continue;
    out[name] = eq < 0 ? "" : safeDecode(part.slice(eq + 1));
  }
  return out;
}

/** 按插入顺序编码查询串。 */
export function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * 文本中出现的 http(s) 链接（按出现顺序）。只收 URL 合法的 ASCII 字符，
 * 所以「…/s/abc-def.html提取码：1234」这类无空格粘连的分享文案也能截出链接。
 */
export function findUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/gi) ?? [];
  return found.map((u) => u.replace(/[.,;:!?]+$/, ""));
}
