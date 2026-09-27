'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accessibleNames } = require('../src/accessible-names');
const app = require('../src/app');

test('目标元素：button/a[href]/非 hidden input/select/textarea/带 role 元素', () => {
  const r = accessibleNames(`
    <a>无 href</a>
    <a href="/x">链接</a>
    <button>按钮</button>
    <input type="hidden" name="secret">
    <input type="text" aria-label="文本框">
    <select aria-label="下拉"></select>
    <textarea aria-label="多行"></textarea>
    <div role="button">自定义</div>
    <div role="">空 role</div>
    <div>普通 div</div>
  `);
  assert.deepEqual(
    r.elements.map((e) => e.tag),
    ['a', 'button', 'input', 'select', 'textarea', 'div']
  );
  assert.deepEqual(
    r.elements.map((e) => e.dom),
    [1, 2, 3, 4, 5, 6]
  );
});

test('优先级：aria-labelledby > aria-label > label > 自身文本', () => {
  const r = accessibleNames(`
    <span id="t1">来自引用</span>
    <button id="b1" aria-labelledby="t1" aria-label="标签">文本</button>
    <button id="b2" aria-label="  带  空白  ">文本</button>
    <label for="i1">用户名</label>
    <input id="i1">
    <button id="b4">  提交
    订单 </button>
  `);
  assert.deepEqual(
    r.elements.map((e) => [e.id, e.name, e.source]),
    [
      ['b1', '来自引用', 'aria-labelledby'],
      ['b2', '带 空白', 'aria-label'],
      ['i1', '用户名', 'label'],
      ['b4', '提交 订单', 'content'],
    ]
  );
  assert.equal(r.count.issues, 0);
});

test('aria-labelledby：多令牌按顺序拼接，统一折叠空白', () => {
  const r = accessibleNames(`
    <span id="a">  姓氏
    某  </span>
    <span id="b">名字</span>
    <input aria-labelledby="b a">
  `);
  assert.equal(r.elements[0].name, '名字 姓氏 某');
  assert.equal(r.elements[0].source, 'aria-labelledby');
});

test('aria-labelledby：递归展开被引用元素自身的 aria-labelledby', () => {
  const r = accessibleNames(`
    <span id="x" aria-labelledby="y">这段文本被忽略</span>
    <span id="y">最终文本</span>
    <button aria-labelledby="x">按钮文本</button>
  `);
  assert.equal(r.elements[0].name, '最终文本');
  assert.equal(r.elements[0].source, 'aria-labelledby');
  assert.equal(r.count.issues, 0);
});

test('缺失引用：记 MISSING_REFERENCE，并回退到 aria-label', () => {
  const r = accessibleNames(`
    <button id="btn" aria-labelledby="ghost" aria-label="回退标签">x</button>
    <input id="inp" aria-labelledby="ghost also-ghost">
  `);
  const missing = r.issues.filter((i) => i.type === 'MISSING_REFERENCE');
  assert.deepEqual(
    missing.map((i) => [i.dom, i.refId]),
    [
      [1, 'ghost'],
      [2, 'also-ghost'],
      [2, 'ghost'],
    ]
  );
  assert.equal(r.elements[0].name, '回退标签');
  assert.equal(r.elements[0].source, 'aria-label');
  // 第二个元素全部引用缺失且没有其他来源 -> UNNAMED
  assert.equal(r.elements[1].name, '');
  assert.equal(r.elements[1].source, null);
  assert.ok(r.issues.some((i) => i.type === 'UNNAMED' && i.dom === 2));
});

test('循环引用：互相引用与自引用都记 CIRCULAR_REFERENCE 并回退', () => {
  const r = accessibleNames(`
    <span id="c1" aria-labelledby="c2">甲</span>
    <span id="c2" aria-labelledby="c1">乙</span>
    <button id="self" aria-labelledby="self">自引用</button>
    <div role="button" aria-labelledby="c1" aria-label="兜底">x</div>
  `);
  const cycles = r.issues.filter((i) => i.type === 'CIRCULAR_REFERENCE');
  assert.deepEqual(
    cycles.map((i) => [i.dom, i.chain]),
    [
      [1, ['self', 'self']],
      [2, ['c1', 'c2', 'c1']],
    ]
  );
  // 循环后回退：button 取自身文本，div 取 aria-label
  assert.deepEqual(
    r.elements.map((e) => [e.name, e.source]),
    [
      ['自引用', 'content'],
      ['兜底', 'aria-label'],
    ]
  );
});

test('label：for 关联、包裹关联，文档序最靠前者优先', () => {
  const r = accessibleNames(`
    <label for="q">搜索</label>
    <input id="q">
    <label>邮箱 <input id="mail" type="email"></label>
    <label>城市 <select id="city"><option>北京</option></select></label>
    <label>包裹优先 <input id="dup"></label>
    <label for="dup">后面的 for 标签</label>
    <label for="first">先出现的 for</label>
    <label>后出现的包裹 <input id="first"></label>
  `);
  assert.deepEqual(
    r.elements.map((e) => [e.id, e.name, e.source]),
    [
      ['q', '搜索', 'label'],
      ['mail', '邮箱', 'label'],
      ['city', '城市', 'label'], // select 子树的 option 文本被剔除
      ['dup', '包裹优先', 'label'], // 包裹 label 文档序更靠前
      ['first', '先出现的 for', 'label'], // for label 文档序更靠前
    ]
  );
});

test('label 的 for 指向别处时不标记包裹的控件', () => {
  const r = accessibleNames(`
    <label for="other">给别人 <input id="mine"></label>
    <input id="other" aria-label="别人">
  `);
  // mine 的包裹 label for 指向 other -> 不算数，mine 无名称
  assert.equal(r.elements[0].id, 'mine');
  assert.equal(r.elements[0].source, null);
  assert.ok(r.issues.some((i) => i.type === 'UNNAMED' && i.dom === 1));
  assert.equal(r.elements[1].name, '别人');
});

test('role 元素参与命名；无名称元素记 UNNAMED 且 source 为 null', () => {
  const r = accessibleNames(`
    <div role="button">自定义按钮</div>
    <span role="switch" aria-checked="true">开关</span>
    <input id="bare">
    <button></button>
  `);
  assert.deepEqual(
    r.elements.map((e) => [e.tag, e.name, e.source]),
    [
      ['div', '自定义按钮', 'content'],
      ['span', '开关', 'content'],
      ['input', '', null],
      ['button', '', null],
    ]
  );
  assert.deepEqual(
    r.issues.map((i) => [i.type, i.dom]),
    [
      ['UNNAMED', 3],
      ['UNNAMED', 4],
    ]
  );
  assert.equal(r.count.named, 2);
  assert.equal(r.count.unnamed, 2);
});

test('元素带定位信息；a 带 href；input/button 带 type', () => {
  const r = accessibleNames('<a href="/help" id="h">帮助</a>\n<button type="submit">提交</button>');
  const [a, btn] = r.elements;
  assert.equal(a.href, '/help');
  assert.equal(a.id, 'h');
  assert.equal(a.location.line, 1);
  assert.equal(btn.type, 'submit');
  assert.equal(btn.location.line, 2);
});

test('script/style 的文本不进入名称', () => {
  const r = accessibleNames(`
    <button>确定<script>var x = 1;</script><style>.a{}</style></button>
    <label for="s">搜索<style>.b{}</style></label>
    <input id="s">
  `);
  assert.equal(r.elements[0].name, '确定');
  assert.equal(r.elements[1].name, '搜索');
});

test('空片段安全处理', () => {
  const r = accessibleNames('');
  assert.deepEqual(r.elements, []);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.count, { elements: 0, named: 0, unnamed: 0, issues: 0 });
});

test('HTTP：POST /accessible-names 支持 text/html 与 JSON，坏请求 400', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // text/html 原始片段
  let res = await fetch(`${base}/accessible-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: '<label for="e">邮箱</label><input id="e"><button>提交</button>',
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.deepEqual(
    body.elements.map((e) => [e.name, e.source]),
    [
      ['邮箱', 'label'],
      ['提交', 'content'],
    ]
  );

  // JSON { html }
  res = await fetch(`${base}/accessible-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<div role="tab" aria-label="页签"></div>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.elements[0].name, '页签');
  assert.equal(body.elements[0].role, 'tab');

  // 无法解析的请求体 -> 400
  res = await fetch(`${base}/accessible-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
  body = await res.json();
  assert.equal(body.error, 'BAD_REQUEST');

  // /audit 在重构后仍正常
  res = await fetch(`${base}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: '<button>ok</button>',
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.tabOrder.length, 1);
});
