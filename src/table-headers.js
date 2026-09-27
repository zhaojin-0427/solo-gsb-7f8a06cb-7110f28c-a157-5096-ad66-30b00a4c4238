'use strict';

const parse5 = require('parse5');

/**
 * 审计一段 HTML 片段中各 <table> 的显式表头关联。
 *
 * 网格（每个 table 独立构建，嵌套表另算）：
 *  - 行只取本表直属 <tr> 以及 thead/tbody/tfoot 下的 <tr>（parse5 为直属 tr
 *    合成的 tbody 没有 sourceCodeLocation，与显式 tbody 据此区分）。
 *  - 每行只放其直属 th/td，按文档序落格；遇到被上方 rowspan 占据的格先跳过。
 *  - rowspan/colspan 仅接受 1～20 的十进制整数（去前后空白后纯数字），否则按 1；
 *    表头覆盖其跨越的所有格。
 *
 * 表头关联（只处理 td，不处理 th）：
 *  - 带 headers 属性时：按空白拆令牌，逐令牌关联本表首个同 id 的 th，按令牌顺序
 *    去重；引用不到（或重复引用 id 但首个同 id 元素不是 th）记 INVALID_HEADER_REFERENCE，
 *    不再自动推断。
 *  - 其余 td：关联与其上方列区间相交的 scope=col 表头、左侧行区间相交的
 *    scope=row 表头（scope 大小写不敏感，须精确等于 col/row），按表头文档序去重；
 *    不处理其他 scope。
 *
 * 结果按 td 文档序输出；dom 是全部元素中文档序从 1 起的全局序号（非 td 也占位），
 * table 是该 td 所属表的从 1 起序号（按表的文档序），headers 为关联到的 th 的
 * 全局元素先序号数组。没有任何有效表头关联时记 NO_HEADER。
 *
 * @param {string} html
 * @returns {{count: object, cells: object[]}}
 */
function tableHeaders(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  // ---- 第一遍：全部元素文档序编号，同时按文档序收集 table ----
  let elementCount = 0;
  const domOf = new Map();
  const tables = [];

  (function number(node) {
    for (const child of node.childNodes || []) {
      if (!child.tagName) continue; // 文本、注释等
      elementCount += 1;
      domOf.set(child, elementCount);
      if (child.tagName.toLowerCase() === 'table') tables.push(child);
      number(child);
    }
  })(fragment);

  // ---- 逐表建网格并解析表头关联 ----
  const cells = [];

  tables.forEach((tableNode, tableIndex) => {
    const tableNo = tableIndex + 1;
    const rows = collectRows(tableNode);

    // id -> 本表文档序首个拥有该 id 的 th（id 映射只在本表内有效）
    const thById = new Map();
    for (const tr of rows) {
      for (const cell of directCells(tr)) {
        if (cell.tagName.toLowerCase() !== 'th') continue;
        const id = getAttr(cell, 'id');
        if (id && !thById.has(id)) thById.set(id, cell);
      }
    }

    // 落格：grid[r][c] 为占用该格的来源单元格（th/td），记录其覆盖矩形
    const grid = []; // grid[r][c] = cell 节点或 null
    const rectOf = new Map(); // cell 节点 -> {r1, c1, r2, c2}
    const tds = []; // 本表全部 td（落格文档序）

    rows.forEach((tr, r) => {
      if (!grid[r]) grid[r] = [];
      let c = 0;
      for (const cell of directCells(tr)) {
        while (grid[r][c]) c += 1; // 跳过跨行占位
        const rowspan = parseSpan(getAttr(cell, 'rowspan'));
        const colspan = parseSpan(getAttr(cell, 'colspan'));
        const r1 = r;
        const c1 = c;
        const r2 = r + rowspan - 1;
        const c2 = c + colspan - 1;
        for (let rr = r1; rr <= r2; rr += 1) {
          if (!grid[rr]) grid[rr] = [];
          for (let cc = c1; cc <= c2; cc += 1) grid[rr][cc] = cell;
        }
        rectOf.set(cell, { r1, c1, r2, c2 });
        if (cell.tagName.toLowerCase() === 'td') tds.push(cell);
        c = c2 + 1;
      }
    });

    // 所有可能作为推断表头的 th（按文档序），供相交筛选后稳定去重
    const colHeaders = []; // scope=col 的 th
    const rowHeaders = []; // scope=row 的 th
    for (const tr of rows) {
      for (const cell of directCells(tr)) {
        if (cell.tagName.toLowerCase() !== 'th' || !hasAttr(cell, 'scope')) continue;
        const scope = getAttr(cell, 'scope').trim().toLowerCase();
        if (scope === 'col') colHeaders.push(cell);
        else if (scope === 'row') rowHeaders.push(cell);
      }
    }

    for (const td of tds) {
      const rect = rectOf.get(td);
      const issues = [];
      let headerNodes = [];

      if (hasAttr(td, 'headers')) {
        // 显式 headers：按令牌顺序关联本表首个同 id 的 th，去重；无效引用逐个报告
        const linked = new Set(); // 已关联的 th 节点
        const reported = new Set(); // 已报告的无效令牌
        const tokens = getAttr(td, 'headers').split(/\s+/).filter(Boolean);
        for (const token of tokens) {
          const th = thById.get(token);
          if (!th) {
            if (!reported.has(token)) {
              reported.add(token);
              issues.push({
                type: 'INVALID_HEADER_REFERENCE',
                refId: token,
                detail: `第 ${domOf.get(td)} 号元素 <td> 的 headers 引用了本表中不存在的 id ${JSON.stringify(token)}`,
              });
            }
            continue;
          }
          if (!linked.has(th)) {
            linked.add(th);
            headerNodes.push(th);
          }
        }
      } else {
        // 自动推断：上方列区间相交的 scope=col、左侧行区间相交的 scope=row
        const matched = [];
        for (const th of colHeaders) {
          const h = rectOf.get(th);
          if (h.r2 < rect.r1 && h.c1 <= rect.c2 && h.c2 >= rect.c1) matched.push(th);
        }
        for (const th of rowHeaders) {
          const h = rectOf.get(th);
          if (h.c2 < rect.c1 && h.r1 <= rect.r2 && h.r2 >= rect.r1) matched.push(th);
        }
        // 两组各自已按文档序；跨组按 th 文档序去重
        matched.sort((a, b) => domOf.get(a) - domOf.get(b));
        const seen = new Set();
        for (const th of matched) {
          if (!seen.has(th)) {
            seen.add(th);
            headerNodes.push(th);
          }
        }
      }

      const headers = headerNodes.map((th) => domOf.get(th));
      if (headers.length === 0) {
        issues.push({
          type: 'NO_HEADER',
          detail: `第 ${domOf.get(td)} 号元素 <td> 没有任何有效表头关联`,
        });
      }

      cells.push({
        node: td,
        dom: domOf.get(td),
        table: tableNo,
        headers,
        issues,
      });
    }
  });

  // 跨表按 td 文档序输出（表间按文档序处理，实际此处通常已经有序）
  cells.sort((a, b) => a.dom - b.dom);

  const allIssues = cells.flatMap((c) =>
    c.issues.map((issue) => ({ ...issue, dom: c.dom, table: c.table }))
  );

  return {
    count: {
      tables: tables.length,
      cells: cells.length,
      issues: allIssues.length,
      invalidHeaderReferences: allIssues.filter((i) => i.type === 'INVALID_HEADER_REFERENCE').length,
      noHeader: allIssues.filter((i) => i.type === 'NO_HEADER').length,
    },
    cells: cells.map((c) => ({
      dom: c.dom,
      tag: 'td',
      table: c.table,
      headers: c.headers,
      issues: c.issues.map((i) =>
        i.type === 'INVALID_HEADER_REFERENCE'
          ? { type: i.type, refId: i.refId, detail: i.detail }
          : { type: i.type, detail: i.detail }
      ),
      ...locationOf(c.node),
    })),
    issues: allIssues.map((i) => ({
      type: i.type,
      dom: i.dom,
      tag: 'td',
      table: i.table,
      ...(i.type === 'INVALID_HEADER_REFERENCE' ? { refId: i.refId } : {}),
      detail: i.detail,
    })),
  };
}

/**
 * 收集本表直属行：直属 <tr>，以及直属 thead/tbody/tfoot 下的 <tr>。
 * 嵌套表的行不在其中（嵌套表不在直接子元素链上）。
 * parse5 为“直属 tr”场景合成的 tbody 没有 sourceCodeLocation；显式与合成的
 * section 容器都统一取其直属 tr（合成容器内即原本的 table 直属行）。
 */
function collectRows(tableNode) {
  const rows = [];
  for (const child of elementChildren(tableNode)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'tr') {
      rows.push(child);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const tr of elementChildren(child)) {
        if (tr.tagName.toLowerCase() === 'tr') rows.push(tr);
      }
    }
  }
  return rows;
}

/** 行的直属 th/td（嵌套表中的单元格不会出现，因为它不是直属子元素）。 */
function directCells(tr) {
  return elementChildren(tr).filter((n) => {
    const tag = n.tagName.toLowerCase();
    return tag === 'th' || tag === 'td';
  });
}

function elementChildren(node) {
  return (node.childNodes || []).filter((n) => n.tagName);
}

/**
 * rowspan/colspan 解析：仅接受 1～20 的十进制整数。
 * 属性去除前后空白后必须为纯数字且数值在区间内，否则按 1。
 */
function parseSpan(raw) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return 1;
  const n = Number(s);
  return n >= 1 && n <= 20 ? n : 1;
}

function locationOf(node) {
  const loc = node.sourceCodeLocation;
  if (loc && typeof loc.startLine === 'number') {
    return { location: { line: loc.startLine, column: loc.startCol } };
  }
  return {};
}

function getAttr(node, name) {
  const attr = node.attrs.find((a) => a.name === name);
  return attr ? attr.value : '';
}

function hasAttr(node, name) {
  return node.attrs.some((a) => a.name === name);
}

module.exports = { tableHeaders };
