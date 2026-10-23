// 送进本地视觉模型前先把过大的图片缩小。
//
// 为什么需要：Ollama 里 qwen2.5vl:3b 拿到长边 >1280 的图（实测 1536/1920 必现，
// 1280 稳定）会在生成阶段直接返回 `prediction aborted, token repeat limit reached`，
// 整次识图作废。这不是参数能救的——num_ctx 调到 16384、repeat_penalty 1.6、
// 换 /api/chat 都一样失败，但把同一张图缩到 1280 就正常。
// 手机拍的 QQ 图片长边普遍 1440+，所以必须在上游统一缩图。
//
// 依赖只用纯 JS 的 jpeg-js / pngjs（仓库没有 native 依赖，这条约束不能破坏）。
// 其它格式（gif / webp / bmp…）不强行转换：它们要么很小（表情包），要么转换
// 成本/失真都划不来，保持原样交给模型。
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/** 视觉模型的输入长边上限。超过就先缩小，避免 Ollama 的复读中断。 */
export const DEFAULT_MAX_SIDE = 1280;

/** 按文件头判断格式（不解码）。 */
export function sniffImageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** 只读文件头拿宽高，不整张解码。 */
export function imageSize(buf) {
  const format = sniffImageFormat(buf);
  if (format === 'png') {
    if (buf.length < 24) return null;
    return { format, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (format === 'gif') {
    if (buf.length < 10) return null;
    return { format, width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (format === 'jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15，跳过 DHT(C4)/JPG(C8)/DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format, width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 双线性缩放（RGBA）。图片缩放本身不值得引入大库，几十行够了。 */
function bilinearResize(src, sw, sh, dw, dh) {
  const dst = Buffer.allocUnsafe(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    const row0 = y0 * sw;
    const row1 = y1 * sw;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      const a = (row0 + x0) * 4;
      const b = (row0 + x1) * 4;
      const c = (row1 + x0) * 4;
      const d = (row1 + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 4; k += 1) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * wx;
        const bottom = src[c + k] + (src[d + k] - src[c + k]) * wx;
        dst[o + k] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return dst;
}

function scaleToFit(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return null;
  const ratio = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

/**
 * 把 base64 图片缩到长边 ≤ maxSide。
 * 返回 { base64, format, width, height, resized, originalWidth, originalHeight, note? }。
 * 格式不支持 / 本来就够小 / 解码失败时原样返回（resized=false），绝不抛错。
 */
export function normalizeImageForVision(base64, { maxSide = DEFAULT_MAX_SIDE } = {}) {
  const raw = Buffer.from(String(base64 || ''), 'base64');
  const size = imageSize(raw);
  const fail = (note) => ({
    base64,
    format: size?.format ?? sniffImageFormat(raw),
    width: size?.width ?? null,
    height: size?.height ?? null,
    resized: false,
    originalWidth: size?.width ?? null,
    originalHeight: size?.height ?? null,
    note
  });
  if (!size) return fail('无法识别图片尺寸，按原图发送');
  const target = scaleToFit(size.width, size.height, maxSide);
  if (!target) {
    return {
      base64,
      format: size.format,
      width: size.width,
      height: size.height,
      resized: false,
      originalWidth: size.width,
      originalHeight: size.height,
      note: null
    };
  }
  try {
    let rgba;
    let out;
    let outFormat;
    if (size.format === 'jpeg') {
      rgba = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
      out = bilinearResize(Buffer.from(rgba.data), rgba.width, rgba.height, target.width, target.height);
      outFormat = 'jpeg';
    } else if (size.format === 'png') {
      const png = PNG.sync.read(raw);
      out = bilinearResize(png.data, png.width, png.height, target.width, target.height);
      outFormat = 'png';
    } else {
      return fail(`暂不缩放 ${size.format} 图片（长边 ${size.width}），按原图发送`);
    }
    const encoded = outFormat === 'jpeg'
      ? jpeg.encode({ data: out, width: target.width, height: target.height }, 88).data
      : PNG.sync.write({ width: target.width, height: target.height, data: out }, { colorType: 6 });
    return {
      base64: Buffer.from(encoded).toString('base64'),
      format: outFormat,
      width: target.width,
      height: target.height,
      resized: true,
      originalWidth: size.width,
      originalHeight: size.height,
      note: `${size.width}x${size.height} → ${target.width}x${target.height}`
    };
  } catch (error) {
    return fail(`缩放失败（${error?.message ?? error}），按原图发送`);
  }
}
