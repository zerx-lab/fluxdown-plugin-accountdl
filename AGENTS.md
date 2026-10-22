# 账号直链（accountdl）— AI 工作契约

FluxDown 插件：用用户**在浏览器里已登录**的账号，把百度网盘 / 115 / 夸克 / 123 云盘 / 蓝奏云分享、B 站视频、Pixiv 作品、知网论文解析为直链交给 FluxDown。使用简体中文回复。命令在本目录执行。

## 账号来源（核心设计，勿改走 auth / 号池）

- 插件不登录、不保存账号。网页脚本（`contributes.pageScripts`，浏览器扩展 userScripts isolated world）在站点页面加按钮，调 `fluxdown.download(<任务 URL>)`；扩展按任务 URL 用 `cookies.getAll` 附上浏览器 Cookie（含 HttpOnly，FluxDown `fluxDown/background/sender.ts` sendToFluxDown）。resolver 的 `ctx.cookies` 即用户登录态；清单子任务继承任务 Cookie（`native/engine/src/db.rs` fission_into_group）。
- 网盘任务 URL 用站点自己的主机 + 专属路径 `/__accountdl/<站点 id>?…`（`src/core/task.ts`）：主机决定扩展附哪个域的 Cookie；专属路径避免与 DiskDirect 争同一 URL。B 站 / Pixiv / 蓝奏云用真实页面 URL，可在 FluxDown 里直接粘贴（无 Cookie 时匿名）。
- 网页脚本不联网解析，只取标识交给 FluxDown；所有站点 API 请求在 resolver（QuickJS）里用 `flux.fetch` 带 Cookie 发出。令牌只在网页 localStorage 的站点经 `Site.page.rpc` → main → `flux.storage`。
- 每个 resolver 结果必须显式设置 `request.cookies`（直链所需最小 Cookie 或 `""`），否则宿主把整串浏览器 Cookie 发给直链主机（`native/engine/src/intercept/patch.rs`）。

## 结构

- `src/core/`：`site.ts`（`Site` 契约）、`registry.ts`（`SITES`，顺序 = 认领优先级）、`task.ts`、`http.ts`、`cookies.ts`、`hash.ts`（md5/sha1/base64）、`manifest.ts`（清单校验同宿主规则）、`url.ts`、`names.ts`、`errors.ts`（`SiteError`，kind ∈ login/password/notFound/limit/network/unsupported/other）。
- `src/sites/<id>/`：每站点链接识别 + resolver 逻辑；`src/page/<id>.ts`：该站点网页脚本（公共件 `src/page/kit.ts`）。
- `src/resolve.ts` 分派；`src/main.ts` 只注册各站点声明的页面 RPC（`<id>.<name>`，校验 `ctx.caller === "page"` 与页面主机）。
- 新增站点：站点目录 + 注册表 + manifest `resolvers[0].match.urls` + `contributes.pageScripts` + `fluxdown-plugin.config.json` entries + README + 测试。

## 边界

- resolve/main 是 QuickJS：只有 ES2022 + `flux`；禁 `URL`、`TextEncoder`、`atob`、`fetch`、定时器、Node/Bun/DOM。`tsconfig.json` 的 `lib`/`types` 不得放宽。`flux.fetch` 自动跟随重定向、10 秒 / 8 MB、无 Cookie jar；resolve 总时长 30 秒。
- 网页上不出现 FluxDown 名称或标志；网页节点只用 createElement / textContent。
- 日志与错误消息不含 Cookie、令牌、密码、带签名直链。仅有证据时声明 `ephemeral` / `rangeSupported`。
- 不手改 `dist/`、`.fxplug`、`bun.lock`；新增依赖先征得用户同意。未经要求不 commit / 发布 / 安装 / 启动 GUI 或浏览器。

## 验证

`bun test && bun run typecheck && bun run build && bun run validate`。测试离线（`test/helpers.ts` 的 `installFlux` 伪造 HTTP 层）。登录后的真实链路只能由用户在浏览器 + FluxDown 中验证：FluxDown 设置 → 扩展 → 插件 → 从目录安装 `dist/`，浏览器扩展选项「页面脚本」里启用本插件。
