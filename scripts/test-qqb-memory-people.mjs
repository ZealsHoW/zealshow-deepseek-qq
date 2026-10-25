// scripts/test-qqb-memory-people.mjs —— 人名簿（qqb/memory/people.mjs）的回归测试。
//
// 人名簿只负责「private:123 → 小祀」这一层标签：跨会话检索结果里要能说出「这是谁那边的事」。
// 它不参与准入判断（准入门槛仍然只看 config.allow），所以这里也测「坏文件不抛错」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPeopleDirectory } from '../src/qqb/memory/people.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-people-'));
  return path.join(dir, 'state', 'memory-people.json');
}

test('人名簿：标签格式与未知会话兜底', () => {
  const people = createPeopleDirectory({ now: () => 1790000000000 });
  assert.equal(people.label(''), '不认识的人');
  // 还没记过名字时，至少说出这是私聊/群聊 + scope，而不是一串裸数字。
  assert.equal(people.label('private:2998647358'), '私聊 private:2998647358');
  assert.equal(people.label('group:851489980'), '群聊 group:851489980');

  assert.equal(people.remember('private:2998647358', '小祀'), true);
  assert.equal(people.label('private:2998647358'), '小祀（私聊 private:2998647358）');
  assert.equal(people.nameOf('private:2998647358'), '小祀');
  assert.equal(people.nameOf('private:404'), '', '没记过就是空串，不要编名字');
  assert.equal(people.get('private:2998647358').kind, 'private');
  assert.equal(people.size(), 1);
});

test('人名簿：不收没信息量的名字（空/纯数字/未知），重复记同名不写盘', () => {
  const people = createPeopleDirectory({ now: () => 1790000000000 });
  assert.equal(people.remember('private:1000000001', ''), false);
  assert.equal(people.remember('private:1000000001', '   '), false);
  assert.equal(people.remember('private:1000000001', '1000000001'), false, 'QQ 号当名字没有信息量');
  assert.equal(people.remember('private:1000000001', '未知'), false);
  assert.equal(people.remember('', '小鲸'), false, '没有 scope 不记');
  assert.equal(people.size(), 0);

  assert.equal(people.remember('private:1000000001', 'ZealsHoW'), true);
  assert.equal(people.remember('private:1000000001', 'ZealsHoW'), false, '名字没变就不用再写一次');
  assert.equal(people.remember('private:1000000001', '爸爸', { note: 'remark' }), true);
  assert.equal(people.get('private:1000000001').name, '爸爸');
  assert.equal(people.get('private:1000000001').note, 'remark');
});

test('人名簿：group: 开头的 key 自动算群，备注不会丢', () => {
  const people = createPeopleDirectory({ now: () => 1790000000000 });
  people.remember('group:851489980', '大肥鱼之家');
  assert.equal(people.get('group:851489980').kind, 'group');
  assert.equal(people.label('group:851489980'), '大肥鱼之家（群聊 group:851489980）');

  people.remember('private:704183420', 'NdYEsW.', { note: '谢哥哥' });
  // 后续只传名字（私聊来消息时的路径）不能把备注抹掉。
  people.remember('private:704183420', '谢哥哥');
  assert.equal(people.get('private:704183420').note, '谢哥哥');
  assert.equal(people.get('private:704183420').name, '谢哥哥');
});

test('人名簿：落盘后重新打开还在；目录不存在会自动建', () => {
  const filePath = tempFile();
  const first = createPeopleDirectory({ filePath, now: () => 1790000000000 });
  assert.equal(first.remember('private:2998647358', '小祀'), true);
  assert.equal(first.remember('group:851489980', '大肥鱼之家'), true);
  assert.ok(fs.existsSync(filePath), 'tmp+rename 之后文件应当存在');
  assert.equal(first.filePath, filePath);

  const second = createPeopleDirectory({ filePath, now: () => 1790000000001 });
  assert.equal(second.size(), 2);
  assert.equal(second.nameOf('private:2998647358'), '小祀');
  assert.equal(second.label('group:851489980'), '大肥鱼之家（群聊 group:851489980）');
  assert.deepEqual(second.entries().map((item) => item.scope), ['group:851489980', 'private:2998647358']);
});

test('人名簿：文件坏了只 warn 不抛错（当空簿子用，照样能继续记）', () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ 这不是 JSON', 'utf8');
  const warnings = [];
  const people = createPeopleDirectory({ filePath, logger: { warn: (...args) => warnings.push(args.join(' ')) } });
  assert.equal(people.size(), 0);
  assert.equal(people.label('private:2998647358'), '私聊 private:2998647358');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /人名簿读取失败/);
  // 坏文件被一份新内容覆盖后恢复正常。
  assert.equal(people.remember('private:2998647358', '小祀'), true);
  const reopened = createPeopleDirectory({ filePath });
  assert.equal(reopened.nameOf('private:2998647358'), '小祀');
});

test('人名簿：纯内存模式（不给 filePath）也能用，只是不落盘', () => {
  const people = createPeopleDirectory();
  assert.equal(people.remember('private:3250968635', '🍇'), true);
  assert.equal(people.label('private:3250968635'), '🍇（私聊 private:3250968635）');
  assert.equal(people.save(), false);
});