import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mergeSetCookie, parseCookies, pickCookies } from "../src/core/cookies";
import { base64Decode, base64Encode, md5, sha1, utf8Bytes, utf8Decode } from "../src/core/hash";
import { manifestResult } from "../src/core/manifest";
import { parseTaskUrl, taskUrl } from "../src/core/task";
import { parseUrl } from "../src/core/url";

describe("hash", () => {
  test("md5 / sha1 与 Node 实现一致（含中文与跨块长度）", () => {
    for (const s of ["", "abc", "中文文件名.zip", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)]) {
      expect(md5(s)).toBe(createHash("md5").update(s).digest("hex"));
      expect(sha1(s)).toBe(createHash("sha1").update(s).digest("hex"));
    }
  });

  test("base64 往返，兼容 URL 安全字母表与缺省填充", () => {
    const bytes = utf8Bytes("账号直链 ✓ 😀");
    expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(utf8Decode(base64Decode(Buffer.from(bytes).toString("base64url")))).toBe("账号直链 ✓ 😀");
    expect(() => base64Decode("a$b")).toThrow();
  });
});

describe("cookies", () => {
  test("只挑需要的 Cookie，Set-Cookie 覆盖与删除", () => {
    const jar = "a=1; BDUSS=xx; b=2";
    expect(pickCookies(jar, ["BDUSS", "STOKEN"])).toBe("BDUSS=xx");
    const merged = mergeSetCookie(jar, "a=9; Path=/\nb=; Max-Age=0\nc=3; HttpOnly");
    expect(Object.fromEntries(parseCookies(merged))).toEqual({ a: "9", BDUSS: "xx", c: "3" });
  });
});

describe("task url", () => {
  test("生成与解析往返（含中文、& 与 #）", () => {
    const url = taskUrl("pan.example.com", "demo", { key: "k&1", name: "文件#1" });
    expect(parseTaskUrl(parseUrl(url)!)).toEqual({ siteId: "demo", params: { key: "k&1", name: "文件#1" } });
  });

  test("非本插件路径或非 https 不认领", () => {
    expect(parseTaskUrl(parseUrl("https://pan.example.com/s/abc")!)).toBeNull();
    expect(parseTaskUrl(parseUrl("http://pan.example.com/__accountdl/demo")!)).toBeNull();
    expect(parseTaskUrl(parseUrl("https://pan.example.com/__accountdl/../x")!)).toBeNull();
  });
});

describe("manifest", () => {
  test("清洗文件名与目录并保留大小", () => {
    const res = manifestResult("站点", "根/目录", [{ id: "1", name: "a/b.txt", dirs: ["子..目录"], size: 3 }]);
    expect(res.manifest).toEqual({ name: "根_目录", items: [{ id: "1", name: "a_b.txt", kind: "file", path: "子.目录", size: 3 }] });
  });

  test("空清单、超量与超长 id 报错", () => {
    expect(() => manifestResult("站点", "x", [])).toThrow("没有可下载的文件");
    expect(() => manifestResult("站点", "x", Array.from({ length: 1001 }, (_, i) => ({ id: String(i), name: "f" })))).toThrow("文件过多");
    expect(() => manifestResult("站点", "x", [{ id: "i".repeat(201), name: "f" }])).toThrow("条目标识过长");
  });
});
