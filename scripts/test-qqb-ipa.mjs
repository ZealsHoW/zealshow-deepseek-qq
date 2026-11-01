// 形象参考（IPAdapter）与人头计数（2026-11-01 主人：连几个人都分不清楚，也没有她的形象）
import fs from 'node:fs';
import {
  DEFAULT_IPA_WEIGHT,
  DEFAULT_LORA,
  DEFAULT_REFERENCE,
  GROUP_IPA_WEIGHT,
  countPeople,
  mergeGroupNegative,
} from '../src/qqb/media/comfy.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const comfy = fs.readFileSync(new URL('../src/qqb/media/comfy.mjs', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');

console.log('形象参考（IPAdapter）：');
{
  eq('默认 LoRA 是 v4（v2 出来偏成熟、线条糊）', DEFAULT_LORA, 'xiaojing_sdxl_lora_v4.safetensors');
  ok('默认参考图指着 assets/xiaojing-ref.jpg', DEFAULT_REFERENCE.endsWith('xiaojing-ref.jpg'), DEFAULT_REFERENCE);
  ok('参考图真的在（不然静默退回纯 LoRA）', fs.existsSync(DEFAULT_REFERENCE) && fs.statSync(DEFAULT_REFERENCE).size > 50_000);
  eq('单人参考强度 0.7', DEFAULT_IPA_WEIGHT, 0.7);
  eq('多人参考压到 0.45', GROUP_IPA_WEIGHT, 0.45);

  ok('组合图里有 IPAdapter 三件套（LoadImage / UnifiedLoader / IPAdapter）',
    comfy.includes("class_type: 'LoadImage'") && comfy.includes("class_type: 'IPAdapterUnifiedLoader'") && comfy.includes("class_type: 'IPAdapter'"));
  ok('SDXL 用 PLUS (high strength) 预设', comfy.includes("preset: 'PLUS (high strength)'"));
  ok('挂了参考就从 IPAdapter 出来的 MODEL 上采样', comfy.includes("model: [refName ? '11' : '2', 0]"));
  ok('多人时切 prompt is more important（否则两人被带成同一套衣服）',
    comfy.includes("weight_type: people > 1 ? 'prompt is more important' : 'standard'"));
  ok('没装 IPAdapter 也不报错，只记日志', comfy.includes('画图：ComfyUI 里没装 IPAdapter，这次只挂 LoRA'));
  ok('参考图自动拷进 ComfyUI input（同名同大小就跳过）',
    comfy.includes('function ensureComfyInput(') && comfy.includes('fs.copyFileSync(src, dst)'));
  ok('探 IPAdapter 只探一次（装节点要重启 ComfyUI）', comfy.includes('if (ipaState !== null) return ipaState;'));
  ok('返回体带 reference / ipaWeight / people', comfy.includes('reference: refName || null') && comfy.includes('people,'));

  // 人数口径
  eq('1girl, solo 算一个人', countPeople('xiaojing, 1girl, solo, upper body'), 1);
  eq('2girls 算两个人', countPeople('2girls, two friends sitting on a bench'), 2);
  eq('中文「两个女孩」也算', countPeople('两个女孩坐在长椅上'), 2);
  eq('英文 three girls 算三个', countPeople('three girls in a park'), 3);
  eq('没写人数当单人处理', countPeople('a girl in a park'), 0);
  eq('叙事句不算人数（不写标签就是分不清的根因）', countPeople('两个人坐在长椅上聊天'), 2);

  ok('单人负向补 extra person / multiple girls（别凭空多一个人）',
    mergeGroupNegative('lowres', 1).includes('extra person') && mergeGroupNegative('lowres', 1).includes('multiple girls'));
  ok('多人负向补融合词', mergeGroupNegative('lowres', 2).includes('merged bodies') && mergeGroupNegative('lowres', 2).includes('fused faces'));
  ok('多人的负向不加 extra person（那会把她俩打散）', !mergeGroupNegative('lowres', 3).includes('extra person'));
  ok('已经有这条负向词就不重复写', !mergeGroupNegative('merged bodies', 2).includes('merged bodies, merged bodies'));

  // 接线
  ok('桥接把 reference / ipaWeight 传下去',
    bridge.includes('reference: imageCfg.reference === \'\' ? null : (imageCfg.reference || undefined)')
    && bridge.includes('ipaWeight: Number(imageCfg.ipaWeight) > 0'));
  ok('提示词教她「画几个人一定要数清楚」', bridge.includes('画几个人一定要数清楚'));
  ok('提示词提到形象参考（画「我」就是同一个你）', bridge.includes('加一张你的定稿图当形象参考'));
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);