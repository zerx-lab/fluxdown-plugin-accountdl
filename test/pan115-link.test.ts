import { describe, expect, test } from "bun:test";
import { parseUrl } from "../src/core/url";
import { isTaskUrl, makeTaskUrl, parseSharePage, readTask } from "../src/sites/pan115/link";

const parse = (url: string) => parseUrl(url)!;

describe("115 分享页识别", () => {
  test("识别 115.com / 115cdn.com / anxia.com 分享页与提取码", () => {
    expect(parseSharePage(parse("https://115.com/s/swsexuo3zrk?password=t58d"))).toEqual({ shareCode: "swsexuo3zrk", receiveCode: "t58d" });
    expect(parseSharePage(parse("https://115cdn.com/s/swsexuo3zrk?password=t58d&"))).toEqual({ shareCode: "swsexuo3zrk", receiveCode: "t58d" });
    expect(parseSharePage(parse("https://anxia.com/s/swsexuo3zrk/?pwd=t58d#"))).toEqual({ shareCode: "swsexuo3zrk", receiveCode: "t58d" });
  });

  test("没有提取码或提取码含非法字符时视为无提取码", () => {
    expect(parseSharePage(parse("https://115cdn.com/s/swsexuo3zrk"))?.receiveCode).toBe("");
    expect(parseSharePage(parse("https://115cdn.com/s/swsexuo3zrk?password=a%26b"))?.receiveCode).toBe("");
  });

  test("仿冒域名、非分享路径、畸形分享码都不识别", () => {
    expect(parseSharePage(parse("https://115.com.evil.com/s/swsexuo3zrk?password=t58d"))).toBeNull();
    expect(parseSharePage(parse("https://evil115cdn.com/s/swsexuo3zrk"))).toBeNull();
    expect(parseSharePage(parse("https://www.115.com/s/swsexuo3zrk"))).toBeNull();
    expect(parseSharePage(parse("https://115.com/?cid=0&mode=wangpan"))).toBeNull();
    expect(parseSharePage(parse("https://115.com/s/ab"))).toBeNull();
    expect(parseSharePage(parse("https://115.com/s/abcd/../x"))).toBeNull();
  });
});

describe("115 任务 URL", () => {
  test("生成与解析往返，固定用 115.com 主机", () => {
    const url = makeTaskUrl({ shareCode: "swsexuo3zrk", receiveCode: "t58d", dir: "2863513476439130000" });
    expect(url.startsWith("https://115.com/__accountdl/pan115?")).toBe(true);
    expect(readTask(parse(url))).toEqual({ shareCode: "swsexuo3zrk", receiveCode: "t58d", dir: "2863513476439130000" });
    expect(readTask(parse(makeTaskUrl({ shareCode: "swsexuo3zrk" })))).toEqual({ shareCode: "swsexuo3zrk", receiveCode: "", dir: "" });
  });

  test("认领只看主机与路径；参数非法时 readTask 为 null", () => {
    const bad = parse("https://115.com/__accountdl/pan115?s=ab&p=t58d");
    expect(isTaskUrl(bad)).toBe(true);
    expect(readTask(bad)).toBeNull();
    expect(readTask(parse("https://115.com/__accountdl/pan115?s=swsexuo3zrk&p=a%26b"))).toBeNull();
    expect(readTask(parse("https://115.com/__accountdl/pan115?s=swsexuo3zrk&d=1%2F2"))).toBeNull();
  });

  test("其他主机、其他站点、真实分享链接不认领", () => {
    expect(isTaskUrl(parse("https://115cdn.com/__accountdl/pan115?s=swsexuo3zrk"))).toBe(false);
    expect(isTaskUrl(parse("https://115.com.evil.com/__accountdl/pan115?s=swsexuo3zrk"))).toBe(false);
    expect(isTaskUrl(parse("https://115.com/__accountdl/pan123?s=swsexuo3zrk"))).toBe(false);
    expect(isTaskUrl(parse("https://115.com/s/swsexuo3zrk?password=t58d"))).toBe(false);
    expect(isTaskUrl(parse("http://115.com/__accountdl/pan115?s=swsexuo3zrk"))).toBe(false);
  });
});
