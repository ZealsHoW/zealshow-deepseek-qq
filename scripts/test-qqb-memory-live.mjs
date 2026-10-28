// scripts/test-qqb-memory-live.mjs —— 长期记忆接线层（qqb/memory/live.mjs）的回归测试。
// 覆盖：分层映射与隔离、去重合并、群友印象删除、清空会话、坏库降级不抛错、注入块长度上限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VERSION, canonicalScope, createLiveMemory, layerForKey, layersForSession } from '../src/qqb/memory/live.mjs';

const OWNER = '1000000001';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-live-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

function live(root, extra = {}) {
  return createLiveMemory({ root, ownerQQOf: () => OWNER, ...extra });
}

test('分层映射：群聊 group / 主人私聊 private / 其它私聊 normal，key 去前导零', () => {
  assert.equal(VERSION, '0.4.1');
  assert.equal(canonicalScope('group:0900000001'), 'group:900000001');
  assert.equal(canonicalScope('private:01000000001'), 'private:1000000001');
  assert.equal(layerForKey('group:900000001', OWNER), 'group');
  assert.equal(layerForKey('private:1000000001', OWNER), 'private');
  assert.equal(layerForKey('private:1000000003', OWNER), 'normal');
  assert.equal(layerForKey('奇怪的key', OWNER), 'normal');
  assert.deepEqual(layersForSession('private:1000000001', OWNER), ['private', 'normal']);
  assert.deepEqual(layersForSession('private:1000000003', OWNER), ['normal']);
  assert.deepEqual(layersForSession('group:900000001', OWNER), ['group']);
});

test('写入后可召回；合并同一条事实；群聊记忆不会漏进私聊', () => {
  const root = tempRoot();
  const mem = live(root);
  const first = mem.rememberSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '爸爸说明天带我去吃火锅' });
  assert.equal(first.action, 'inserted');
  const again = mem.rememberSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '  爸爸说明天带我去吃火锅  ' });
  assert.equal(again.action, 'merged');
  assert.equal(again.id, first.id);

  const groupBlock = mem.block({ key: 'group:900000001' });
  assert.match(groupBlock, /记得的事/);
  assert.match(groupBlock, /火锅/);

  // 别的私聊（normal 层）看不到群聊记忆
  assert.equal(mem.block({ key: 'private:1000000003' }), '');
  // 主人私聊也看不到 group 层
  assert.equal(mem.block({ key: 'private:1000000001' }), '');
  mem.close();
});

test('主人私聊记忆只在自己的会话里可见（private 层不外泄）', () => {
  const root = tempRoot();
  const mem = live(root);
  mem.rememberSocialEvent({ key: 'private:1000000001', category: 'memberImpression', content: '爱吃辣', extra: { target: '妈妈' } });
  const ownerBlock = mem.block({ key: 'private:1000000001' });
  assert.match(ownerBlock, /印象/);
  assert.match(ownerBlock, /爱吃辣/);
  assert.equal(mem.block({ key: 'group:900000001' }), '');
  assert.equal(mem.block({ key: 'private:1000000003' }), '');
  mem.close();
});

test('跨会话检索：默认注入仍隔离，recallAcrossScopes 能查全库并带来源', () => {
  const root = tempRoot();
  const mem = live(root);
  mem.rememberSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '在聊期末考试' });
  mem.rememberSocialEvent({ key: 'private:1000000001', category: 'promise', content: '周末陪爸爸去看球' });
  mem.rememberSocialEvent({ key: 'private:1000000003', category: 'activeTopic', content: '朋友在准备考试' });

  // 默认注入仍然按会话隔离：群里那块记忆不会平白出现在别人的私聊里，反之亦然。
  assert.doesNotMatch(mem.block({ key: 'private:1000000003' }), /期末考试|看球/);
  assert.doesNotMatch(mem.block({ key: 'group:900000001' }), /看球|朋友在准备考试/);

  // 她主动检索：跨会话查到「看球」，并标出来源 scope。
  const across = mem.recallAcrossScopes({ query: '看球' });
  assert.equal(across.length, 1);
  assert.equal(across[0].scope, 'private:1000000001');
  assert.match(across[0].text, /看球/);

  // 不带关键词 = 全库最近若干条。
  const all = mem.recallAcrossScopes({ query: '', limit: 10 });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((item) => item.scope).sort(), ['group:900000001', 'private:1000000001', 'private:1000000003']);

  // 坏库时降级成空数组，不抛错。
  mem.close();
  const brokenRoot = tempRoot();
  fs.mkdirSync(path.join(brokenRoot, 'state', 'memory.db'), { recursive: true });
  assert.deepEqual(live(brokenRoot).recallAcrossScopes({ query: '看球' }), []);
});

test('群友印象可以按 target 删除；清空会话只影响该会话', () => {
  const root = tempRoot();
  const mem = live(root);
  mem.rememberSocialEvent({ key: 'group:900000001', category: 'memberImpression', content: '声音很大', extra: { target: '小天才' } });
  mem.rememberSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '在聊期末考试' });
  mem.rememberSocialEvent({ key: 'group:900000002', category: 'activeTopic', content: '另一个群的话题' });

  const removed = mem.forgetSocialEvent({ key: 'group:900000001', category: 'memberImpression', extra: { target: '小天才' } });
  assert.equal(removed, 1);
  const block = mem.block({ key: 'group:900000001' });
  assert.doesNotMatch(block, /声音很大/);
  assert.match(block, /期末考试/);

  const cleared = mem.clearScope('group:900000001');
  assert.ok(cleared >= 1);
  assert.equal(mem.block({ key: 'group:900000001' }), '');
  // 另一个群没被牵连
  assert.match(mem.block({ key: 'group:900000002' }), /另一个群的话题/);
  mem.close();
});

test('注入块有长度上限，内容被截断而不是无限膨胀', () => {
  const root = tempRoot();
  const mem = live(root);
  for (let i = 0; i < 20; i += 1) {
    mem.rememberSocialEvent({
      key: 'group:900000001',
      category: 'activeTopic',
      content: `第${i}条很长的记忆内容`.padEnd(60, '，补充说明'),
    });
  }
  const block = mem.block({ key: 'group:900000001', limit: 10, maxChars: 300 });
  assert.ok(block.length <= 300, `块长度 ${block.length} 超过上限`);
  mem.close();
});

test('记忆库打不开时全部降级：不抛错、返回空、可查询错误原因', () => {
  const root = tempRoot();
  // 用一个同名目录占住 memory.db 的位置，逼 openStore 失败
  fs.mkdirSync(path.join(root, 'state', 'memory.db'), { recursive: true });
  const mem = live(root);
  assert.equal(mem.available(), false);
  assert.ok(mem.error(), '应能读到失败原因');
  assert.equal(mem.rememberSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '写不进去' }), null);
  assert.equal(mem.block({ key: 'group:900000001' }), '');
  assert.equal(mem.forgetSocialEvent({ key: 'group:900000001', category: 'activeTopic', content: '写不进去' }), 0);
  assert.equal(mem.clearScope('group:900000001'), 0);
  assert.equal(mem.stats(), null);
  mem.close();
});

test('并发/连续调用同一个库时不会重复打开（缓存生效）', () => {
  const root = tempRoot();
  const mem = live(root);
  const a = mem.stats();
  const b = mem.stats();
  assert.equal(a.path, b.path);
  assert.equal(mem.stats().total, 0);
  mem.close();
});
test('L2 原文底账：recordOriginal 写得进、召回默认看不见、显式 includeOriginals 才看得到', async () => {
  const root = tempRoot();
  const mem = live(root);
  const key = 'private:' + OWNER;
  // 一条真正的事实 + 三句原始消息
  mem.rememberSocialEvent({ key, category: 'fact', content: '爸爸答应周末带她去看海' });
  mem.recordOriginal({ key, role: 'user', text: '今天好累啊，我先去睡了' });
  mem.recordOriginal({ key, role: 'assistant', text: '那我陪你待一会儿再睡' });
  mem.recordOriginal({ key, role: 'user', text: '嗯' }); // 太短，不该入库

  const hit = mem.recall({ key, query: '去看海', limit: 5 });
  assert.ok(hit.some((row) => row.text.includes('看海')), '事实要召得回来');
  assert.ok(!hit.some((row) => row.kind === 'message'), 'L2 原文不该出现在默认召回里');

  const originals = mem.recall({ key, query: '好累', limit: 5, includeOriginals: true });
  assert.ok(originals.length > 0, '显式要原文时才看得见');
  assert.ok(originals.every((row) => row.kind === 'message'), '这一段只有原文');

  const recent = mem.recall({ key, query: '', limit: 20 });
  assert.ok(!recent.some((row) => row.kind === 'message'), '不带关键词的召回也不该吐原文');
  mem.close();
});