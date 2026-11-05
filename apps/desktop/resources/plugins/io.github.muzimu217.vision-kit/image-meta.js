/**
 * image-meta.js — 纯 JS 图片头部解析（无依赖、无解码）。
 * 从文件头部字节提取格式与尺寸，供 image_info / list_images 使用。
 * 全部函数为纯函数：输入 Uint8Array/number，输出可序列化值，可离线单测。
 */
"use strict";

/** 从头部字节嗅探 MIME（魔数优先，扩展名兜底由调用方处理）。 */
function sniffMime(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

/** PNG：IHDR 宽高在固定偏移 16/20（大端 u32）。 */
function pngSize(b) {
  if (b.length < 24) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** GIF：逻辑屏幕尺寸在偏移 6/8（小端 u16）。 */
function gifSize(b) {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** JPEG：扫描 SOF0/SOF1/SOF2 段取宽高（段长最多探 256KB）。 */
function jpegSize(b) {
  let o = 2;
  const limit = Math.min(b.length, 256 * 1024);
  while (o + 9 < limit) {
    if (b[o] !== 0xff) { o += 1; continue; }
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
    const segLen = u16be(b, o + 2);
    if (segLen < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 9 > b.length) return null;
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + segLen;
  }
  return null;
}

/** WEBP：VP8（lossy）/VP8L（lossless）/VP8X（extended）三种子块。 */
function webpSize(b) {
  if (b.length < 30) return null;
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8 ") {
    // 帧头后 6 字节为帧 tag，随后 3 字节起始码，再 4 字节：宽高各 14 位小端交织
    if (b.length < 30) return null;
    const w = u16le(b, 26) & 0x3fff;
    const h = u16le(b, 28) & 0x3fff;
    return { width: w, height: h };
  }
  if (fourcc === "VP8X") {
    // 24 位画布尺寸-1（小端）：偏移 24 宽、27 高
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (fourcc === "VP8L") {
    // 位流：偏移 21 起 14 位宽-1、14 位高-1
    const o = 21;
    if (b.length < o + 4) return null;
    const bits = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** 统一入口：返回 { mimeType, width, height } 或 null（无法识别）。 */
function probeImage(bytes) {
  const mimeType = sniffMime(bytes);
  if (!mimeType) return null;
  let size = null;
  if (mimeType === "image/png") size = pngSize(bytes);
  else if (mimeType === "image/gif") size = gifSize(bytes);
  else if (mimeType === "image/jpeg") size = jpegSize(bytes);
  else if (mimeType === "image/webp") size = webpSize(bytes);
  return {
    mimeType,
    width: size && size.width > 0 ? size.width : null,
    height: size && size.height > 0 ? size.height : null,
  };
}

module.exports = { sniffMime, pngSize, gifSize, jpegSize, webpSize, probeImage };
