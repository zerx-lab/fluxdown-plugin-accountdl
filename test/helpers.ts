// 测试用 flux 垫片：记录请求、按处理函数返回响应；settings / storage 可注入。被测代码本身不 mock，只伪造 HTTP 层。

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** 对象按 JSON 序列化。 */
  body: unknown;
}

export function installFlux(
  handler: (req: MockRequest) => MockResponse | Promise<MockResponse>,
  settings: Record<string, string | number | boolean | null> = {},
  storage: Record<string, string> = {},
) {
  const requests: MockRequest[] = [];
  Reflect.set(globalThis, "flux", {
    async fetch(opts: { method?: string; url: string; headers?: Record<string, string>; body?: string }) {
      const req = { method: opts.method ?? "GET", url: opts.url, headers: opts.headers ?? {}, body: opts.body };
      requests.push(req);
      const res = await handler(req);
      return {
        status: res.status ?? 200,
        headers: res.headers ?? { "content-type": "application/json" },
        body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        truncated: false,
      };
    },
    settings,
    storage: {
      async get(key: string) {
        return storage[key] ?? null;
      },
      async set(key: string, value: string) {
        storage[key] = value;
      },
    },
    info: { identity: "accountdl@accountdl", version: "test", appVersion: "test" },
    logger: { info() {}, warn() {}, error() {} },
  });
  return { requests, storage };
}

/** 请求头取值（大小写不敏感）。 */
export function header(req: MockRequest, name: string): string | undefined {
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : req.headers[key];
}
