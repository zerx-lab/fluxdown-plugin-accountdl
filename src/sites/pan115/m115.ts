// 115 App 接口的 m115 载荷加解密（纯 BigInt 实现，QuickJS 没有 crypto）。
// 算法依据开源实现 SheltonZhu/115driver `pkg/crypto/m115`（Go）：
//   编码：buf = key(16) ‖ 明文；明文段先用 derive(key, 4) 异或，再整体反转，再用固定客户端密钥异或；
//         整个 buf 按 117 字节分块做 RSA（e=65537，PKCS#1 v1.5 type 2 填充），拼接后 base64。
//   解码：base64 → 按 128 字节分块做「公钥指数」运算（服务端用私钥加密）并去填充 → 前 16 字节是服务端密钥，
//         余下用 derive(服务端密钥, 12) 异或、反转、再用 derive(请求 key, 4) 异或。
// 密钥模数与异或种子是 115 客户端内置常量，不是秘密。

import { base64Decode, base64Encode } from "../../core/hash";

const MODULUS = BigInt(
  "0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b86021" +
    "36477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad633" +
    "8c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f1" +
    "0a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683",
);
const EXPONENT = 0x10001n;
/** RSA 块长（模数 1024 位）。 */
const BLOCK = 128;
/** PKCS#1 v1.5 每块最多容纳的明文字节数。 */
const BLOCK_PAYLOAD = BLOCK - 11;

const XOR_SEED = Uint8Array.from([
  0xf0, 0xe5, 0x69, 0xae, 0xbf, 0xdc, 0xbf, 0x8a, 0x1a, 0x45, 0xe8, 0xbe, 0x7d, 0xa6, 0x73, 0xb8,
  0xde, 0x8f, 0xe7, 0xc4, 0x45, 0xda, 0x86, 0xc4, 0x9b, 0x64, 0x8b, 0x14, 0x6a, 0xb4, 0xf1, 0xaa,
  0x38, 0x01, 0x35, 0x9e, 0x26, 0x69, 0x2c, 0x86, 0x00, 0x6b, 0x4f, 0xa5, 0x36, 0x34, 0x62, 0xa6,
  0x2a, 0x96, 0x68, 0x18, 0xf2, 0x4a, 0xfd, 0xbd, 0x6b, 0x97, 0x8f, 0x4d, 0x8f, 0x89, 0x13, 0xb7,
  0x6c, 0x8e, 0x93, 0xed, 0x0e, 0x0d, 0x48, 0x3e, 0xd7, 0x2f, 0x88, 0xd8, 0xfe, 0xfe, 0x7e, 0x86,
  0x50, 0x95, 0x4f, 0xd1, 0xeb, 0x83, 0x26, 0x34, 0xdb, 0x66, 0x7b, 0x9c, 0x7e, 0x9d, 0x7a, 0x81,
  0x32, 0xea, 0xb6, 0x33, 0xde, 0x3a, 0xa9, 0x59, 0x34, 0x66, 0x3b, 0xaa, 0xba, 0x81, 0x60, 0x48,
  0xb9, 0xd5, 0x81, 0x9c, 0xf8, 0x6c, 0x84, 0x77, 0xff, 0x54, 0x78, 0x26, 0x5f, 0xbe, 0xe8, 0x1e,
  0x36, 0x9f, 0x34, 0x80, 0x5c, 0x45, 0x2c, 0x9b, 0x76, 0xd5, 0x1b, 0x8f, 0xcc, 0xc3, 0xb8, 0xf5,
]);
const XOR_CLIENT_KEY = Uint8Array.from([0x78, 0x06, 0xad, 0x4c, 0x33, 0x86, 0x5d, 0x18, 0x4c, 0x01, 0x3f, 0x46]);

/** 请求密钥长度。 */
export const KEY_SIZE = 16;

function deriveKey(seed: Uint8Array, size: number): Uint8Array {
  const key = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    key[i] = ((seed[i]! + XOR_SEED[size * i]!) & 0xff) ^ XOR_SEED[size * (size - i - 1)]!;
  }
  return key;
}

/** 原地异或：长度不是 4 的倍数时，前 `len % 4` 个字节单独按密钥起头处理，其余按 `(i - mod) % keySize` 取密钥。 */
function xorTransform(data: Uint8Array, key: Uint8Array): void {
  const mod = data.length % 4;
  for (let i = 0; i < mod; i++) data[i] = data[i]! ^ key[i % key.length]!;
  for (let i = mod; i < data.length; i++) data[i] = data[i]! ^ key[(i - mod) % key.length]!;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** 大端、定长（不足左补零）。 */
function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** base^EXPONENT mod MODULUS（平方-乘）。 */
function modPowPublic(base: bigint): bigint {
  let result = 1n;
  let b = base % MODULUS;
  let e = EXPONENT;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % MODULUS;
    b = (b * b) % MODULUS;
    e >>= 1n;
  }
  return result;
}

function rsaEncrypt(input: Uint8Array, pad: (index: number) => number): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (let off = 0; off < input.length; off += BLOCK_PAYLOAD) {
    const slice = input.subarray(off, Math.min(off + BLOCK_PAYLOAD, input.length));
    const padSize = BLOCK - slice.length - 3;
    const msg = new Uint8Array(BLOCK);
    msg[1] = 2;
    for (let i = 0; i < padSize; i++) msg[2 + i] = (pad(i) % 0xff) + 1; // 填充字节必须非零
    msg.set(slice, padSize + 3);
    blocks.push(bigIntToBytes(modPowPublic(bytesToBigInt(msg)), BLOCK));
  }
  const out = new Uint8Array(blocks.length * BLOCK);
  blocks.forEach((b, i) => out.set(b, i * BLOCK));
  return out;
}

/** 服务端用私钥加密、我们用公钥指数还原；去填充规则与参考实现一致：跳过首字节，取第一个 0 之后的内容。 */
function rsaDecrypt(input: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let off = 0; off < input.length; off += BLOCK) {
    const block = input.subarray(off, Math.min(off + BLOCK, input.length));
    const raw = bigIntToBytes(modPowPublic(bytesToBigInt(block)), BLOCK);
    // 参考实现对 big.Int 字节（已去前导零）做搜索：等价于先跳过前导零再从第 1 个字节起找 0。
    let start = 0;
    while (start < raw.length && raw[start] === 0) start++;
    const zero = raw.indexOf(0, start + 1);
    if (zero < 0) throw new Error("m115 解密失败：填充不合法");
    parts.push(raw.subarray(zero + 1));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** 随机字节（QuickJS 没有 crypto；密钥只用于遮蔽传输内容，不承担安全边界）。 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** 编码请求载荷。`pad(i)` 为 RSA 填充第 i 个字节的随机源（每个 RSA 块从 0 起；测试注入定值）。 */
export function m115Encode(input: Uint8Array, key: Uint8Array, pad: (index: number) => number = () => Math.floor(Math.random() * 256)): string {
  if (key.length !== KEY_SIZE) throw new Error("m115 密钥长度必须是 16 字节");
  const buf = new Uint8Array(KEY_SIZE + input.length);
  buf.set(key);
  buf.set(input, KEY_SIZE);
  const body = buf.subarray(KEY_SIZE);
  xorTransform(body, deriveKey(key, 4));
  body.reverse();
  xorTransform(body, XOR_CLIENT_KEY);
  return base64Encode(rsaEncrypt(buf, pad));
}

/** 解码响应载荷；`key` 是编码该请求时用的密钥。 */
export function m115Decode(text: string, key: Uint8Array): Uint8Array {
  const data = rsaDecrypt(base64Decode(text));
  if (data.length < KEY_SIZE) throw new Error("m115 解密失败：数据过短");
  const out = data.slice(KEY_SIZE);
  xorTransform(out, deriveKey(data.subarray(0, KEY_SIZE), 12));
  out.reverse();
  xorTransform(out, deriveKey(key, 4));
  return out;
}
