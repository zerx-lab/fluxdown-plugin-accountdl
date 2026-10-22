import { describe, expect, test } from "bun:test";
import { base64Decode, utf8Bytes } from "../src/core/hash";
import { KEY_SIZE, m115Decode, m115Encode, randomBytes } from "../src/sites/pan115/m115";
import vectors from "./fixtures/pan115/m115-vectors.json";

// 向量由 SheltonZhu/115driver 的 `pkg/crypto/m115`（Go 原实现）生成：固定 key、RSA 填充字节取 `(i*7+13)%256`，
// 解码向量是任意小于模数的密文块经原实现解出的明文（服务端私钥不可得，所以解码只能用这种方式对照）。
const key = Uint8Array.from(Buffer.from(vectors.key, "hex"));
const pad = (i: number) => (i * 7 + 13) % 256;

describe("m115 与 115driver 原实现对照", () => {
  test("编码与 Go 原实现逐字节一致（单块、含中文、多块）", () => {
    expect(m115Encode(utf8Bytes(vectors.input), key, pad)).toBe(vectors.encoded);
    expect(m115Encode(utf8Bytes(vectors.input2), key, pad)).toBe(vectors.encoded2);
    const multi = m115Encode(utf8Bytes(vectors.input3), key, pad);
    expect(base64Decode(multi).length).toBe(384);
    expect(multi).toBe(vectors.encoded3);
  });

  test("解码与 Go 原实现一致（单块与双块密文）", () => {
    expect(vectors.decodes.length).toBeGreaterThanOrEqual(3);
    for (const v of vectors.decodes) {
      expect(Buffer.from(m115Decode(v.c, key)).toString("hex")).toBe(v.out);
    }
  });

  test("随机填充每次不同，但密文长度只取决于明文长度", () => {
    const input = utf8Bytes(vectors.input);
    const a = m115Encode(input, key);
    const b = m115Encode(input, key);
    expect(a).not.toBe(b);
    expect(base64Decode(a).length).toBe(base64Decode(b).length);
  });

  test("密钥长度不是 16 字节时拒绝；非法密文报错", () => {
    expect(() => m115Encode(utf8Bytes("x"), new Uint8Array(8))).toThrow("16 字节");
    expect(() => m115Decode("!!!", key)).toThrow();
    expect(() => m115Decode(Buffer.alloc(128).toString("base64"), key)).toThrow("解密失败");
  });

  test("randomBytes 给出指定长度、每次不同", () => {
    expect(randomBytes(KEY_SIZE).length).toBe(16);
    expect(Buffer.from(randomBytes(KEY_SIZE)).toString("hex")).not.toBe(Buffer.from(randomBytes(KEY_SIZE)).toString("hex"));
  });
});
