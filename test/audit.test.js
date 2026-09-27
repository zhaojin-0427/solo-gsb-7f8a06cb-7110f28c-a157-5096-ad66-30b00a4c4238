'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditHtml } = require('../src/audit');

test('候选元素：只收集 a[href]/button/非 hidden input/select/textarea/显式 tabindex', () => {
  const r = auditHtml(`
    <a>无 href</a>
    <a href="/x">链接</a>
    <button>按钮</button>
    <input type="hidden" name="secret">
    <input type="text">
    <input type="checkbox">
    <select><option>1</option></select>
    <textarea></textarea>
    <div tabindex="0">可聚焦 div</div>
    <div>普通 div</div>
  `);
  assert.deepEqual(
    r.tabOrder.map((e) => e.tag),
    ['a', 'button', 'input', 'input', 'select', 'textarea', 'div']
  );
  assert.equal(r.count.risks, 0);
});

test('Tab 顺序：正 tabindex 升序，同值按文档序，再排 0 与默认控件', () => {
  const r = auditHtml(`
    <button id="b1">1</button>
    <div id="p5" tabindex="5">5</div>
    <button id="b2">2</button>
    <div id="p2a" tabindex="2">2a</div>
    <input id="zero" tabindex="0">
    <div id="p2b" tabindex="2">2b</div>
    <a href="#" id="link">link</a>
    <div id="p1" tabindex="1">1</div>
  `);
  // tabindex=0 与默认控件统一按文档序排列（DOM 顺序 b1 < b2 < zero < link）
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['p1', 'p2a', 'p2b', 'p5', 'b1', 'b2', 'zero', 'link']);
  assert.deepEqual(r.tabOrder.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('负 tabindex 跳过（不参与 Tab 顺序，但列入 skipped）', () => {
  const r = auditHtml(`
    <button id="b">默认</button>
    <input id="neg" tabindex="-1">
    <div id="neg2" tabindex="-99">
      <a href="#" id="inside">嵌套链接</a>
    </div>
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['b', 'inside']);
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ['neg', 'neg2']);
  assert.ok(r.skipped.every((s) => s.reason === 'negative-tabindex'));
});

test('排除：祖先或自身 hidden、inert、display:none、visibility:hidden、disabled', () => {
  const r = auditHtml(`
    <div hidden><button id="inHidden">x</button></div>
    <div inert><a href="#" id="inInert">x</a></div>
    <div style="display:none"><input id="inDisplayNone"></div>
    <div style="visibility:hidden"><select id="inVisHidden"></select></div>
    <button id="selfHidden" hidden>x</button>
    <input id="selfInert" inert>
    <a href="#" id="selfDisplay" style="display:inline; display:none">x</a>
    <textarea style="VISIBILITY : HIDDEN" id="selfVis"></textarea>
    <button disabled id="disabledBtn">x</button>
    <input type="text" disabled id="disabledInput">
    <select disabled id="disabledSelect"></select>
    <textarea disabled id="disabledTa"></textarea>
    <button id="ok">可见</button>
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['ok']);
  assert.equal(r.count.risks, 0);
});

test('排除 hidden input，但普通 input 的其他 type 仍入序', () => {
  const r = auditHtml(`
    <input type="hidden" name="h">
    <input type="HIDDEN" name="h2">
    <input type="text" name="t">
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.name), ['t']);
});

test('radio 按最近 form（无则文档根）与 name 分组，未选中取首个可用项', () => {
  const r = auditHtml(`
    <form id="f1">
      <input type="radio" name="g" id="a">
      <input type="radio" name="g" id="b" checked>
      <input type="radio" name="h" id="c">
      <input type="radio" name="h" id="d">
    </form>
    <form id="f2">
      <input type="radio" name="g" id="e">
      <input type="radio" name="g" id="f" checked>
    </form>
    <input type="radio" name="g" id="g-root">
    <input type="radio" id="noName1">
    <input type="radio" id="noName2" checked>
  `);
  assert.deepEqual(
    r.tabOrder.map((e) => e.id),
    ['b', 'c', 'f', 'g-root', 'noName1', 'noName2']
  );
  assert.deepEqual(r.tabOrder.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);

  const repB = r.tabOrder[0];
  assert.deepEqual(repB.radioGroup, { name: 'g', size: 2, checked: true });
  const repC = r.tabOrder[1];
  assert.deepEqual(repC.radioGroup, { name: 'h', size: 2, checked: false });

  const skippedNames = r.skipped.filter((s) => s.reason === 'radio-group').map((s) => s.id).sort();
  assert.deepEqual(skippedNames, ['a', 'd', 'e']);
});

test('radio 多个 checked 时最后一个 checked 入序', () => {
  const r = auditHtml(`
    <input type="radio" name="g" id="a" checked>
    <input type="radio" name="g" id="b">
    <input type="radio" name="g" id="c" checked>
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['c']);
  assert.equal(r.tabOrder[0].checked, true);
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ['a', 'b']);
});

test('radio 组内 disabled 成员被排除，不作为代表', () => {
  const r = auditHtml(`
    <input type="radio" name="g" id="a" disabled>
    <input type="radio" name="g" id="b">
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['b']);
  assert.equal(r.tabOrder[0].radioGroup.size, 1);
  assert.equal(r.skipped.length, 0);
});

test('风险：aria-hidden=true 下可 Tab 到', () => {
  const r = auditHtml(`
    <div aria-hidden="true">
      <button id="bad1">x</button>
      <a href="#" id="bad2">x</a>
      <input id="neg" tabindex="-1">
    </div>
    <button id="ok">x</button>
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['bad1', 'bad2', 'ok']);
  assert.deepEqual(
    r.risks.map((x) => x.id),
    ['bad1', 'bad2']
  );
  assert.ok(r.risks.every((x) => x.type === 'FOCUSABLE_IN_ARIA_HIDDEN'));
  // 风险带上 Tab 序号
  assert.equal(r.risks[0].seq, 1);
  assert.equal(r.risks[1].seq, 2);
});

test('aria-hidden 自身显式声明优先于祖先', () => {
  const r = auditHtml(`
    <div aria-hidden="true">
      <button aria-hidden="false" id="revealed">x</button>
      <button id="stillHidden">x</button>
    </div>
  `);
  assert.deepEqual(r.risks.map((x) => x.id), ['stillHidden']);
});

test('非法 tabindex 报风险（带 dom 序号）；非原生元素因此不可聚焦', () => {
  const r = auditHtml(`
    <div id="g1" tabindex="abc">x</div>
    <button id="b1" tabindex="">x</button>
    <div id="g2" tabindex="1.5">x</div>
    <div id="g3" tabindex="2">x</div>
    <button id="b2" tabindex="+1">x</button>
  `);
  // g1/g2 不可聚焦；b1 原生控件忽略非法值按默认入序；g3=2 在前；b2 +1 非法按默认
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['g3', 'b1', 'b2']);
  const invalid = r.risks.filter((x) => x.type === 'INVALID_TABINDEX');
  assert.deepEqual(invalid.map((x) => x.id).sort(), ['b1', 'b2', 'g1', 'g2']);
  assert.ok(invalid.every((x) => typeof x.dom === 'number'));
  // 入序元素同时给 seq
  assert.equal(invalid.find((x) => x.id === 'b1').seq, 2);
  assert.equal(invalid.find((x) => x.id === 'b2').seq, 3);
  assert.deepEqual(
    r.skipped.map((s) => s.id).sort(),
    ['g1', 'g2']
  );
});

test('dom 序号按文档序从 1 起，seq 是 Tab 序序号', () => {
  const r = auditHtml(`
    <button id="b">b</button>
    <button id="a" tabindex="1">a</button>
  `);
  assert.deepEqual(
    r.tabOrder.map((e) => [e.id, e.dom, e.seq]),
    [
      ['a', 2, 1],
      ['b', 1, 2],
    ]
  );
});

test('空片段安全处理', () => {
  const r = auditHtml('');
  assert.deepEqual(r.tabOrder, []);
  assert.deepEqual(r.risks, []);
  assert.equal(r.count.candidates, 0);
});

test('radio 代表参与 tabindex 排序，非代表 radio 的正 tabindex 不产生额外入序', () => {
  const r = auditHtml(`
    <input type="radio" name="g" id="a" tabindex="3">
    <input type="radio" name="g" id="b" tabindex="3" checked>
    <button tabindex="1" id="p1">p1</button>
  `);
  assert.deepEqual(r.tabOrder.map((e) => e.id), ['p1', 'b']);
  // a 以 radio-group 原因跳过，而不是以 negative/其他原因
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].id, 'a');
  assert.equal(r.skipped[0].reason, 'radio-group');
});

test('负 tabindex 的 radio 代表仍被跳过', () => {
  const r = auditHtml(`
    <input type="radio" name="g" id="a" tabindex="-1">
    <input type="radio" name="g" id="b">
  `);
  // 无 checked -> 代表 a，但 a 是负 tabindex，跳过；b 以 radio-group 跳过
  assert.deepEqual(r.tabOrder.map((e) => e.id), []);
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]).sort(), [
    ['a', 'negative-tabindex'],
    ['b', 'radio-group'],
  ]);
});

test('元素定位信息与描述文本', () => {
  const r = auditHtml('<button id="go">  提交\n订单 </button>');
  const e = r.tabOrder[0];
  assert.equal(e.text, '提交 订单');
  assert.ok(e.location.line >= 1);
  assert.ok(e.location.column >= 1);
});
