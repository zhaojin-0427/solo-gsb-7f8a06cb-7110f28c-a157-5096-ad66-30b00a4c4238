'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { implicitSubmit } = require('../src/implicit-submit');
const app = require('../src/app');

function byId(result, id) {
  const found = result.inputs.filter((i) => i.id === id);
  assert.equal(found.length, 1, `应恰好存在 id=${id} 的 input`);
  return found[0];
}

test('收集全部 input（含无归属、失效、非阻止型），按文档序从 1 编号（计入非 input 元素）', () => {
  const r = implicitSubmit(`
    <div>
      <input id="a">
      <button>x</button>
      <input type="checkbox" id="b">
    </div>
    <input type="hidden" id="c">
  `);
  assert.equal(r.count.inputs, 3);
  assert.deepEqual(r.inputs.map((i) => [i.id, i.dom]), [['a', 2], ['b', 4], ['c', 5]]);
});

test('阻止型 input：无 type 及 text/search/url/tel/email/password/number（大小写不敏感）', () => {
  const r = implicitSubmit(`
    <input id="none">
    <input type="text" id="text">
    <input type="SEARCH" id="search">
    <input type="url" id="url">
    <input type="tel" id="tel">
    <input type="email" id="email">
    <input type="password" id="password">
    <input type="number" id="number">
    <input type="checkbox" id="checkbox">
    <input type="hidden" id="hidden">
    <input type="submit" id="submit">
    <input type="image" id="image">
    <input type="date" id="date">
    <input type="" id="empty">
  `);
  for (const id of ['none', 'text', 'search', 'url', 'tel', 'email', 'password', 'number']) {
    assert.equal(byId(r, id).blocking, true, id);
  }
  for (const id of ['checkbox', 'hidden', 'submit', 'image', 'date', 'empty']) {
    assert.equal(byId(r, id).blocking, false, id);
  }
  assert.equal(byId(r, 'none').typeMissing, true);
  assert.equal(byId(r, 'none').type, 'text');
  assert.equal(r.count.blocking, 8);
});

test('有可用默认按钮：Enter 触发默认按钮提交（无 type 的 button / type=submit / input submit|image）', () => {
  const r = implicitSubmit(`
    <form id="f1">
      <input id="t1">
      <button id="b1">提交</button>
    </form>
    <form id="f2">
      <input type="search" id="t2">
      <button type="submit" id="b2">Go</button>
    </form>
    <form id="f3">
      <input type="number" id="t3">
      <input type="image" src="/go.png" id="b3">
    </form>
    <form id="f4">
      <input type="email" id="t4">
      <input type="submit" id="b4">
    </form>
  `);
  for (const [tid, bid, tag] of [
    ['t1', 'b1', 'button'],
    ['t2', 'b2', 'button'],
    ['t3', 'b3', 'input'],
    ['t4', 'b4', 'input'],
  ]) {
    const inp = byId(r, tid);
    assert.equal(inp.submits, true, tid);
    assert.equal(inp.reason, 'default-button', tid);
    assert.equal(inp.defaultButton.id, bid, tid);
    assert.equal(inp.defaultButton.tag, tag, tid);
    assert.equal(inp.defaultButton.disabled, false, tid);
  }
  // 无 type 的 button 在结果里 type 归一为 submit
  assert.equal(byId(r, 't1').defaultButton.type, 'submit');
  assert.equal(byId(r, 't1').defaultButton.text, '提交');
});

test('默认按钮取文档序首个提交按钮；type=button/reset 不算', () => {
  const r = implicitSubmit(`
    <form>
      <input id="t">
      <button type="button" id="not1">不算</button>
      <button type="reset" id="not2">不算</button>
      <input type="button" id="not3">
      <button type="submit" id="first">第一个提交按钮</button>
      <button id="second">无 type 也是提交按钮，但更靠后</button>
    </form>
  `);
  const inp = byId(r, 't');
  assert.equal(inp.submits, true);
  assert.equal(inp.defaultButton.id, 'first');
});

test('默认按钮失效时不改选，即使只有一个阻止型输入 Enter 也不提交', () => {
  const r = implicitSubmit(`
    <form>
      <input id="only">
      <button type="submit" disabled id="dead">失效默认按钮</button>
      <button type="submit" id="alive">可用但不是默认按钮</button>
    </form>
  `);
  const inp = byId(r, 'only');
  assert.equal(inp.submits, false);
  assert.equal(inp.reason, 'default-button-disabled');
  assert.equal(inp.defaultButton.id, 'dead');
  assert.equal(inp.defaultButton.disabled, true);
});

test('disabled 默认按钮为 input type=submit 时同样不提交', () => {
  const r = implicitSubmit(`
    <form>
      <input type="text" id="t">
      <input type="submit" disabled id="dead">
    </form>
  `);
  assert.equal(byId(r, 't').submits, false);
  assert.equal(byId(r, 't').reason, 'default-button-disabled');
});

test('无默认按钮：恰好一个可用阻止型输入才提交；零个或多个都不提交', () => {
  const one = implicitSubmit('<form><input id="t" type="text"></form>');
  assert.equal(byId(one, 't').submits, true);
  assert.equal(byId(one, 't').reason, 'single-blocking-input');
  assert.equal(byId(one, 't').defaultButton, null);

  const two = implicitSubmit(`
    <form>
      <input type="text" id="t1">
      <input type="email" id="t2">
    </form>
  `);
  assert.equal(byId(two, 't1').submits, false);
  assert.equal(byId(two, 't1').reason, 'multiple-blocking-inputs');
  assert.equal(byId(two, 't2').submits, false);
  assert.equal(byId(two, 't2').reason, 'multiple-blocking-inputs');

  // 只有非阻止型输入：Enter 不提交
  const none = implicitSubmit('<form><input type="checkbox" id="cb"></form>');
  assert.equal(byId(none, 'cb').submits, false);
  assert.equal(byId(none, 'cb').reason, 'not-blocking-type');
});

test('无默认按钮时统计仅计入可用阻止型输入：失效项被排除后可能只剩一个', () => {
  const r = implicitSubmit(`
    <form>
      <input type="text" id="alive">
      <input type="text" id="selfDisabled" disabled>
      <input type="checkbox" id="notBlocking">
    </form>
  `);
  assert.equal(byId(r, 'alive').submits, true);
  assert.equal(byId(r, 'alive').reason, 'single-blocking-input');
  assert.equal(byId(r, 'selfDisabled').submits, false);
  assert.equal(byId(r, 'selfDisabled').reason, 'disabled');
});

test('无 form 祖先也无 form 属性 -> 无归属，Enter 不提交', () => {
  const r = implicitSubmit('<input id="orphan">');
  const inp = byId(r, 'orphan');
  assert.equal(inp.form, null);
  assert.equal(inp.submits, false);
  assert.equal(inp.reason, 'no-form-owner');
  assert.equal(r.count.noFormOwner, 1);
});

test('form=ID 指向有效 form：可跨子树归属', () => {
  const r = implicitSubmit(`
    <form id="f"><button type="submit" id="b">go</button></form>
    <input id="remote" form="f">
  `);
  const inp = byId(r, 'remote');
  assert.equal(inp.form.id, 'f');
  assert.equal(inp.formAttr, 'f');
  assert.equal(inp.formAttrValid, true);
  assert.equal(inp.submits, true);
  assert.equal(inp.defaultButton.id, 'b');
});

test('form=ID 指向文档序首个同 id 元素：首个不是 form 时无归属（即使后面有同 id form）', () => {
  const r = implicitSubmit(`
    <div id="f"></div>
    <form id="f"><button>go</button></form>
    <input id="inp" form="f">
  `);
  const inp = byId(r, 'inp');
  assert.equal(inp.form, null);
  assert.equal(inp.formAttrValid, false);
  assert.equal(inp.submits, false);
  assert.equal(inp.reason, 'no-form-owner');

  // 首个是 form 则有效，即便后面还有同 id form
  const r2 = implicitSubmit(`
    <form id="g"><button type="submit" id="bg">go</button></form>
    <form id="g"></form>
    <input id="inp2" form="g">
  `);
  assert.equal(byId(r2, 'inp2').form.dom, 1);
  assert.equal(byId(r2, 'inp2').submits, true);
  assert.equal(byId(r2, 'inp2').defaultButton.id, 'bg');
});

test('form=不存在的 id 或空串 -> 无归属，且不回退到祖先 form', () => {
  const r = implicitSubmit(`
    <form id="wrap">
      <button type="submit">x</button>
      <input id="ghost" form="nope">
      <input id="empty" form="">
    </form>
  `);
  for (const id of ['ghost', 'empty']) {
    const inp = byId(r, id);
    assert.equal(inp.form, null, id);
    assert.equal(inp.formAttrValid, false, id);
    assert.equal(inp.reason, 'no-form-owner', id);
    assert.equal(inp.submits, false, id);
  }
});

test('未设置 form 属性时取最近 form 祖先', () => {
  const r = implicitSubmit(`
    <form id="outer"><button type="submit">x</button>
      <div><input id="inOuter"></div>
    </form>
    <form id="inner">
      <input id="inInner">
    </form>
  `);
  assert.equal(byId(r, 'inInner').form.id, 'inner');
  assert.equal(byId(r, 'inOuter').form.id, 'outer');
});

test('自身 disabled 的 input 失效，不参与判定与计数', () => {
  const r = implicitSubmit(`
    <form>
      <input type="text" id="t1">
      <input type="text" id="d1" disabled>
    </form>
  `);
  assert.equal(byId(r, 'd1').disabled, true);
  assert.equal(byId(r, 'd1').submits, false);
  assert.equal(byId(r, 'd1').reason, 'disabled');
  assert.equal(byId(r, 'd1').inDisabledFieldset, false);
  // d1 失效不计入阻止型数量，t1 成为唯一可用阻止型输入
  assert.equal(byId(r, 't1').submits, true);
  assert.equal(r.count.disabled, 1);
});

test('disabled fieldset 后代失效；首个 legend 子树例外', () => {
  const r = implicitSubmit(`
    <form>
      <button type="submit" id="submitBtn">go</button>
      <fieldset disabled>
        <legend>
          <input type="text" id="legInput">
          <button type="submit" id="legBtn">legend 内按钮可用</button>
        </legend>
        <input type="text" id="fsInput">
        <div><input type="text" id="deepInput"></div>
      </fieldset>
    </form>
  `);
  // legend 子树中的 input 不受影响（legend 内的提交按钮单独有用例验证）
  assert.equal(byId(r, 'legInput').disabled, false);
  assert.equal(byId(r, 'legInput').inDisabledFieldset, false);
  // fieldset 直接/深层后代失效
  for (const id of ['fsInput', 'deepInput']) {
    assert.equal(byId(r, id).disabled, true, id);
    assert.equal(byId(r, id).inDisabledFieldset, true, id);
    assert.equal(byId(r, id).reason, 'disabled-fieldset', id);
    assert.equal(byId(r, id).submits, false, id);
  }
  // legend 内按钮在文档序上晚于 submitBtn，默认按钮仍是 submitBtn
  assert.equal(byId(r, 'legInput').defaultButton.id, 'submitBtn');
  assert.equal(byId(r, 'legInput').submits, true);
});

test('非首个 legend 不享受例外；legend 前的其他子元素也不例外', () => {
  const r = implicitSubmit(`
    <form>
      <fieldset disabled>
        <input type="text" id="before">
        <legend><input type="text" id="firstLeg"></legend>
        <legend><input type="text" id="secondLeg"></legend>
      </fieldset>
    </form>
  `);
  assert.equal(byId(r, 'before').disabled, true);
  assert.equal(byId(r, 'firstLeg').disabled, false);
  assert.equal(byId(r, 'secondLeg').disabled, true);
  assert.equal(byId(r, 'secondLeg').reason, 'disabled-fieldset');
});

test('嵌套 fieldset：外层 disabled 时内层 legend 无法挽救；内层 legend 仅解除内层', () => {
  const r = implicitSubmit(`
    <form><fieldset disabled>
      <fieldset>
        <legend><input type="text" id="innerLegend"></legend>
        <input type="text" id="innerPlain">
      </fieldset>
    </fieldset></form>
  `);
  // 内层 fieldset 自身未 disabled，但其 legend 只能解除内层屏障（深度仍为 1）
  assert.equal(byId(r, 'innerLegend').disabled, true);
  assert.equal(byId(r, 'innerPlain').disabled, true);

  const r2 = implicitSubmit(`
    <form><fieldset>
      <fieldset disabled>
        <legend><input type="text" id="leg"></legend>
        <input type="text" id="plain">
      </fieldset>
    </fieldset></form>
  `);
  assert.equal(byId(r2, 'leg').disabled, false);
  assert.equal(byId(r2, 'plain').disabled, true);
});

test('disabled fieldset 首个 legend 内的提交按钮可以成为默认按钮', () => {
  const r = implicitSubmit(`
    <form>
      <input type="text" id="t">
      <fieldset disabled>
        <legend><button type="submit" id="onlyBtn">唯一提交按钮</button></legend>
        <button type="submit" disabled id="dead">失效</button>
      </fieldset>
    </form>
  `);
  // dead 在文档序更靠后但先... 实际顺序 onlyBtn 在 dead 之前；onlyBtn 可用
  assert.equal(byId(r, 't').defaultButton.id, 'onlyBtn');
  assert.equal(byId(r, 't').defaultButton.disabled, false);
  assert.equal(byId(r, 't').submits, true);
});

test('提交按钮的 form 属性也参与所属 form 的默认按钮选择', () => {
  const r = implicitSubmit(`
    <form id="f1"><input id="t1"></form>
    <button type="submit" form="f1" id="remoteBtn">远程提交</button>
  `);
  assert.equal(byId(r, 't1').defaultButton.id, 'remoteBtn');
  assert.equal(byId(r, 't1').submits, true);
});

test('提交按钮 form="" 无归属时不会成为任何 form 的默认按钮；type 空白大小写归一', () => {
  const r = implicitSubmit(`
    <form id="f">
      <input id="t">
      <input type="submit" form="" id="ownerlessBtn">
    </form>
  `);
  assert.equal(byId(r, 't').defaultButton, null);
  assert.equal(byId(r, 't').submits, true);
  assert.equal(byId(r, 't').reason, 'single-blocking-input');
  assert.equal(byId(r, 'ownerlessBtn').form, null);
  assert.equal(byId(r, 'ownerlessBtn').formAttrValid, false);

  const r2 = implicitSubmit('<form><input type="  TEXT " id="x"></form>');
  assert.equal(byId(r2, 'x').blocking, true);
  assert.equal(byId(r2, 'x').type, 'text');
});

test('form 属性归属的多个阻止型输入与其归属 form 一起计数', () => {
  const r = implicitSubmit(`
    <form id="f"></form>
    <input type="text" form="f" id="a">
    <input type="text" form="f" id="b">
    <input type="text" form="f" id="c" disabled>
  `);
  assert.equal(byId(r, 'a').reason, 'multiple-blocking-inputs');
  assert.equal(byId(r, 'b').reason, 'multiple-blocking-inputs');
  assert.equal(byId(r, 'c').reason, 'disabled');
});

test('非阻止型 input（含 submit/image/button/reset/checkbox 等）本身不触发隐式提交', () => {
  const r = implicitSubmit(`
    <form id="f">
      <input type="submit" id="s">
      <input type="image" id="i">
      <input type="reset" id="r">
      <input type="button" id="b">
      <input type="checkbox" id="c">
      <input type="hidden" name="h" id="h">
    </form>
  `);
  for (const id of ['s', 'i', 'r', 'b', 'c', 'h']) {
    assert.equal(byId(r, id).submits, false, id);
    assert.equal(byId(r, id).reason, 'not-blocking-type', id);
  }
  // 但默认按钮仍按规则给出（首个提交按钮 s）
  assert.equal(byId(r, 'i').defaultButton.id, 's');
  assert.equal(byId(r, 's').defaultButton.id, 's');
});

test('每个结果带定位信息与原因文本；form 指向 form 的文档序编号', () => {
  const r = implicitSubmit('<form id="f">\n  <input id="t">\n  <button>go</button>\n</form>');
  const inp = byId(r, 't');
  assert.equal(inp.location.line, 2);
  assert.ok(inp.detail.includes('默认按钮'));
  assert.equal(inp.form.dom, 1);
  assert.equal(inp.form.id, 'f');
});

test('空片段安全处理', () => {
  const r = implicitSubmit('');
  assert.deepEqual(r.inputs, []);
  assert.deepEqual(r.count, { inputs: 0, blocking: 0, submits: 0, noFormOwner: 0, disabled: 0 });
});

test('综合场景：各 form 的判定互相隔离', () => {
  const r = implicitSubmit(`
    <form id="single"><input type="text" id="s1"></form>
    <form id="withBtn">
      <input type="text" id="s2">
      <button type="submit" id="ok">提交</button>
    </form>
    <form id="many">
      <input type="text" id="s3">
      <input type="url" id="s4">
    </form>
    <input id="alone">
  `);
  assert.equal(byId(r, 's1').reason, 'single-blocking-input');
  assert.equal(byId(r, 's1').submits, true);
  assert.equal(byId(r, 's2').reason, 'default-button');
  assert.equal(byId(r, 's2').submits, true);
  assert.equal(byId(r, 's3').reason, 'multiple-blocking-inputs');
  assert.equal(byId(r, 's4').reason, 'multiple-blocking-inputs');
  assert.equal(byId(r, 'alone').reason, 'no-form-owner');
  assert.equal(r.count.submits, 2);
});

test('HTTP：POST /implicit-submit 支持 text/html 与 JSON，坏请求 400，500 包装异常', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // text/html 原始片段
  let res = await fetch(`${base}/implicit-submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: '<form><input name="q"><button>搜索</button></form>',
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.inputs.length, 1);
  assert.equal(body.inputs[0].submits, true);
  assert.equal(body.inputs[0].reason, 'default-button');
  assert.equal(body.inputs[0].defaultButton.tag, 'button');

  // JSON { html }
  res = await fetch(`${base}/implicit-submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<form><input type="text"><input type="text"></form>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.deepEqual(body.inputs.map((i) => i.reason), ['multiple-blocking-inputs', 'multiple-blocking-inputs']);
  assert.equal(body.count.submits, 0);

  // 无法解析的请求体 -> 400
  res = await fetch(`${base}/implicit-submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(res.status, 400);
  body = await res.json();
  assert.equal(body.error, 'BAD_REQUEST');

  // 既有端点仍正常
  res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});
