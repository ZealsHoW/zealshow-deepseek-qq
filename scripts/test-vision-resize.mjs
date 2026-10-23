// 测试视觉输入预处理：长边 >1280 的图应被缩小，小图/非图片原样返回
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { DEFAULT_MAX_SIDE, imageSize, normalizeImageForVision } from '../src/qqb/media/resize.mjs';

// 造一张 w×h 的 PNG：左半红、右半蓝
function makePng(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const left = x < width / 2;
      png.data[i] = left ? 255 : 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = left ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const asBase64 = (buf) => buf.toString('base64');

const big = makePng(2000, 1000);
assert.deepEqual(imageSize(big), { format: 'png', width: 2000, height: 1000 });

const shrunk = normalizeImageForVision(asBase64(big));
assert.equal(shrunk.resized, true);
assert.equal(shrunk.width, 1280);
assert.equal(shrunk.height, 640);
assert.equal(shrunk.originalWidth, 2000);
assert.match(shrunk.note, /2000x1000 → 1280x640/);
// 输出本身是可解码图片，且两端颜色保持（内容没搞丢）
const outBuffer = Buffer.from(shrunk.base64, 'base64');
assert.deepEqual(imageSize(outBuffer), { format: 'png', width: 1280, height: 640 });
const decoded = PNG.sync.read(outBuffer);
const at = (x, y) => {
  const i = (decoded.width * y + x) << 2;
  return { r: decoded.data[i], g: decoded.data[i + 1], b: decoded.data[i + 2] };
};
const left = at(20, 20);
const right = at(decoded.width - 20, 20);
assert.ok(left.r > 150 && left.b < 100, '左侧应仍偏红');
assert.ok(right.b > 150 && right.r < 100, '右侧应仍偏蓝');
console.log('✅ 2000x1000 → 1280x640，颜色保持');

const small = normalizeImageForVision(asBase64(makePng(800, 600)));
assert.equal(small.resized, false);
assert.equal(small.width, 800);
console.log('✅ 800x600 小图原样返回');

const square = normalizeImageForVision(asBase64(makePng(1600, 1600)));
assert.deepEqual([square.width, square.height], [1280, 1280]);
console.log('✅ 1600x1600 → 1280x1280');

const custom = normalizeImageForVision(asBase64(big), { maxSide: 500 });
assert.deepEqual([custom.width, custom.height], [500, 250]);
console.log('✅ maxSide 可配置');

// 非图片字节 / 空值：不抛错，原样返回
const garbage = Buffer.from('not an image at all');
const pass = normalizeImageForVision(asBase64(garbage));
assert.equal(pass.resized, false);
assert.match(pass.note, /无法识别/);
assert.equal(normalizeImageForVision('').resized, false);
console.log('✅ 非图片/空输入安全返回');

// GIF 表情包：认识尺寸但暂不缩放，原样交回
const gif = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x40, 0x01, 0xf0, 0x00]), // 320x240
  Buffer.alloc(8)
]);
assert.deepEqual(imageSize(gif), { format: 'gif', width: 320, height: 240 });
const gifResult = normalizeImageForVision(asBase64(gif));
assert.equal(gifResult.resized, false);
console.log('✅ GIF 不缩放（原样返回）');

// 默认上限就是 1280
assert.equal(DEFAULT_MAX_SIDE, 1280);
console.log('\n全部通过');
