'use strict';

const parse5 = require('parse5');

const NATIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);

/**
 * 审计一段 HTML 片段的焦点（Tab）顺序。
 *
 * 规则：
 *  - 可聚焦候选：a[href]、button、非 hidden 的 input、select、textarea，
 *    以及任何显式设置了 tabindex 属性的元素。
 *  - 排除：自身或祖先带 hidden / inert、内联 display:none / visibility:hidden，
 *    以及控件自身 disabled。
 *  - tabindex 正整数按值升序（同值按文档序），随后是 tabindex=0 与默认控件（文档序），
 *    负整数跳过；无法解析为整数的非法 tabindex 忽略其值并记一条风险。
 *  - radio 按最近 form（无 form 以文档根）与 name 分组：选中成员中最后一个入序，
 *    无选中时第一个可用成员入序，其余成员跳过；无 name 的 radio 各自独立。
 *  - 位于 aria-hidden="true" 子树内却可 Tab 到的元素记一条风险。
 *
 * @param {string} html
 * @returns {{tabOrder: object[], skipped: object[], risks: object[], count: object}}
 */
function auditHtml(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  const candidates = [];

  walk(fragment, { hidden: false, ariaHidden: false, form: null }, (node, state) => {
    const tag = node.tagName.toLowerCase();

    // 自身或祖先 hidden / inert / display:none / visibility:hidden：整棵子树排除
    const selfHidden =
      hasAttr(node, 'hidden') ||
      hasAttr(node, 'inert') ||
      hasInlineDisplayNone(node) ||
      hasInlineVisibilityHidden(node);
    const hidden = state.hidden || selfHidden;
    if (hidden) return { skipSubtree: true, hidden: true, ariaHidden: true, form: state.form };

    // aria-hidden 按最近祖先取值（自身显式声明优先）
    const ariaHidden = hasAttr(node, 'aria-hidden')
      ? getAttr(node, 'aria-hidden').trim().toLowerCase() === 'true'
      : state.ariaHidden;

    const form = tag === 'form' ? node : state.form;

    if (isCandidate(node, tag) && !isControlDisabled(node, tag)) {
      candidates.push(buildCandidate(node, tag, candidates.length + 1, ariaHidden, form));
    }

    return { hidden, ariaHidden, form };
  });

  // ---- radio 分组 ----
  const radioGroups = new Map(); // formNode|null -> Map(name -> candidates[])
  for (const c of candidates) {
    if (!c.isRadio || c.name === null) continue; // 无 name 的 radio 独立
    let byName = radioGroups.get(c.form);
    if (!byName) {
      byName = new Map();
      radioGroups.set(c.form, byName);
    }
    const list = byName.get(c.name) || [];
    list.push(c);
    byName.set(c.name, list);
  }

  const skipped = [];
  const representativeOf = new Set();
  const inRadioGroup = new Set();
  const groupInfoOf = new Map();

  for (const byName of radioGroups.values()) {
    for (const [name, members] of byName) {
      const checked = members.filter((m) => m.checked);
      const rep = checked.length ? checked[checked.length - 1] : members[0];
      representativeOf.add(rep);
      groupInfoOf.set(rep, { name, size: members.length, checked: rep.checked });
      for (const m of members) {
        inRadioGroup.add(m);
        if (m !== rep) {
          skipped.push({
            candidate: m,
            reason: 'radio-group',
            detail: `radio 组 name=${JSON.stringify(name)} 仅一个成员参与 Tab 顺序，由第 ${rep.dom} 号元素代表`,
            repDom: rep.dom,
          });
        }
      }
    }
  }

  // ---- 分类 ----
  const positive = []; // {c, value}
  const defaults = []; // 文档序
  const risks = [];

  for (const c of candidates) {
    if (inRadioGroup.has(c) && !representativeOf.has(c)) continue; // 非代表 radio 已记入 skipped

    if (c.tabindexRaw !== null && c.tabindexValue === null) {
      // 非法 tabindex
      risks.push({
        type: 'INVALID_TABINDEX',
        candidate: c,
        detail: `非法的 tabindex 值 ${JSON.stringify(c.tabindexRaw)}，无法解析为整数，浏览器会忽略该属性`,
      });
      if (!c.native) {
        // 非原生控件且无合法 tabindex：本身不可聚焦，跳过
        skipped.push({
          candidate: c,
          reason: 'invalid-tabindex',
          detail: `非法 tabindex ${JSON.stringify(c.tabindexRaw)}，元素不可聚焦`,
        });
        continue;
      }
      // 原生控件：忽略非法值，按默认顺序入序
      defaults.push(c);
      continue;
    }

    if (c.tabindexValue !== null) {
      if (c.tabindexValue < 0n) {
        skipped.push({
          candidate: c,
          reason: 'negative-tabindex',
          detail: `tabindex=${c.tabindexRaw} 为负值，元素可编程聚焦但不参与 Tab 顺序`,
        });
        continue;
      }
      if (c.tabindexValue > 0n) {
        positive.push({ c, value: c.tabindexValue });
        continue;
      }
    }
    defaults.push(c);
  }

  positive.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.c.dom - b.c.dom));
  defaults.sort((a, b) => a.dom - b.dom);

  const ordered = [...positive.map((p) => p.c), ...defaults];

  const tabOrder = ordered.map((c, i) => {
    const entry = describe(c);
    entry.seq = i + 1;
    if (groupInfoOf.has(c)) entry.radioGroup = groupInfoOf.get(c);
    return entry;
  });

  // ---- 风险：aria-hidden=true 下仍可 Tab 到 ----
  for (const c of ordered) {
    if (c.ariaHidden) {
      risks.push({
        type: 'FOCUSABLE_IN_ARIA_HIDDEN',
        candidate: c,
        detail: '元素位于 aria-hidden="true" 子树内，却仍可通过 Tab 聚焦，屏幕阅读器用户无法得知其存在',
      });
    }
  }

  skipped.sort((a, b) => a.candidate.dom - b.candidate.dom);
  risks.sort((a, b) => {
    const sa = a.candidate.dom;
    const sb = b.candidate.dom;
    if (sa !== sb) return sa - sb;
    return a.type < b.type ? -1 : 1;
  });

  return {
    count: {
      candidates: candidates.length,
      tabOrder: tabOrder.length,
      skipped: skipped.length,
      risks: risks.length,
    },
    tabOrder,
    skipped: skipped.map((s) => ({
      reason: s.reason,
      detail: s.detail,
      ...(s.repDom ? { repDom: s.repDom } : {}),
      ...describe(s.candidate),
    })),
    risks: risks.map((r) => ({
      type: r.type,
      detail: r.detail,
      ...describe(r.candidate),
      ...(ordered.includes(r.candidate) ? { seq: ordered.indexOf(r.candidate) + 1 } : {}),
    })),
  };
}

/**
 * 深度优先遍历元素树。
 * visitor 返回进入子节点的状态；返回 skipSubtree=true 时不遍历子树。
 */
function walk(node, state, visitor) {
  const children = node.childNodes || [];
  for (const child of children) {
    if (!child.tagName) continue; // 文本、注释等
    const next = visitor(child, state);
    if (next && next.skipSubtree) continue;
    if (next) walk(child, next, visitor);
  }
}

function isCandidate(node, tag) {
  if (tag === 'input' && getAttr(node, 'type').trim().toLowerCase() === 'hidden') return false;
  if (NATIVE_TAGS.has(tag)) {
    if (tag === 'a') return hasAttr(node, 'href');
    return true;
  }
  return hasAttr(node, 'tabindex');
}

function isControlDisabled(node, tag) {
  return CONTROL_TAGS.has(tag) && hasAttr(node, 'disabled');
}

function buildCandidate(node, tag, dom, ariaHidden, form) {
  const type = tag === 'input' || tag === 'button' ? getAttr(node, 'type').trim().toLowerCase() : '';
  const tabindexRaw = hasAttr(node, 'tabindex') ? getAttr(node, 'tabindex') : null;
  return {
    node,
    tag,
    dom,
    ariaHidden,
    form,
    native: NATIVE_TAGS.has(tag) && (tag !== 'a' || hasAttr(node, 'href')),
    isRadio: tag === 'input' && type === 'radio',
    name: tag === 'input' && hasAttr(node, 'name') ? getAttr(node, 'name') : null,
    checked: tag === 'input' && hasAttr(node, 'checked'),
    tabindexRaw,
    tabindexValue: tabindexRaw === null ? undefined : parseTabindex(tabindexRaw),
  };
}

/**
 * 按 HTML 规则解析 tabindex：去除前后空白后必须恰好是一个可选负号加数字序列，
 * 否则为非法值（浏览器将忽略该属性）。
 */
function parseTabindex(raw) {
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return BigInt(s);
}

function describe(c) {
  const node = c.node;
  const entry = { dom: c.dom, tag: c.tag };

  const id = getAttr(node, 'id');
  if (id) entry.id = id;

  if (c.tag === 'a' && hasAttr(node, 'href')) entry.href = truncate(getAttr(node, 'href'), 200);

  const type = getAttr(node, 'type');
  if ((c.tag === 'input' || c.tag === 'button') && type) entry.type = type;

  if (c.name !== null) entry.name = c.name;
  if (c.isRadio) entry.checked = c.checked;
  if (c.tabindexRaw !== null) {
    entry.tabindex = c.tabindexRaw;
    if (c.tabindexValue !== null && c.tabindexValue !== undefined) {
      entry.tabindexValue = Number(c.tabindexValue);
    }
  }
  if (c.ariaHidden) entry.ariaHidden = true;

  const loc = node.sourceCodeLocation;
  if (loc && typeof loc.startLine === 'number') {
    entry.location = { line: loc.startLine, column: loc.startCol };
  }

  const text = textContent(node).replace(/\s+/g, ' ').trim();
  if (text) entry.text = truncate(text, 80);

  return entry;
}

function textContent(node) {
  let out = '';
  const stack = [...(node.childNodes || [])];
  while (stack.length) {
    const n = stack.shift();
    if (n.nodeName === '#text') out += n.value;
    else if (n.childNodes) stack.unshift(...n.childNodes);
  }
  return out;
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

function inlineDeclarations(node) {
  if (!hasAttr(node, 'style')) return [];
  const decls = [];
  for (const part of getAttr(node, 'style').split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part
      .slice(idx + 1)
      .trim()
      .replace(/\s*!important\s*$/i, '')
      .toLowerCase();
    if (prop) decls.push([prop, value]);
  }
  return decls;
}

function lastInlineValue(node, prop) {
  let value = null;
  for (const [p, v] of inlineDeclarations(node)) {
    if (p === prop) value = v;
  }
  return value;
}

function hasInlineDisplayNone(node) {
  return lastInlineValue(node, 'display') === 'none';
}

function hasInlineVisibilityHidden(node) {
  return lastInlineValue(node, 'visibility') === 'hidden';
}

module.exports = { auditHtml };
