'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const parse5 = require('parse5');
const { tableHeaders } = require('../src/table-headers');
const app = require('../src/app');

/**
 * 重新解析同一段 HTML，返回 id -> 全局文档序 dom（重复 id 取首个）。
 * 用于把测试里具名的 th/td 与结果中的 dom 数字对应起来。
 */
function domById(html) {
  const frag = parse5.parseFragment(html);
  const map = {};
  let count = 0;
  (function walk(node) {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue;
      count += 1;
      const idAttr = child.attrs.find((a) => a.name === 'id');
      if (idAttr && !(idAttr.value in map)) map[idAttr.value] = count;
      walk(child);
    }
  })(frag);
  return map;
}

// 按 id 取出对应 td 的结果条目
function tdOf(result, idMap, id) {
  const dom = idMap[id];
  const found = result.cells.filter((c) => c.dom === dom);
  assert.equal(found.length, 1, `应恰好存在 id=${id}（dom=${dom}）的 td 结果`);
  return found[0];
}

// 把 dom 列表翻译成 id 列表，便于断言
function toIds(doms, idMap) {
  return doms.map((d) => {
    const hit = Object.entries(idMap).find(([, dom]) => dom === d);
    return hit ? hit[0] : `dom${d}`;
  });
}

test('每个 table 独立编号；只返回 td；dom 是全部元素的全局文档序编号', () => {
  const html = `
    <section><table>
      <thead><tr><th scope="col" id="h1">A</th></tr></thead>
      <tbody><tr><td id="a">1</td></tr></tbody>
    </table></section>
    <table>
      <tr><th scope="col" id="h2">B</th></tr>
      <tr><td id="b">2</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  assert.equal(r.count.tables, 2);
  assert.equal(r.cells.length, 2);
  assert.deepEqual(r.cells.map((c) => c.dom), [idMap.a, idMap.b]);
  assert.deepEqual(r.cells.map((c) => c.table), [1, 2]);
  // 两格各自关联本表唯一列头（dom 均为小于自身的全局编号）
  assert.deepEqual(r.cells[0].headers, [idMap.h1]);
  assert.deepEqual(r.cells[1].headers, [idMap.h2]);
});

test('只计本表直属 tr 及 thead/tbody/tfoot 下的 tr；嵌套表另算', () => {
  const html = `
    <table>
      <thead><tr><th scope="col" id="outerHead">外列头</th></tr></thead>
      <tbody>
        <tr>
          <td id="outerCell">
            <table>
              <tr><th scope="col" id="innerHead">内列头</th></tr>
              <tr><td id="innerCell">内</td></tr>
            </table>
          </td>
        </tr>
      </tbody>
      <tfoot><tr><td id="footCell">脚</td></tr></tfoot>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  // 嵌套表 td 在文档序上夹在外表单元之间
  assert.deepEqual(r.cells.map((c) => c.dom), [idMap.outerCell, idMap.innerCell, idMap.footCell]);
  assert.deepEqual(r.cells.map((c) => c.table), [1, 2, 1]);
  // 内表 td 关联内表头；外表两个 td 不跨表关联
  assert.deepEqual(tdOf(r, idMap, 'innerCell').headers, [idMap.innerHead]);
  assert.deepEqual(tdOf(r, idMap, 'outerCell').headers, [idMap.outerHead]);
  assert.deepEqual(tdOf(r, idMap, 'footCell').headers, [idMap.outerHead]);
});

test('放置时先跳过跨行占位：rowspan 让后续行的 td 落到正确列', () => {
  const html = `
    <table>
      <tr><th scope="col" id="c1">C1</th><th scope="col" id="c2">C2</th></tr>
      <tr><th scope="row" id="r1" rowspan="2">R</th><td id="a">a</td></tr>
      <tr><td id="b">b</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  // 第二数据行的 td 跳过 r1 占位列，落在 C2 列，同时仍被跨行的 r1 覆盖
  assert.deepEqual(toIds(tdOf(r, idMap, 'a').headers, idMap), ['c2', 'r1']);
  assert.deepEqual(toIds(tdOf(r, idMap, 'b').headers, idMap), ['c2', 'r1']);
});

test('colspan 表头覆盖其跨越的格；scope=col 按列区间相交关联', () => {
  const html = `
    <table>
      <tr><th scope="col" id="h" colspan="3">季度</th></tr>
      <tr><td id="x">1</td><td id="y">2</td><td id="z">3</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  for (const id of ['x', 'y', 'z']) {
    assert.deepEqual(tdOf(r, idMap, id).headers, [idMap.h], id);
  }
});

test('rowspan 行表头覆盖后续行；scope=row 按行区间相交关联', () => {
  const html = `
    <table>
      <tr><th scope="row" id="h" rowspan="3">地区</th><td id="x">1</td></tr>
      <tr><td id="y">2</td></tr>
      <tr><td id="z">3</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  for (const id of ['x', 'y', 'z']) {
    assert.deepEqual(tdOf(r, idMap, id).headers, [idMap.h], id);
  }
});

test('scope=col 必须严格在上方、scope=row 必须严格在左侧；同格/反方向不关联', () => {
  const html = `
    <table>
      <tr><td id="tl">无依无靠</td><th scope="col" id="cTop">顶头</th></tr>
      <tr><th scope="row" id="rSide">行头</th><td id="mid">中</td></tr>
      <tr><td id="below">下方格</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  // 顶头与 tl 同处一行，不能作为 tl 的列头
  assert.deepEqual(tdOf(r, idMap, 'tl').headers, []);
  // mid：上方列相交的 cTop + 左侧行相交的 rSide，按文档序
  assert.deepEqual(toIds(tdOf(r, idMap, 'mid').headers, idMap), ['cTop', 'rSide']);
  // below 落在第 1 列（rSide 无 rowspan 不占位），与顶头（第 2 列）列区间不相交
  assert.deepEqual(tdOf(r, idMap, 'below').headers, []);
});

test('scope 的其他取值（colgroup/rowgroup/空/非法）不参与推断', () => {
  const html = `
    <table>
      <tr>
        <th scope="colgroup" id="cg">CG</th>
        <th scope="rowgroup" id="rg">RG</th>
        <th scope="" id="emptyS">E</th>
        <th scope="WAT" id="watS">W</th>
      </tr>
      <tr><td id="a">a</td><td id="b">b</td><td id="c">c</td><td id="d">d</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(tdOf(r, idMap, id).headers, [], id);
  }
});

test('推断结果按表头文档序去重；同一格同时被行/列表头命中只列一次', () => {
  const html = `
    <table>
      <tr><th scope="col" id="c1" colspan="2">C1</th></tr>
      <tr><th scope="row" id="r1">R1</th><td id="a">a</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  // c1 跨两列覆盖数据格（上方），r1 在左侧（行区间相交），文档序去重后各列一次
  assert.deepEqual(tdOf(r, idMap, 'a').headers, [idMap.c1, idMap.r1]);
});

test('rowspan、colspan 仅接受 1～20 的十进制整数，否则按 1', () => {
  // colspan=21 被按 1 处理：只有第 1 列数据格关联到它，第 2 列格无表头
  const bigHtml = `
    <table>
      <tr><th scope="col" id="h" colspan="21">宽</th></tr>
      <tr><td id="a">a</td><td id="b">b</td></tr>
    </table>
  `;
  const big = tableHeaders(bigHtml);
  const bigMap = domById(bigHtml);
  assert.deepEqual(tdOf(big, bigMap, 'a').headers, [bigMap.h]);
  assert.deepEqual(tdOf(big, bigMap, 'b').headers, []);

  // 非法值（0、负数、非数字）均按 1
  const badHtml = `
    <table>
      <tr><th scope="col" id="h0" colspan="0">0</th></tr>
      <tr><td id="c0">x</td></tr>
    </table>
    <table>
      <tr><th scope="col" id="hx" colspan="wat">x</th></tr>
      <tr><td id="cx">x</td></tr>
    </table>
    <table>
      <tr><th scope="col" id="hneg" colspan="-2">-2</th></tr>
      <tr><td id="cneg">x</td></tr>
    </table>
  `;
  const bad = tableHeaders(badHtml);
  const badMap = domById(badHtml);
  for (const [hid, cid] of [['h0', 'c0'], ['hx', 'cx'], ['hneg', 'cneg']]) {
    assert.deepEqual(tdOf(bad, badMap, cid).headers, [badMap[hid]], cid);
  }

  // 边界值 20 合法；带前后空白的 " 20 " 合法
  const okHtml = `
    <table>
      <tr><th scope="col" id="h1">1</th><th scope="col" id="h20" colspan=" 20 ">20</th></tr>
      <tr><td id="c1">x</td><td id="c2">y</td></tr>
    </table>
  `;
  const ok = tableHeaders(okHtml);
  const okMap = domById(okHtml);
  assert.deepEqual(tdOf(ok, okMap, 'c1').headers, [okMap.h1]);
  assert.deepEqual(toIds(tdOf(ok, okMap, 'c2').headers, okMap), ['h20']);
});

test('带 headers 属性的 td：按令牌顺序关联本表首个同 id 的 th，按首次出现去重', () => {
  const html = `
    <table>
      <tr><th id="first">首个</th><th id="second">次个</th></tr>
      <tr><th id="dup">重复 id 一</th><th id="dup">重复 id 二</th>
        <td id="cell" headers="second first second first">数据</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  assert.deepEqual(tdOf(r, idMap, 'cell').headers, [idMap.second, idMap.first]);
});

test('headers 属性：重复 id 的 th 只取本表文档序首个', () => {
  const html = `
    <table>
      <tr><th id="x">一</th></tr>
      <tr><th id="x">二</th><td id="cell" headers="x">d</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  assert.deepEqual(tdOf(r, idMap, 'cell').headers, [idMap.x]);
});

test('headers 属性引用不存在 / 非 th / 其他表的 id：按令牌去重报告 INVALID_HEADER_REFERENCE', () => {
  const html = `
    <span id="notTh">不是表头</span>
    <table>
      <tr><th id="outer" scope="col">外表头</th>
        <td>
          <table>
            <tr><th id="inner">内表头</th></tr>
            <tr><td id="cell" headers="ghost notTh outer inner ghost">d</td></tr>
          </table>
        </td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  const cell = tdOf(r, idMap, 'cell');
  // 只有 inner 有效；ghost 重复出现只报一次；顺序按令牌首次出现
  assert.deepEqual(cell.headers, [idMap.inner]);
  const invalid = cell.issues.filter((i) => i.type === 'INVALID_HEADER_REFERENCE');
  assert.deepEqual(invalid.map((i) => i.refId), ['ghost', 'notTh', 'outer']);
  assert.equal(r.count.invalidReferences, 3);
});

test('带 headers 属性时不再自动推断；有效与无效引用混合时不报 NO_HEADER', () => {
  const html = `
    <table>
      <tr><th scope="col" id="col">列头</th><th id="manual">手动</th></tr>
      <tr><td id="cell" headers="manual ghost">d</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  const cell = tdOf(r, idMap, 'cell');
  assert.deepEqual(cell.headers, [idMap.manual]);
  assert.deepEqual(cell.issues.map((i) => i.type), ['INVALID_HEADER_REFERENCE']);
});

test('headers 属性令牌全部无效（含空属性）：headers 为空且报 NO_HEADER，不回退推断', () => {
  const badHtml = `
    <table>
      <tr><th scope="col" id="col">列头</th></tr>
      <tr><td id="cell" headers="ghost">d</td></tr>
    </table>
  `;
  const bad = tableHeaders(badHtml);
  const badMap = domById(badHtml);
  const cell = tdOf(bad, badMap, 'cell');
  assert.deepEqual(cell.headers, []);
  assert.deepEqual(cell.issues.map((i) => i.type), ['INVALID_HEADER_REFERENCE', 'NO_HEADER']);

  const emptyHtml = `
    <table>
      <tr><th scope="col" id="col2">列头</th></tr>
      <tr><td id="cell2" headers="">d</td></tr>
    </table>
  `;
  const empty = tableHeaders(emptyHtml);
  const emptyMap = domById(emptyHtml);
  const cell2 = tdOf(empty, emptyMap, 'cell2');
  assert.deepEqual(cell2.headers, []);
  assert.deepEqual(cell2.issues.map((i) => i.type), ['NO_HEADER']);
});

test('无任何表头关联的 td 报 NO_HEADER；无 scope 的 th 不会被推断', () => {
  const html = `
    <table>
      <tr><td id="lonely">孤独</td></tr>
      <tr><th>无 scope 列头不会关联</th></tr>
      <tr><td id="later">后来</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  assert.deepEqual(tdOf(r, idMap, 'lonely').issues.map((i) => i.type), ['NO_HEADER']);
  assert.deepEqual(tdOf(r, idMap, 'later').issues.map((i) => i.type), ['NO_HEADER']);
  assert.equal(r.count.noHeader, 2);
  assert.deepEqual(r.issues.map((i) => i.dom), [idMap.lonely, idMap.later]);
});

test('结果按文档序输出（嵌套表 td 夹在外表 td 之间）', () => {
  const html = `
    <table>
      <tr><th scope="col">O</th><td id="o1"><table>
        <tr><th scope="col">I</th></tr>
        <tr><td id="i1">i</td></tr>
      </table></td></tr>
      <tr><td id="o2">o2</td></tr>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  assert.deepEqual(r.cells.map((c) => c.dom), [idMap.o1, idMap.i1, idMap.o2]);
});

test('每个结果带全局 dom、表格序号、表头 dom 列表、问题与定位信息', () => {
  const html = '<table>\n  <tr><th scope="col" id="h">H</th></tr>\n  <tr><td id="c">d</td></tr>\n</table>';
  const r = tableHeaders(html);
  const idMap = domById(html);
  const c = tdOf(r, idMap, 'c');
  assert.equal(c.table, 1);
  assert.deepEqual(c.headers, [idMap.h]);
  assert.deepEqual(c.issues, []);
  assert.equal(c.location.line, 3);
});

test('空片段安全处理', () => {
  const r = tableHeaders('');
  assert.deepEqual(r.cells, []);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.count, {
    tables: 0,
    cells: 0,
    withHeaders: 0,
    noHeader: 0,
    invalidReferences: 0,
    issues: 0,
  });
});

test('综合场景：rowspan/colspan 网格 + 显式 headers + 跨行覆盖 + 问题统计', () => {
  const html = `
    <table>
      <thead>
        <tr><th scope="col" id="name" colspan="2">名称</th><th scope="col" id="qty">数量</th></tr>
        <tr><th scope="col" id="cn">中文</th><th scope="col" id="en">英文</th></tr>
      </thead>
      <tbody>
        <tr><th scope="row" id="row1" rowspan="2">水果</th><td id="apple">苹果</td><td headers="qty" id="appleN">2</td></tr>
        <tr><td id="banana">香蕉</td><td id="bananaN">3</td></tr>
      </tbody>
    </table>
  `;
  const r = tableHeaders(html);
  const idMap = domById(html);
  // 网格：名称跨第 1-2 列、数量在第 3 列；第二行 中文=第 1 列、英文=第 2 列；
  // 数据行中 row1 占第 1 列（跨行），故 apple/banana 落在第 2 列（英文列）、appleN/bananaN 在第 3 列（数量列）。
  // 文档序：name, qty, cn, en, row1, apple, appleN, banana, bananaN
  assert.deepEqual(toIds(tdOf(r, idMap, 'apple').headers, idMap), ['name', 'en', 'row1']);
  // appleN 走显式 headers，只关联 qty，不推断
  assert.deepEqual(tdOf(r, idMap, 'appleN').headers, [idMap.qty]);
  assert.deepEqual(tdOf(r, idMap, 'appleN').issues, []);
  // 第二行 td 先跳过 row1 的跨行占位；row1 仍跨行覆盖
  assert.deepEqual(toIds(tdOf(r, idMap, 'banana').headers, idMap), ['name', 'en', 'row1']);
  assert.deepEqual(toIds(tdOf(r, idMap, 'bananaN').headers, idMap), ['qty', 'row1']);
  assert.equal(r.count.cells, 4);
  assert.equal(r.count.noHeader, 0);
  assert.equal(r.count.invalidReferences, 0);
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
    body: '<table><tr><th scope="col">H</th></tr><tr><td>d</td></tr></table>',
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.count.tables, 1);
  assert.equal(body.cells.length, 1);
  assert.equal(body.cells[0].headers.length, 1);

  // JSON { html }
  res = await fetch(`${base}/table-headers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<table><tr><td headers="nope">d</td></tr></table>' }),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.deepEqual(body.cells[0].headers, []);
  assert.deepEqual(body.cells[0].issues.map((i) => i.type), ['INVALID_HEADER_REFERENCE', 'NO_HEADER']);

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
