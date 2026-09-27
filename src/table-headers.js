'use strict';

const parse5 = require('parse5');

// tr 的合法父元素（parse5 会为裸 tr 补出隐式 tbody）
const ROW_SECTION_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot']);
// rowspan / colspan 允许的最大值
const MAX_SPAN = 20;

/**
 * 审计一段 HTML 片段中各 <table> 的显式表头关联。
 *
 * 网格构建（每个 table 独立，嵌套表另算）：
 *  - 只计本表直属 tr 及 thead/tbody/tfoot 下的 tr（解析器补出的隐式 tbody 同样计入）；
 *  - 按文档序放置每个 tr 直属的 th、td，放置前先跳过被跨行（rowspan）占用的格；
 *  - rowspan、colspan 仅接受 1～20 的十进制整数（允许前后空白），否则按 1；
 *  - 表头覆盖其跨越的全部格（按矩形区间求交）。
 *
 * 表头关联（仅返回 td；dom 为全部元素中文档序从 1 起的编号）：
 *  - 带 headers 属性的 td：按令牌顺序关联本表首个同 id 的 th，按首次出现去重，
 *    引用不到（不存在、指向非 th、指向其他表）按令牌去重后报 INVALID_HEADER_REFERENCE，
 *    不再自动推断；
 *  - 其余 td：关联上方（表头起始行严格更小）列区间相交的 scope=col 表头，
 *    以及左侧（表头起始列严格更小）行区间相交的 scope=row 表头，
 *    按表头文档序去重；不处理 scope 的其他取值；
 *  - 关联不到任何表头的 td 报 NO_HEADER。
 *
 * @param {string} html
 * @returns {{count: object, cells: object[], issues: object[]}}
 */
function tableHeaders(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  const infos = []; // 各表信息，按文档序
  const domOf = new Map(); // 元素节点 -> 全局文档序编号（从 1 起）
  let elementCount = 0;

  // ---- 第一遍：全局元素编号；识别 table 及其所属行（仅本表/本表行组下的 tr）----
  walk(fragment, null);

  function walk(container, nearestTable) {
    const containerTag = container.tagName ? container.tagName.toLowerCase() : '';
    for (const child of container.childNodes || []) {
      if (!child.tagName) continue; // 文本、注释等
      elementCount += 1;
      domOf.set(child, elementCount);

      const tag = child.tagName.toLowerCase();
      let nextTable = nearestTable;

      if (tag === 'table') {
        const info = { node: child, index: infos.length + 1, rows: [] };
        infos.push(info);
        nextTable = info;
      } else if (tag === 'tr' && nearestTable && ROW_SECTION_TAGS.has(containerTag)) {
        // 嵌套表中的 tr 此时 nearestTable 已是内层表，天然各归各表
        nearestTable.rows.push(child);
      }

      walk(child, nextTable);
    }
  }

  const cells = []; // 全部 td（按文档序）

  for (const info of infos) {
    // ---- 第二遍（逐表）：建网格 ----
    const gridCells = []; // 本表全部 th/td，行优先即文档序
    const occupied = new Set(); // 被跨行/跨列占用的 "行:列"

    info.rows.forEach((tr, rowIndex) => {
      let col = 0; // 每行都从第 0 列开始，逐格跳过跨行占位
      for (const child of tr.childNodes || []) {
        if (!child.tagName) continue;
        const kind = child.tagName.toLowerCase();
        if (kind !== 'th' && kind !== 'td') continue;

        // 先跳过上方跨行（以及同行已占用）的占位
        while (occupied.has(`${rowIndex}:${col}`)) col += 1;

        const rowspan = parseSpan(hasAttr(child, 'rowspan') ? getAttr(child, 'rowspan') : null);
        const colspan = parseSpan(hasAttr(child, 'colspan') ? getAttr(child, 'colspan') : null);
        const cell = {
          node: child,
          dom: domOf.get(child),
          kind,
          r0: rowIndex,
          c0: col,
          r1: rowIndex + rowspan - 1,
          c1: col + colspan - 1,
          rowspan,
          colspan,
          scope: scopeOf(child),
          hasHeadersAttr: hasAttr(child, 'headers'),
          headersRaw: getAttr(child, 'headers'),
        };
        gridCells.push(cell);

        for (let r = cell.r0; r <= cell.r1; r += 1) {
          for (let c = cell.c0; c <= cell.c1; c += 1) occupied.add(`${r}:${c}`);
        }
        col = cell.c1 + 1;
      }
    });

    // 本表 id -> 文档序首个同 id 的 th（嵌套表的 th 不会进入外表映射）
    const thById = new Map();
    const ths = [];
    for (const cell of gridCells) {
      if (cell.kind !== 'th') continue;
      ths.push(cell);
      const id = getAttr(cell.node, 'id');
      if (id && !thById.has(id)) thById.set(id, cell);
    }

    // ---- 逐 td 关联表头（td 在 gridCells 中已是文档序）----
    for (const cell of gridCells) {
      if (cell.kind !== 'td') continue;
      cells.push(resolveCell(info, cell, ths, thById));
    }
  }

  // 嵌套表的 td 在文档序上夹在其容器 td 与后续外表 td 之间，统一按全局 dom 排序
  cells.sort((a, b) => a.dom - b.dom);
  const issues = cells.flatMap((cell) => cell.issues);

  return {
    count: {
      tables: infos.length,
      cells: cells.length,
      withHeaders: cells.filter((c) => c.headers.length > 0).length,
      noHeader: issues.filter((i) => i.type === 'NO_HEADER').length,
      invalidReferences: issues.filter((i) => i.type === 'INVALID_HEADER_REFERENCE').length,
      issues: issues.length,
    },
    cells,
    issues,
  };
}

/**
 * 计算单个 td 的表头关联与其问题。
 */
function resolveCell(info, cell, ths, thById) {
  const issues = [];
  const headers = []; // 关联到的 th 全局文档序编号

  const addHeader = (th, seen) => {
    if (seen.has(th.dom)) return;
    seen.add(th.dom);
    headers.push(th.dom);
  };

  if (cell.hasHeadersAttr) {
    // 显式 headers：按令牌顺序取本表首个同 id 的 th；不再自动推断
    const seen = new Set();
    const reported = new Set();
    for (const token of tokenize(cell.headersRaw)) {
      const th = thById.get(token);
      if (th) {
        addHeader(th, seen);
      } else if (!reported.has(token)) {
        reported.add(token);
        issues.push({
          type: 'INVALID_HEADER_REFERENCE',
          dom: cell.dom,
          table: info.index,
          refId: token,
          detail: `${describeCell(cell, info.index)}的 headers 属性引用了本表中不存在的 id ${JSON.stringify(token)} 的 <th>`,
        });
      }
    }
  } else {
    // 自动推断：上方列区间相交的 scope=col + 左侧行区间相交的 scope=row，按表头文档序去重
    const seen = new Set();
    for (const th of ths) {
      const colMatch =
        th.scope === 'col' &&
        th.r0 < cell.r0 && // 严格在上方
        intervalsOverlap(th.c0, th.c1, cell.c0, cell.c1);
      const rowMatch =
        th.scope === 'row' &&
        th.c0 < cell.c0 && // 严格在左侧
        intervalsOverlap(th.r0, th.r1, cell.r0, cell.r1);
      if (colMatch || rowMatch) addHeader(th, seen);
    }
  }

  if (headers.length === 0) {
    issues.push({
      type: 'NO_HEADER',
      dom: cell.dom,
      table: info.index,
      detail: `${describeCell(cell, info.index)}没有关联到任何表头`,
    });
  }

  const entry = {
    dom: cell.dom,
    table: info.index,
    headers,
    issues,
  };

  const loc = cell.node.sourceCodeLocation;
  if (loc && typeof loc.startLine === 'number') {
    entry.location = { line: loc.startLine, column: loc.startCol };
  }

  return entry;
}

/**
 * 解析 rowspan / colspan：去前后空白后必须恰好是 1～20 的十进制整数，否则按 1。
 */
function parseSpan(raw) {
  if (raw === null) return 1;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return 1;
  const n = Number(s);
  return n >= 1 && n <= MAX_SPAN ? n : 1;
}

/** 仅接受 scope=col / scope=row（大小写不敏感、去前后空白）；其他取值不参与推断。 */
function scopeOf(node) {
  if (!hasAttr(node, 'scope')) return null;
  const scope = getAttr(node, 'scope').trim().toLowerCase();
  return scope === 'col' || scope === 'row' ? scope : null;
}

function intervalsOverlap(a0, a1, b0, b1) {
  return a0 <= b1 && b0 <= a1;
}

function tokenize(value) {
  const s = String(value).trim();
  return s ? s.split(/\s+/) : [];
}

function describeCell(cell, tableIndex) {
  return `第 ${cell.dom} 号元素 <td>（表 ${tableIndex}）`;
}

function getAttr(node, name) {
  const attr = node.attrs.find((a) => a.name === name);
  return attr ? attr.value : '';
}

function hasAttr(node, name) {
  return node.attrs.some((a) => a.name === name);
}

module.exports = { tableHeaders };
