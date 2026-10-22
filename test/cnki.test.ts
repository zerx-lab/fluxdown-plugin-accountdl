import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanTitle, downloadFileName, downloadLink, isDetailPage, pickDownloads, type DownloadAnchor } from "../src/sites/cnki/link";

const FIXTURE = readFileSync(new URL("./fixtures/cnki/abstract.html", import.meta.url), "utf8");

/** 与 `src/page/cnki.ts` 的 collectAnchors 同口径：id、最近 `<li>` 的 class、文字、解码后的 href（仅用于从 fixture 取数据）。 */
function anchorsOf(html: string): DownloadAnchor[] {
  const out: DownloadAnchor[] = [];
  for (const m of html.matchAll(/<li class="([^"]*)">\s*<a([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[2];
    out.push({
      container: m[1],
      id: /\bid="([^"]*)"/.exec(attrs)?.[1] ?? "",
      href: (/\bhref="([^"]*)"/.exec(attrs)?.[1] ?? "").replace(/&amp;/g, "&"),
      text: m[3].replace(/<[^>]*>/g, "").trim(),
    });
  }
  return out;
}

/** 与页面脚本一致：移除标题栏 `<h1>` 里的 span 再取文本；另给出不移除时的文本（隐藏 span 也会进 textContent）。 */
function h1Of(html: string, dropSpans: boolean): string {
  const inner = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
  return (dropSpans ? inner.replace(/<span[\s\S]*?<\/span>/g, "") : inner).replace(/<[^>]*>/g, "");
}

const PDF = "https://bar.cnki.net/bar/download/order?id=FAKEID%2FPDF%2Babc%3D%3D";
const CAJ = "https://bar.cnki.net/bar/download/order?id=FAKEID%2FCAJ%2Babc%3D%3D";

describe("知网详情页识别", () => {
  test("认领 kns / oversea / chn.oversea 的详情页（含参数与旧版 detail.aspx）", () => {
    for (const url of [
      "https://kns.cnki.net/kcms2/article/abstract?v=abc",
      "https://kns.cnki.net/kcms2/article/abstract?uniplatform=NZKPT&v=abc%3D",
      "https://oversea.cnki.net/kcms2/article/abstract?language=EN&uniplatform=OVERSEA&v=abc",
      "https://chn.oversea.cnki.net/kcms2/article/abstract?v=abc",
      "https://kns.cnki.net/KCMS/detail/detail.aspx?dbcode=CJFD&filename=X",
      "https://kns.cnki.net/kcms/detail/detail.aspx?filename=X",
    ]) {
      expect(isDetailPage(url)).toBe(true);
    }
  });

  test("搜索页、首页、仿冒域名与非 http 不认领", () => {
    for (const url of [
      "https://kns.cnki.net/kns8s/defaultresult/index?kw=a",
      "https://www.cnki.net/",
      "https://kns.cnki.net/kcms2/author/detail?v=abc",
      "https://kns.cnki.net.evil.com/kcms2/article/abstract?v=abc",
      "https://evilcnki.net/kcms2/article/abstract?v=abc",
      "https://evil.com/kcms2/article/abstract?v=kns.cnki.net",
      "ftp://kns.cnki.net/kcms2/article/abstract",
      "not a url",
    ]) {
      expect(isDetailPage(url)).toBe(false);
    }
  });
});

describe("知网下载链接识别", () => {
  test("认领 order 链接（含海外站 barnew）与旧版 download.aspx，原样返回", () => {
    expect(downloadLink(PDF)).toBe(PDF);
    const oversea = "https://o.oversea.cnki.net/barnew/download/order?id=AB%2Fc%3D";
    expect(downloadLink(`  ${oversea} `)).toBe(oversea);
    const legacy = "https://kns.cnki.net/kcms/download.aspx?filename=ABC&dflag=pdfdown";
    expect(downloadLink(legacy)).toBe(legacy);
  });

  test("缺少 id、其他路径、其他主机、仿冒域名与 javascript 链接不认领", () => {
    for (const href of [
      "https://bar.cnki.net/bar/download/order",
      "https://bar.cnki.net/bar/download/order?id=",
      "https://bar.cnki.net/bar/ErrorMsg.html?lang=zh-CN",
      "https://login.cnki.net/login/?returnUrl=https%3A%2F%2Fbar.cnki.net%2Fbar%2Fdownload%2Forder%3Fid%3Dx",
      "https://ai.cnki.net/trans?path=study&cid=x",
      "https://bar.cnki.net.evil.com/bar/download/order?id=x",
      "https://evil.com/bar/download/order?id=x",
      "javascript:void(0)",
    ]) {
      expect(downloadLink(href)).toBeNull();
    }
  });
});

describe("详情页 fixture 提取", () => {
  test("PDF / CAJ 取各自按钮的链接，阅读类按钮与 AI 入口不混入", () => {
    const anchors = anchorsOf(FIXTURE);
    // 正文与固定工具栏各一份，另有 AI 阅读、HTML 阅读、原版阅读
    expect(anchors.filter((a) => a.id === "pdfDown")).toHaveLength(2);
    expect(pickDownloads(anchors)).toEqual({ pdf: PDF, caj: CAJ });
  });

  test("标题清洗：隐藏的「附视频」标签不进文件名，页面标题后缀被去掉", () => {
    const expected = "示例论文：面向“样本”的方法研究——以某地为例";
    expect(cleanTitle(h1Of(FIXTURE, true))).toBe(expected);
    expect(cleanTitle(h1Of(FIXTURE, false))).toBe(expected);
    expect(cleanTitle(/<title>([^<]*)<\/title>/.exec(FIXTURE)![1])).toBe(expected);
    expect(downloadFileName(h1Of(FIXTURE, false), "pdf")).toBe(`${expected}.pdf`);
    expect(downloadFileName(h1Of(FIXTURE, true), "caj")).toBe(`${expected}.caj`);
  });
});

describe("pickDownloads 边界", () => {
  const anchor = (over: Partial<DownloadAnchor>): DownloadAnchor => ({ id: "", container: "", text: "", href: PDF, ...over });

  test("没有 id 时按 li 的 class 或按钮文字识别", () => {
    expect(pickDownloads([anchor({ container: "btn-dlpdf", href: PDF }), anchor({ container: "btn-dlcaj", href: CAJ })])).toEqual({ pdf: PDF, caj: CAJ });
    expect(pickDownloads([anchor({ text: "PDF下载" }), anchor({ text: "CAJ 下载", href: CAJ })])).toEqual({ pdf: PDF, caj: CAJ });
  });

  test("只有一种格式时只返回它；没有入口返回空", () => {
    expect(pickDownloads([anchor({ id: "cajDown", href: CAJ })])).toEqual({ caj: CAJ });
    expect(pickDownloads([anchor({ text: "HTML阅读" }), anchor({ container: "btn-html" })])).toEqual({});
    expect(pickDownloads([])).toEqual({});
  });

  test("第一个按钮不是有效下载链接（登录跳转、javascript）时取后面有效的", () => {
    const login = "https://login.cnki.net/login/?returnUrl=x";
    const second = "https://bar.cnki.net/bar/download/order?id=SECOND";
    expect(pickDownloads([anchor({ id: "pdfDown", href: login }), anchor({ id: "pdfDown", href: "javascript:void(0)" }), anchor({ id: "pdfDown", href: second })])).toEqual({
      pdf: second,
    });
    expect(pickDownloads([anchor({ id: "pdfDown", href: login })])).toEqual({});
  });

  test("文档顺序里第一个有效链接胜出", () => {
    const other = "https://bar.cnki.net/bar/download/order?id=OTHER";
    expect(pickDownloads([anchor({ id: "pdfDown", href: PDF }), anchor({ id: "pdfDown", href: other })])).toEqual({ pdf: PDF });
  });
});

describe("标题与文件名", () => {
  test("折叠空白，去掉尾部「网络首发」「附视频」与页面标题后缀", () => {
    expect(cleanTitle("  某论文 \n  标题  网络首发  ")).toBe("某论文 标题");
    expect(cleanTitle("某论文 附视频 网络首发")).toBe("某论文");
    expect(cleanTitle("某论文 - 中国知网")).toBe("某论文");
    expect(cleanTitle("网络首发")).toBe("");
  });

  test("标题里的路径分隔符被替换，超长标题保留扩展名", () => {
    expect(downloadFileName("A/B\\C", "pdf")).toBe("A_B_C.pdf");
    const long = downloadFileName("长".repeat(400), "caj")!;
    expect(long.endsWith(".caj")).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(180);
  });

  test("标题为空时不指定文件名，交给下载器按响应头命名", () => {
    expect(downloadFileName("", "pdf")).toBeUndefined();
    expect(downloadFileName("  网络首发 ", "pdf")).toBeUndefined();
  });
});
