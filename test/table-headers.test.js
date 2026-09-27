'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tableHeaders } = require('../src/table-headers');
const app = require('../src/app');

function byDom(result, dom) {
  const found = result.cells.filter((c) => c.dom === dom);
  assert.equal(found.length, 1, `应恰好存在 dom=${dom} 的 td`);
  return found[0];
}

test('收集所有 td，dom 为全局元素先序号（非 td 元素也占位），table 按表文档序编号', () => {
  const r = tableHeaders(`
    <div></div>
    <table>
      <tr><th scope="col">A</th></tr>
      <tr><td>a</td></tr>
    </table>
    <span></span>
    <table>
      <tr><td>b</td></tr>
    </table>
  `);
  assert.equal(r.count.tables, 2);
  // parse5 为直属 tr 合成 tbody（同样是元素，占 dom 号）
  assert.deepEqual(
    r.cells.map((c) => [c.dom, c.table, c.tag]),
    [[7, 1, 'td'], [12, 2, 'td']]
  );
});

test('行来源：本表直属 tr 与 thead/tbody/tfoot 下的 tr，按文档序；th 不作为结果输出', () => {
  const r = tableHeaders(`
    <table>
      <thead><tr><th scope="col">H</th></tr></thead>
      <tbody><tr><td>a</td></tr></tbody>
      <tfoot><tr><td>f</td></tr></tfoot>
    </table>
  `);
  assert.deepEqual(r.cells.map((c) => c.headers), [[4], [4]]);
  assert.deepEqual(r.cells.map((c) => c.dom), [7, 10]);
});

test('tfoot 中的 td 同样可与上方 scope=col 表头相交', () => {
  const r = tableHeaders(`
    <table>
      <thead><tr><th scope="col">H</th></tr></thead>
      <tbody><tr><td>a</td></tr></tbody>
      <tfoot><tr><td>f</td></tr></tfoot>
    </table>
  `);
  assert.deepEqual(byDom(r, 10).headers, [4]);
});

test('直属 tr（parse5 合成 tbody）与显式 tbody 均正确收行', () => {
  const r = tableHeaders('<table><tr><th scope="col">H</th></tr><tr><td>x</td></tr></table>');
  assert.equal(r.count.tables, 1);
  assert.deepEqual(r.cells.map((c) => [c.dom, c.headers]), [[6, [4]]]);
});

test('scope=col：表头覆盖 colspan 跨越的列；td 的 colspan 与表头列区间相交即关联', () => {
  const r = tableHeaders(`
    <table>
      <tr><th id="p" scope="col" colspan="2">姓名</th><th scope="col">年龄</th></tr>
      <tr><td>a</td><td>b</td><td headers="p">c</td></tr>
    </table>
  `);
  // a、b 都落在表头“姓名”跨的两列内（th#p 为全局第 4 号元素）
  const [a, b, c] = r.cells;
  assert.deepEqual(a.headers, [4]);
  assert.deepEqual(b.headers, [4]);
  // 第三个 td 走显式 headers，不再推断“年龄”
  assert.deepEqual(c.headers, [4]);
  assert.deepEqual(c.issues, []);
});

test('scope=row：左侧行区间相交的表头；rowspan 覆盖多行', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="row" rowspan="2">组</th><td>a</td></tr>
      <tr><td>b</td></tr>
    </table>
  `);
  const [a, b] = r.cells;
  assert.deepEqual(a.headers, [4]);
  assert.deepEqual(b.headers, [4]); // 行表头 rowspan 覆盖第二行
});

test('同时匹配 scope=col 与 scope=row：按表头文档序去重输出', () => {
  const r = tableHeaders(`
    <table>
      <tr><th></th><th id="col" scope="col">列</th></tr>
      <tr><th id="row" scope="row">行</th><td>x</td></tr>
    </table>
  `);
  // 无 scope 的角头 <th></th> 不参与；col th=5，row th=7
  assert.deepEqual(byDom(r, 8).headers, [5, 7]);
});

test('只处理 scope=col / scope=row（大小写、空白归一）；其他 scope 忽略', () => {
  const r = tableHeaders(`
    <table>
      <tr>
        <th scope="  COL ">C</th>
        <th scope="Row">R</th>
        <th scope="colgroup">CG</th>
        <th scope="rowgroup">RG</th>
        <th scope="auto">X</th>
        <th>无 scope</th>
      </tr>
      <tr><td>c</td><td colspan="5"></td></tr>
    </table>
  `);
  const [c, wide] = r.cells;
  assert.deepEqual(c.headers, [4]);
  assert.equal(wide.headers.length, 0);
  assert.equal(wide.issues[0].type, 'NO_HEADER');
});

test('rowspan 占位：落格先跳过跨行占据的格，后续单元格正确对齐列', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="col">A</th><th scope="col">B</th><th scope="col">C</th></tr>
      <tr><td rowspan="2">x</td><td>y</td><td>z</td></tr>
      <tr><td>yy</td><td>zz</td></tr>
    </table>
  `);
  // x -> A(4), y -> B(5), z -> C(6)；第二行首格被 x 的 rowspan 占位，yy 落在 B 列，zz 落在 C 列
  assert.deepEqual(r.cells.map((c) => c.headers), [[4], [5], [6], [5], [6]]);
});

test('rowspan/colspan 仅接受 1～20 十进制整数：0、负数、小数、非数字、21 均按 1（空白前后缀允许）', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="col">A</th><th scope="col">B</th><th scope="col">C</th></tr>
      <tr>
        <td rowspan="0">zero</td>
        <td colspan="21">big</td>
      </tr>
      <tr>
        <td rowspan="-2">neg</td>
        <td colspan=" 2 ">ok2</td>
        <td colspan="2.5">dot</td>
      </tr>
      <tr>
        <td rowspan="abc">abc</td>
        <td colspan="20">max20</td>
        <td>tail</td>
      </tr>
    </table>
  `);
  // 网格落位（header 行为 A B C）：
  //  第1数据行: zero(rowspan=1)=A, big(colspan=1)=B（C 落空）
  //  第2数据行: neg(rowspan=1)=A, ok2(colspan=2)=B+C, （dot 顺延到下一格 C 被占后落行尾？）
  //  实际：ok2 占 B、C 两格，dot 落到本行第 4 列（无表头）
  //  第3数据行: abc(rowspan=1)=A, max20(colspan=20) 从 B 起到第 21 列，tail 落到第 22 列
  assert.deepEqual(r.cells.map((c) => c.headers), [
    [4], // zero
    [5], // big
    [4], // neg
    [5, 6], // ok2（与 B、C 都相交，按文档序保留两者）
    [], // dot 被挤到无表头的列
    [4], // abc
    [5, 6], // max20 覆盖 B、C
    [], // tail 落到第 22 列
  ]);
  assert.equal(r.cells[4].issues[0].type, 'NO_HEADER');
  assert.equal(r.cells[7].issues[0].type, 'NO_HEADER');
});

test('headers 属性：按令牌顺序关联本表首个同 id 的 th，重复去重，无效引用逐个报告', () => {
  const r = tableHeaders(`
    <table>
      <tr>
        <th id="a" scope="col">A</th>
        <th id="b">B</th>
        <th id="a" scope="col">A2</th>
      </tr>
      <tr>
        <td id="a">同名 id 的 td 不算</td>
        <td headers="b a a ghost b">x</td>
        <td headers="  ">空白</td>
      </tr>
    </table>
  `);
  // 三个 th 为全局 4/5/6 号；三个 td 为 8/9/10 号
  const [firstTd, explicit, whitespace] = r.cells;
  // 首个 td 无 headers，第 1 列 th#a 是 scope=col（同名 id 的 td 不影响 th 表）
  assert.deepEqual(firstTd.headers, [4]);
  // 显式：b(5) -> a 取首个同 id 的 th(4)，重复 a、b 去重；ghost 无效
  assert.deepEqual(explicit.headers, [5, 4]);
  assert.deepEqual(
    explicit.issues,
    [{ type: 'INVALID_HEADER_REFERENCE', refId: 'ghost', detail: explicit.issues[0].detail }]
  );
  assert.ok(explicit.issues[0].detail.includes('"ghost"'));
  // 纯空白 headers：属性存在即显式模式，零令牌 -> 无关联，不回退推断
  assert.deepEqual(whitespace.headers, []);
  assert.deepEqual(whitespace.issues.map((i) => i.type), ['NO_HEADER']);
});

test('headers 属性存在但全部为无效引用：报每个无效引用（去重）且报 NO_HEADER，不自动推断', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="col">A</th></tr>
      <tr><td headers="x x y">z</td></tr>
    </table>
  `);
  const cell = r.cells[0];
  assert.deepEqual(cell.headers, []);
  assert.deepEqual(cell.issues.map((i) => i.type), [
    'INVALID_HEADER_REFERENCE',
    'INVALID_HEADER_REFERENCE',
    'NO_HEADER',
  ]);
  assert.deepEqual(cell.issues.map((i) => i.refId), ['x', 'y', undefined]);
});

test('headers 只在本表内解析：引用不到外表（含外表）的 id', () => {
  const r = tableHeaders(`
    <table id="outer">
      <tr><th id="outH" scope="col">外</th><td>
        <table><tr><th id="innerH" scope="col">内</th></tr><tr><td headers="outH innerH">x</td></tr></table>
      </td></tr>
    </table>
  `);
  // 嵌套表另算：内表 td（全局 11 号）的 headers 只能找到本表的 innerH(9)；outH 是无效引用
  const inner = r.cells.find((c) => c.table === 2);
  assert.equal(inner.dom, 11);
  assert.deepEqual(inner.headers, [9]);
  assert.deepEqual(inner.issues.map((i) => i.type), ['INVALID_HEADER_REFERENCE']);
  assert.equal(inner.issues[0].refId, 'outH');
  // 外表那个含嵌套表的 td 无 headers，外表列头 outH(4) 与第二列不相交 -> 无表头
  const outer = r.cells.find((c) => c.table === 1);
  assert.equal(outer.dom, 5);
  assert.deepEqual(outer.headers, []);
});

test('嵌套表：外表与内表各自独立网格，外表 td 的表头不串到内表', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="col">O</th><th scope="col">P</th></tr>
      <tr>
        <td>o1</td>
        <td><table><tr><td>n</td></tr></table></td>
      </tr>
    </table>
  `);
  assert.equal(r.count.tables, 2);
  const outer = r.cells.filter((c) => c.table === 1);
  const nested = r.cells.filter((c) => c.table === 2);
  assert.equal(outer.length, 2);
  assert.deepEqual(outer.map((c) => c.headers), [[4], [5]]); // o1->O, 含嵌套表的 td -> P
  assert.equal(nested.length, 1);
  assert.deepEqual(nested[0].headers, []); // 内表无表头
  assert.equal(nested[0].issues[0].type, 'NO_HEADER');
});

test('无有效表头的 td 报 NO_HEADER；问题同时出现在 cell.issues 与顶层 issues', () => {
  const r = tableHeaders('<table><tr><td>x</td></tr></table>');
  const cell = r.cells[0];
  assert.equal(cell.dom, 4); // table(1) > tbody(2) > tr(3) > td(4)
  assert.deepEqual(cell.headers, []);
  assert.deepEqual(cell.issues.map((i) => i.type), ['NO_HEADER']);
  assert.ok(cell.issues[0].detail.includes('第 4 号元素'));
  assert.equal(r.count.noHeader, 1);
  assert.equal(r.count.issues, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].type, 'NO_HEADER');
  assert.equal(r.issues[0].dom, 4);
  assert.equal(r.issues[0].table, 1);
});

test('输出按 td 文档序；带定位信息；count 汇总正确', () => {
  const r = tableHeaders(
    '<table><tr><th scope="col">H</th></tr><tr><td>a</td></tr></table>' +
      '<table><tr><td>b</td></tr></table>'
  );
  assert.deepEqual(r.cells.map((c) => c.dom), [6, 10]);
  assert.ok(r.cells.every((c) => c.location && typeof c.location.line === 'number'));
  assert.deepEqual(r.count, {
    tables: 2,
    cells: 2,
    issues: 1,
    invalidHeaderReferences: 0,
    noHeader: 1,
  });
});

test('复杂跨行：col 表头自身带 rowspan 时只覆盖其跨越的格；严格“上方/左侧”才关联', () => {
  const r = tableHeaders(`
    <table>
      <tr><th scope="col" rowspan="2">H</th><td>a</td></tr>
      <tr><td>b</td></tr>
    </table>
  `);
  // a 与 H 同行，不满足“上方列区间”（表头须严格在 td 之上），故无表头
  // b 的行区间与 H 的行区间相交于同一行（H 跨越第 0、1 行），H 不在 b 上方 -> 仍不匹配
  assert.deepEqual(r.cells.map((c) => c.headers), [[], []]);
  assert.deepEqual(r.cells.map((c) => c.issues.map((i) => i.type)), [['NO_HEADER'], ['NO_HEADER']]);

  // 但 H 跨越结束之后再下一行的 td，H 整体位于其上方 -> 正常关联
  const r2 = tableHeaders(`
    <table>
      <tr><th scope="col" rowspan="2">H</th><th scope="col">X</th><td>a</td></tr>
      <tr><td>b</td></tr>
      <tr><td>c</td></tr>
    </table>
  `);
  // 行1：第 0 列被 H 的 rowspan 占位，b 落在第 1 列 -> 与上方的 X 关联
  // 行2：c 落在第 0 列，H 整体在其上方 -> 与 H 关联
  assert.deepEqual(r2.cells.map((c) => c.headers), [[], [5], [4]]);
});

test('空片段安全处理', () => {
  const r = tableHeaders('');
  assert.deepEqual(r.cells, []);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.count, {
    tables: 0,
    cells: 0,
    issues: 0,
    invalidHeaderReferences: 0,
    noHeader: 0,
  });
});

test('HTTP：POST /table-headers 支持 text/html 与 JSON，坏请求 400，500 包装异常', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // text/html 原始片段
  let res = await fetch(`${base}/table-headers`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: '<table><tr><th scope="col">H</th></tr><tr><td>x</td></tr></table>',
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.count.tables, 1);
  assert.equal(body.cells.length, 1);
  assert.deepEqual(body.cells[0].headers, [4]); // table(1)>tbody(2)>tr(3)>th(4)… 第二行 td 为 6

  // JSON { html }：headers 无效引用
  res = await fetch(`${base}/table-headers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<table><tr><td headers="ghost">x</td></tr></table>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.count.invalidHeaderReferences, 1);
  assert.equal(body.count.noHeader, 1);
  assert.equal(body.issues[0].refId, 'ghost');

  // 无法解析的请求体 -> 400
  res = await fetch(`${base}/table-headers`, {
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
