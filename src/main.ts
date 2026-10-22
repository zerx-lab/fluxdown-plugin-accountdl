// 常驻 main：只为网页脚本提供各站点声明的页面 RPC（`Site.page`），名字为 `<站点 id>.<名>`。
// 只接受网页调用（`ctx.caller === "page"`），只信宿主给的 `ctx.pageUrl`，且页面主机须属于该站点。

import { defineMain } from "fluxdown-plugin-sdk/runtime";
import { SiteError } from "./core/errors";
import { SITES } from "./core/registry";
import { hostIn } from "./core/site";
import { parseUrl } from "./core/url";

defineMain((flux) => {
  for (const site of SITES) {
    const page = site.page;
    if (!page) continue;
    for (const [name, handler] of Object.entries(page.rpc)) {
      flux.rpc.handle(
        `${site.id}.${name}`,
        async (args, ctx) => {
          if (ctx.caller !== "page") throw new SiteError(site.name, "页面调用", "只接受网页脚本调用", "unsupported");
          const pageUrl = parseUrl(ctx.pageUrl);
          if (!pageUrl || !hostIn(pageUrl.host, page.hosts)) throw new SiteError(site.name, "页面调用", "调用页面不属于该站点", "unsupported");
          return handler(args, pageUrl);
        },
        { page: true },
      );
    }
  }
});
