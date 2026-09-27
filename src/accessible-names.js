'use strict';

const parse5 = require('parse5');

// 可被 label 关联的表单控件
const LABELABLE_TAGS = new Set(['button', 'input', 'select', 'textarea']);
// 计算文本时跳过其子树的标签
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'template']);

// issues 排序时的类型优先级
const ISSUE_ORDER = { MISSING_REFERENCE: 0, CIRCULAR_REFERENCE: 1, UNNAMED: 2 };

/**
 * 计算一段 HTML 片段中各元素的可访问名称（accessible name）。
 *
 * 目标元素（按文档序从 1 起编号 dom）：
 *  button、a[href]、非 hidden 的 input、select、textarea，以及任何带非空 role 的元素。
 *
 * 名称计算优先级（统一折叠空白）：
 *  1. aria-labelledby：按令牌顺序解析 id 引用并拼接；被引用元素若自身也带
 *     aria-labelledby 则递归展开，否则取其文本内容。引用缺失记 MISSING_REFERENCE，
 *     引用成环记 CIRCULAR_REFERENCE；整体得不到文本时继续向下回退。
 *  2. aria-label（折叠空白后非空）。
 *  3. 表单控件（button/input/select/textarea）：取文档序最靠前的关联 label——
 *     先考虑 for 指向本控件 id 的 label，再考虑包裹本控件且 for 未指向别处的 label；
 *     label 文本会剔除其中嵌套的控件子树。
 *  4. 自身文本内容。
 *  四步都得不到文本时记 UNNAMED，source 为 null。
 *
 * @param {string} html
 * @returns {{count: object, elements: object[], issues: object[]}}
 */
function accessibleNames(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  // ---- 第一遍：收集目标元素、id 索引、label 列表 ----
  const targets = []; // {node, tag, dom, ancestorLabels}
  const byId = new Map(); // id -> 文档中首个拥有该 id 的元素
  const labels = []; // 所有 label 元素（文档序）
  const docIndexOf = new Map(); // 元素节点 -> 文档序下标（从 1 起，含非目标元素）
  let elementCount = 0;

  walk(fragment, [], (node, ancestorLabels) => {
    elementCount += 1;
    docIndexOf.set(node, elementCount);

    const tag = node.tagName.toLowerCase();
    const id = getAttr(node, 'id');
    if (id && !byId.has(id)) byId.set(id, node);

    if (tag === 'label') labels.push(node);

    if (isTarget(node, tag)) {
      targets.push({ node, tag, dom: targets.length + 1, ancestorLabels });
    }

    return tag === 'label' ? [...ancestorLabels, node] : ancestorLabels;
  });

  // ---- 第二遍：逐元素计算名称 ----
  const elements = [];
  const issues = [];

  for (const target of targets) {
    const { node, tag, dom } = target;
    let name = '';
    let source = null;

    // 1. aria-labelledby（递归展开，按令牌顺序拼接）
    const labelledbyRaw = hasAttr(node, 'aria-labelledby') ? getAttr(node, 'aria-labelledby').trim() : '';
    if (labelledbyRaw) {
      const text = resolveLabelledby(target, labelledbyRaw.split(/\s+/), byId, issues);
      if (text) {
        name = text;
        source = 'aria-labelledby';
      }
    }

    // 2. aria-label
    if (!name && hasAttr(node, 'aria-label')) {
      const text = collapse(getAttr(node, 'aria-label'));
      if (text) {
        name = text;
        source = 'aria-label';
      }
    }

    // 3. 表单控件：for 关联或包裹的 label
    if (!name && LABELABLE_TAGS.has(tag)) {
      const label = findLabelFor(target, labels, docIndexOf);
      if (label) {
        const text = collapse(labelText(label));
        if (text) {
          name = text;
          source = 'label';
        }
      }
    }

    // 4. 自身文本内容
    if (!name) {
      const text = collapse(ownText(node));
      if (text) {
        name = text;
        source = 'content';
      }
    }

    if (!name) {
      issues.push({
        type: 'UNNAMED',
        dom,
        detail: `${describeTarget(target)}没有可访问名称`,
      });
    }

    elements.push(describe(target, name, source));
  }

  issues.sort((a, b) => {
    if (a.dom !== b.dom) return a.dom - b.dom;
    const diff = ISSUE_ORDER[a.type] - ISSUE_ORDER[b.type];
    if (diff !== 0) return diff;
    const ka = a.refId || (a.chain ? a.chain.join(' ') : '');
    const kb = b.refId || (b.chain ? b.chain.join(' ') : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    count: {
      elements: elements.length,
      named: elements.filter((e) => e.source !== null).length,
      unnamed: elements.filter((e) => e.source === null).length,
      issues: issues.length,
    },
    elements,
    issues,
  };
}

/**
 * 解析 aria-labelledby：按令牌顺序解析每个 id 引用。
 * 被引用元素若自身带 aria-labelledby 则递归展开，否则贡献其文本内容。
 * 缺失引用与循环引用记入 issues（同一目标元素内按引用去重）。
 *
 * @returns {string} 拼接并折叠空白后的文本（可能为空串）
 */
function resolveLabelledby(target, tokens, byId, issues) {
  const parts = [];
  const reported = new Set();

  const report = (key, issue) => {
    if (reported.has(key)) return;
    reported.add(key);
    issues.push(issue);
  };

  const visit = (idToken, path) => {
    const ref = byId.get(idToken);
    if (!ref) {
      report(`missing:${idToken}`, {
        type: 'MISSING_REFERENCE',
        dom: target.dom,
        refId: idToken,
        detail: `${describeTarget(target)}的 aria-labelledby 引用了不存在的 id ${JSON.stringify(idToken)}`,
      });
      return;
    }
    const cycleAt = path.indexOf(ref);
    if (cycleAt !== -1) {
      const chain = [...path.slice(cycleAt).map((n) => getAttr(n, 'id')), idToken];
      report(`cycle:${chain.join('>')}`, {
        type: 'CIRCULAR_REFERENCE',
        dom: target.dom,
        chain,
        detail: `${describeTarget(target)}的 aria-labelledby 引用形成循环：${chain.join(' → ')}`,
      });
      return;
    }
    const refLabelledby = hasAttr(ref, 'aria-labelledby') ? getAttr(ref, 'aria-labelledby').trim() : '';
    if (refLabelledby) {
      for (const t of refLabelledby.split(/\s+/)) visit(t, [...path, ref]);
    } else {
      const text = collapse(ownText(ref));
      if (text) parts.push(text);
    }
  };

  // 遍历集合包含目标元素自身：自引用同样视为循环
  for (const t of tokens) visit(t, [target.node]);

  return collapse(parts.join(' '));
}

/**
 * 找出控件的关联 label：for 指向本控件 id 的 label 与包裹本控件的 label 中，
 * 取文档序最靠前的一个。包裹 label 的 for 指向其他控件时不算数。
 */
function findLabelFor(target, labels, docIndexOf) {
  const id = getAttr(target.node, 'id');
  let best = null;
  let bestIdx = Infinity;

  if (id) {
    for (const label of labels) {
      if (getAttr(label, 'for') === id) {
        const idx = docIndexOf.get(label);
        if (idx < bestIdx) {
          best = label;
          bestIdx = idx;
        }
      }
    }
  }

  for (const label of target.ancestorLabels) {
    const forAttr = hasAttr(label, 'for') && getAttr(label, 'for') !== '' ? getAttr(label, 'for') : null;
    if (forAttr !== null && forAttr !== id) continue; // for 指向别处
    const idx = docIndexOf.get(label);
    if (idx < bestIdx) {
      best = label;
      bestIdx = idx;
    }
  }

  return best;
}

/**
 * label 的文本内容：剔除其中嵌套的可命名控件子树（如 select 的 option 文本），
 * 以及 script/style/template。
 */
function labelText(labelNode) {
  let out = '';
  const stack = [...(labelNode.childNodes || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.nodeName === '#text') {
      out += n.value;
      continue;
    }
    if (!n.tagName || !n.childNodes) continue;
    const tag = n.tagName.toLowerCase();
    if (SKIP_TEXT_TAGS.has(tag) || LABELABLE_TAGS.has(tag)) continue;
    stack.unshift(...n.childNodes);
  }
  return out;
}

/** 元素自身（含后代）的文本内容，跳过 script/style/template 子树。 */
function ownText(node) {
  let out = '';
  const stack = [...(node.childNodes || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.nodeName === '#text') {
      out += n.value;
      continue;
    }
    if (!n.tagName || !n.childNodes) continue;
    if (SKIP_TEXT_TAGS.has(n.tagName.toLowerCase())) continue;
    stack.unshift(...n.childNodes);
  }
  return out;
}

function isTarget(node, tag) {
  if (tag === 'input' && getAttr(node, 'type').trim().toLowerCase() === 'hidden') return false;
  if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'a') return hasAttr(node, 'href');
  return hasAttr(node, 'role') && getAttr(node, 'role').trim() !== '';
}

function describe(target, name, source) {
  const { node, tag, dom } = target;
  const entry = { dom, tag };

  const id = getAttr(node, 'id');
  if (id) entry.id = id;

  const role = getAttr(node, 'role').trim();
  if (role) entry.role = role;

  if (tag === 'a' && hasAttr(node, 'href')) entry.href = truncate(getAttr(node, 'href'), 200);

  const type = getAttr(node, 'type');
  if ((tag === 'input' || tag === 'button') && type) entry.type = type;

  entry.name = name;
  entry.source = source; // null 表示没有可访问名称

  const loc = node.sourceCodeLocation;
  if (loc && typeof loc.startLine === 'number') {
    entry.location = { line: loc.startLine, column: loc.startCol };
  }

  return entry;
}

function describeTarget(target) {
  const id = getAttr(target.node, 'id');
  return `第 ${target.dom} 号元素 <${target.tag}>${id ? `#${id}` : ''}`;
}

/**
 * 深度优先遍历元素树。visitor 返回进入子节点时携带的状态；
 * 本模块不跳过任何子树（display:none 等不影响名称计算）。
 */
function walk(node, state, visitor) {
  const children = node.childNodes || [];
  for (const child of children) {
    if (!child.tagName) continue; // 文本、注释等
    const next = visitor(child, state);
    walk(child, next, visitor);
  }
}

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function getAttr(node, name) {
  const attr = node.attrs.find((a) => a.name === name);
  return attr ? attr.value : '';
}

function hasAttr(node, name) {
  return node.attrs.some((a) => a.name === name);
}

module.exports = { accessibleNames };
