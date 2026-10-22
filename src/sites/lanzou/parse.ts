// 蓝奏云分享页解析（纯函数）。页面里的下载参数写在内联脚本里：`$.ajax({ url, data: { 'k': <变量>, … } })`，变量名每个页面随机
// （`ibhjq9` / `_hfvs2` / `isngis` …），所以按「data 块 + 变量赋值」取值，不执行页面脚本、不依赖固定变量名。
// 结构依据 2026-10 对公开分享的匿名实测（见 test/fixtures/lanzou）。

/** 去掉 HTML 注释、`/* *\/` 注释和整行 `//` 注释（页面里留有被注释掉的旧版 `//data : {…}`，会干扰取值）。 */
export function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `var name = '值'` 的值；同名多次赋值取最后一个非空值（页面常先赋 `''` 再赋真值）。找不到返回 null。 */
export function jsVar(src: string, name: string): string | null {
  const re = new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|(-?\\d+(?:\\.\\d+)?))`, "g");
  let last: string | null = null;
  for (const m of src.matchAll(re)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (value !== "" || last === null) last = value;
  }
  return last;
}

const PAIR_RE = /['"]([^'"]+)['"]\s*:\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?))/g;

/**
 * `startAt` 之后第一个 `data : { … }` 块（要求含 `contains`），解析成表单字段。
 * 值为引号字符串或数字时原样取；为标识符时交给 `resolveIdent(键, 标识符)`，返回 null 表示无法解析（整体失败）。
 */
export function parseDataBlock(
  src: string,
  startAt: number,
  contains: string,
  resolveIdent: (key: string, ident: string) => string | null,
): Record<string, string> | null {
  const blocks = /\bdata\s*:\s*\{([^}]*)\}/g;
  blocks.lastIndex = startAt;
  for (let m = blocks.exec(src); m; m = blocks.exec(src)) {
    if (!m[1].includes(contains)) continue;
    const form: Record<string, string> = {};
    for (const p of m[1].matchAll(PAIR_RE)) {
      const key = p[1];
      if (p[4] !== undefined && !/^-?\d/.test(p[4])) {
        const value = resolveIdent(key, p[4]);
        if (value === null) return null;
        form[key] = value;
      } else {
        form[key] = p[2] ?? p[3] ?? p[4] ?? "";
      }
    }
    return form;
  }
  return null;
}

function absolute(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

export interface AjaxCall {
  /** 绝对地址。 */
  url: string;
  form: Record<string, string>;
}

/**
 * 取直链的 `downprocess` 调用，覆盖两种页面：
 * - 无密码文件的 `/fn?…` 内页：`data : {'action':'downprocess','websignkey':ajaxdata,'signs':ajaxdata,'sign':wp_sign,'websign':'','kd':kdns,'ves':1}`，
 *   接口取 `var domain1`（浏览器里 killdnsweb 可达时用它，且 `kd` 恒为 1：页面里 `kdns=0` 只在 killdns 脚本缺失时才赋值）；
 * - 有密码文件的分享页 `down_p()`：`data : {'action':'downprocess','sign':isngis,'kd':kdns,'p':pwd}`。
 */
export function parseDownprocess(src: string, origin: string, pwd: string): AjaxCall | null {
  const form = parseDataBlock(src, 0, "downprocess", (key, ident) => {
    if (key === "p" || ident === "pwd") return pwd;
    if (key === "kd") return "1";
    return jsVar(src, ident);
  });
  if (!form || !form.sign) return null;
  const domain1 = jsVar(src, "domain1");
  const direct = domain1 !== null && /ajax(?:m|file)\.php\?file=\d+/.test(domain1) ? domain1 : null;
  const found = /['"]((?:https?:\/\/[^'"\s]+)?\/?ajax(?:m|file)\.php\?file=\d+)['"]/.exec(src)?.[1];
  const path = direct ?? found;
  return path ? { url: absolute(origin, path), form } : null;
}

export interface FolderCall extends AjaxCall {
  /** 文件夹带提取码（页面有 `pwdload` 输入框）。 */
  locked: boolean;
}

/** 文件夹分享页的 `filemoreajax.php` 列表调用；`pg` 由调用方逐页覆盖。 */
export function parseFolderCall(src: string, origin: string, pwd: string): FolderCall | null {
  const ajax = /['"]((?:https?:\/\/[^'"\s]+)?\/?filemoreajax\.php[^'"]*)['"]/.exec(src);
  if (!ajax) return null;
  const path = ajax[1];
  const form = parseDataBlock(src, ajax.index, "'lx'", (key, ident) => {
    if (key === "pg") return "1";
    if (ident === "pwd") return pwd;
    return jsVar(src, ident);
  });
  if (!form) return null;
  return { url: absolute(origin, path), form, locked: /id=["']pwdload["']/.test(src) };
}

/** 页面里相对路径的 iframe（无密码文件的下载入口 `/fn?…`）。 */
export function findIframePath(src: string): string | null {
  const m = /<iframe\b[^>]*\bsrc=["'](\/[^"']+)["']/i.exec(src);
  return m ? decodeEntities(m[1]) : null;
}

export function pageTitle(src: string): string {
  const m = /<title>([^<]*)<\/title>/i.exec(src);
  return m ? decodeEntities(m[1]).replace(/\s*-\s*蓝奏云\s*$/, "").trim() : "";
}

/** 无密码文件分享页上的文件名（标题 → `id="filenajax"` → 大号文件名 div）。 */
export function pageFileName(src: string): string {
  const title = pageTitle(src);
  if (title !== "") return title;
  const m =
    /id=["']filenajax["'][^>]*>([^<]+)</.exec(src) ??
    /<div style="font-size: ?30px;[^"]*">([^<]+)<\/div>/.exec(src);
  return m ? decodeEntities(m[1]).trim() : "";
}

/** 分享已取消 / 不存在（页面文案）。 */
export function isGone(src: string): boolean {
  return src.includes("取消分享") || src.includes("文件不存在");
}

/** 页面是否有提取码输入（文件 `down_p()`，或旧版 `passwddiv`）。 */
export function isPasswordFilePage(src: string): boolean {
  return /function\s+down_p\s*\(/.test(src) || /id=["']passwddiv["']/.test(src);
}

/** 会员分享的文件夹可含子文件夹（旧版标记 `mbxfolder` / `folderlink`，OpenList 与 LanZouCloud-API 同款判断）。 */
export function hasSubfolders(src: string): boolean {
  return /\b(?:mbxfolder|folderlink)\b/.test(src);
}

/** 「1.6 M」「800.0 K」→ 近似字节数（站点只给一位小数）；解析不了返回 undefined。 */
export function parseSize(text: string): number | undefined {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([BKMG])/i.exec(text);
  if (!m) return undefined;
  const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as "B" | "K" | "M" | "G"];
  return Math.round(Number(m[1]) * unit);
}
