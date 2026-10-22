// 多文件清单（resolver 返回 `manifest`，宿主展示勾选后按条目二段解析，`ctx.resolverItem` = 条目 id）。
// 宿主校验（FluxDown `native/engine/src/plugin/manager.rs` validate_manifest）：条目 1..=1000、id 非空 ≤200 字符、
// name 过文件名校验、path ≤8 级且 path/name ≤180 字符；任一违规整个清单被拒，所以这里先把关。

import type { ResolveResult } from "fluxdown-plugin-sdk";
import { SiteError } from "./errors";
import { manifestPath, safeFileName } from "./names";

export const MAX_ITEMS = 1000;
export const MAX_ITEM_ID_CHARS = 200;

export interface ManifestFile {
  /** 二段解析用的条目 id（≤200 字符）。 */
  id: string;
  name: string;
  /** 相对清单根的目录段。 */
  dirs?: readonly string[];
  /** 字节数；未知不填。 */
  size?: number;
}

export function manifestResult(site: string, name: string, files: readonly ManifestFile[]): ResolveResult {
  if (files.length === 0) throw new SiteError(site, "生成清单", "没有可下载的文件", "notFound");
  if (files.length > MAX_ITEMS) throw new SiteError(site, "生成清单", `文件过多（${files.length} > ${MAX_ITEMS}），请进入子目录分批下载`, "limit");
  const items = files.map((f) => {
    if (f.id === "" || Array.from(f.id).length > MAX_ITEM_ID_CHARS) {
      throw new SiteError(site, "生成清单", "条目标识过长", "unsupported");
    }
    const fileName = safeFileName(f.name);
    const path = manifestPath(f.dirs ?? [], fileName);
    return {
      id: f.id,
      name: fileName,
      kind: "file" as const,
      ...(path ? { path } : {}),
      ...(f.size !== undefined && f.size >= 0 ? { size: f.size } : {}),
    };
  });
  return { manifest: { name: safeFileName(name), items } };
}
