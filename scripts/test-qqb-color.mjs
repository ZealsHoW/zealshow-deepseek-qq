// 颜色口径（2026-10-29 主人：颜色变淡了，要深一点）
import fs from 'node:fs';
import {
  DEFAULT_CFG_BOOST,
  DEFAULT_SATURATION,
  mergeDullNegative,
  withVivid,
} from '../src/qqb/media/comfy.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

console.log('颜色口径：');
{
  eq('默认提色强度 1.12', DEFAULT_SATURATION, 1.12);
  eq('默认抬 cfg 0.8', DEFAULT_CFG_BOOST, 0.8);
  ok('补标签：原来没有就加在末尾', withVivid('1girl, blue hair').includes('saturated colors'));
  ok('补标签：已经写过的不重复加', !withVivid('1girl, vivid colors').includes('vivid colors, vivid colors'));
  ok('负向词合并：压掉发灰的描述', mergeDullNegative('lowres').includes('washed out'));
  ok('负向词合并：原来是空的也能补', mergeDullNegative('').startsWith('washed out'));

  const src = fs.readFileSync(new URL('../src/qqb/media/comfy.mjs', import.meta.url), 'utf8');
  ok('饱和度/cfg 用浮点 clamp（clamp 会把 1.12 圆成 1）',
    src.includes('function clampFloat(') && src.includes('const realSat = clampFloat(saturation'));
  ok('提色走 ffmpeg，失败只记日志不毁图',
    src.includes('function recolor(') && src.includes('画图：提色失败，发原图'));
  ok('提色先写临时文件再改名（不留半张图）', src.includes('.sat.png') && src.includes('fs.renameSync(tmp, file)'));
  ok('vivid:false 就不补标签', src.includes('const wantVivid = vivid !== false;'));

  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  ok('桥接把 vivid/saturation/cfg 从 config 传下去',
    bridge.includes('vivid: imageCfg.vivid !== false') && bridge.includes('saturation: Number(imageCfg.saturation) > 0'));
  ok('202 回执带颜色口径', bridge.includes('saturation: Number(imageCfg.saturation) > 0 ? Number(imageCfg.saturation) : null,'));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);