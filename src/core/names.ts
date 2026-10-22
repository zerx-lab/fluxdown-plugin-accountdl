// 文件名与清单路径：满足宿主对 fileName / manifest 的校验规则（禁 / \ .. 与控制字符，
// path 至多 8 级，path + "/" + name 不超过 180 个字符）。

const MAX_DEPTH = 8;
const MAX_PATH_CHARS = 180;

/** 宿主可接受的文件名：替换分隔符与控制字符，折叠连续的点，超长时保留扩展名截断。 */
export function safeFileName(name: string, maxChars = MAX_PATH_CHARS): string {
  let s = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  if (s === "" || s === ".") s = "未命名";
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
  return Array.from(s.slice(0, s.length - ext.length)).slice(0, maxChars - Array.from(ext).length).join("") + ext;
}

/**
 * 清单条目的相对目录：逐段清洗，超过 8 级或总长超限时从末尾丢弃目录段（文件仍落在最近的合法祖先目录）。
 */
export function manifestPath(dirs: readonly string[], fileName: string): string {
  const segments = dirs.map((d) => safeFileName(d)).slice(0, MAX_DEPTH);
  const nameChars = Array.from(fileName).length;
  while (segments.length > 0 && Array.from(segments.join("/")).length + 1 + nameChars > MAX_PATH_CHARS) {
    segments.pop();
  }
  return segments.join("/");
}
