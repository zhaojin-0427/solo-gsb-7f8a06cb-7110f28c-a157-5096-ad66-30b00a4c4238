'use strict';

const parse5 = require('parse5');

// 隐式提交算法中会阻止默认提交的 input 类型（无 type 时按 text 处理）
const BLOCKING_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
]);

/**
 * 判定一段 HTML 片段中每个 <input> 在聚焦时按 Enter 能否触发隐式提交。
 *
 * 表单归属：
 *  - 设置 form 属性时，指向文档序首个拥有该 id 的元素；仅当它是 <form> 时有效，
 *    否则该 input 无归属（form 属性存在时不回退到祖先 form）。
 *  - 未设置 form 属性时，取最近的 <form> 祖先。
 *
 * 失效（disabled）：
 *  - 控件自身带 disabled 属性，或位于 disabled <fieldset> 的后代中；
 *  - 例外：fieldset 的第一个 legend 子树内的后代不受该 fieldset 影响。
 *
 * 默认按钮：所属 form 的文档序第一个提交按钮（即使失效也不改选）：
 *  - <button> 无 type 或 type=submit；
 *  - <input> type=submit 或 type=image。
 *
 * 提交判定（仅阻止型 input：无 type 或 type 属于
 * text/search/url/tel/email/password/number）：
 *  - 无归属 / 自身失效：不提交；
 *  - 存在默认按钮：仅当默认按钮可用时提交；
 *  - 无默认按钮：该 form 中可用的阻止型 input 不超过一个时提交。
 *
 * @param {string} html
 * @returns {{count: object, inputs: object[]}}
 */
function implicitSubmit(html) {
  const fragment = parse5.parseFragment(html, { sourceCodeLocationInfo: true });

  const inputs = []; // 所有 input（文档序）
  const submitButtons = []; // 所有提交按钮（文档序）
  const byId = new Map(); // id -> 文档中首个拥有该 id 的元素
  const formDomOf = new Map(); // form 节点 -> 文档序编号
  let elementCount = 0;

  visit(fragment, { forms: [], disabledDepth: 0 });

  function visit(container, state) {
    const children = (container.childNodes || []).filter((n) => n.tagName);
    // 仅当父节点是带 disabled 的 fieldset 时才有“首个 legend 子树”例外
    const parentFieldsetDisabled =
      container.tagName &&
      container.tagName.toLowerCase() === 'fieldset' &&
      hasAttr(container, 'disabled');
    const firstLegend = parentFieldsetDisabled
      ? children.find((c) => c.tagName.toLowerCase() === 'legend')
      : null;

    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      elementCount += 1;

      // disabled fieldset 屏障：除首个 legend 外的子节点深度 +1；首个 legend 子树解除本层屏障
      const disabledDepth =
        state.disabledDepth + (parentFieldsetDisabled && child !== firstLegend ? 1 : 0);

      const id = getAttr(child, 'id');
      if (id && !byId.has(id)) byId.set(id, child);
      if (tag === 'form') formDomOf.set(child, elementCount);

      const forms = tag === 'form' ? [...state.forms, child] : state.forms;
      const nearestForm = forms.length ? forms[forms.length - 1] : null;
      const inDisabledFieldset = disabledDepth > 0;
      const disabled =
        (tag === 'input' || tag === 'button') &&
        (hasAttr(child, 'disabled') || inDisabledFieldset);

      if (tag === 'input') {
        inputs.push({
          node: child,
          dom: elementCount,
          hasType: hasAttr(child, 'type'),
          type: getAttr(child, 'type').trim().toLowerCase(),
          formAttr: hasAttr(child, 'form') ? getAttr(child, 'form') : null,
          nearestForm,
          disabled,
          inDisabledFieldset,
        });
      }

      if (isSubmitButton(child, tag)) {
        submitButtons.push({
          node: child,
          dom: elementCount,
          tag,
          hasType: hasAttr(child, 'type'),
          type: getAttr(child, 'type').trim().toLowerCase(),
          formAttr: hasAttr(child, 'form') ? getAttr(child, 'form') : null,
          nearestForm,
          disabled,
        });
      }

      visit(child, { forms, disabledDepth });
    }
  }

  // form 节点 -> 文档序编号
  const ownerDomOf = (owner) => formDomOf.get(owner) || 0;

  // ---- 表单归属：form 属性优先；缺失/空/指向非 form 元素均为无归属 ----
  const ownerOf = (el) => {
    if (el.formAttr !== null) {
      if (el.formAttr === '') return null;
      const target = byId.get(el.formAttr);
      return target && target.tagName.toLowerCase() === 'form' ? target : null;
    }
    return el.nearestForm;
  };

  // 每个 form 的文档序首个提交按钮（失效也不改选）
  const defaultButtonOf = new Map();
  for (const btn of submitButtons) {
    const owner = ownerOf(btn);
    if (owner && !defaultButtonOf.has(owner)) defaultButtonOf.set(owner, btn);
  }

  // 每个 form 的可用阻止型 input 数量
  const blockingCountOf = new Map();
  for (const inp of inputs) {
    if (inp.disabled || !isBlockingInput(inp)) continue;
    const owner = ownerOf(inp);
    if (owner) blockingCountOf.set(owner, (blockingCountOf.get(owner) || 0) + 1);
  }

  // ---- 逐个 input 判定 ----
  const results = inputs.map((inp) => {
    const owner = ownerOf(inp);
    const defaultButton = owner ? defaultButtonOf.get(owner) || null : null;
    const blocking = isBlockingInput(inp);

    let submits = false;
    let reason;

    if (inp.disabled) {
      reason = inp.inDisabledFieldset && !hasAttr(inp.node, 'disabled')
        ? 'disabled-fieldset'
        : 'disabled';
    } else if (!owner) {
      reason = 'no-form-owner';
    } else if (!blocking) {
      reason = 'not-blocking-type';
    } else if (defaultButton) {
      if (defaultButton.disabled) {
        reason = 'default-button-disabled';
      } else {
        submits = true;
        reason = 'default-button';
      }
    } else {
      // 无默认按钮：本 input 自身也是可用阻止型，计入总数
      const total = blockingCountOf.get(owner) || 0;
      if (total <= 1) {
        submits = true;
        reason = 'single-blocking-input';
      } else {
        reason = 'multiple-blocking-inputs';
      }
    }

    return describe(inp, owner, defaultButton, submits, reason, blockingCountOf.get(owner) || 0, ownerDomOf);
  });

  return {
    count: {
      inputs: results.length,
      blocking: results.filter((r) => r.blocking).length,
      submits: results.filter((r) => r.submits).length,
      noFormOwner: results.filter((r) => r.reason === 'no-form-owner').length,
      disabled: results.filter((r) => r.reason === 'disabled' || r.reason === 'disabled-fieldset').length,
    },
    inputs: results,
  };
}

function isBlockingInput(inp) {
  return !inp.hasType || BLOCKING_INPUT_TYPES.has(inp.type);
}

function isSubmitButton(node, tag) {
  const type = getAttr(node, 'type').trim().toLowerCase();
  if (tag === 'button') return !hasAttr(node, 'type') || type === 'submit';
  if (tag === 'input') return type === 'submit' || type === 'image';
  return false;
}

function describe(inp, owner, defaultButton, submits, reason, blockingTotal, ownerDomOf) {
  const node = inp.node;
  const entry = { dom: inp.dom, tag: 'input' };

  const id = getAttr(node, 'id');
  if (id) entry.id = id;
  if (hasAttr(node, 'name')) entry.name = getAttr(node, 'name');

  // 无 type 属性按 text 状态处理
  entry.type = inp.hasType ? inp.type : 'text';
  if (!inp.hasType) entry.typeMissing = true;
  entry.blocking = isBlockingInput(inp);

  if (inp.formAttr !== null) entry.formAttr = inp.formAttr;
  entry.form = owner
    ? {
        dom: ownerDomOf(owner),
        ...(getAttr(owner, 'id') ? { id: getAttr(owner, 'id') } : {}),
      }
    : null;
  if (inp.formAttr !== null) entry.formAttrValid = Boolean(owner);

  entry.disabled = inp.disabled;
  entry.inDisabledFieldset = inp.inDisabledFieldset;

  entry.defaultButton = defaultButton ? describeButton(defaultButton) : null;

  entry.submits = submits;
  entry.reason = reason;
  entry.detail = buildDetail(inp, defaultButton, reason, blockingTotal);

  const loc = node.sourceCodeLocation;
  if (loc && typeof loc.startLine === 'number') {
    entry.location = { line: loc.startLine, column: loc.startCol };
  }

  return entry;
}

function describeButton(btn) {
  const out = {
    dom: btn.dom,
    tag: btn.tag,
    type: btn.tag === 'button' && !btn.hasType ? 'submit' : btn.type,
    disabled: btn.disabled,
  };
  const id = getAttr(btn.node, 'id');
  if (id) out.id = id;
  if (btn.tag === 'button') {
    const text = textContent(btn.node).replace(/\s+/g, ' ').trim();
    if (text) out.text = truncate(text, 80);
  } else if (hasAttr(btn.node, 'value')) {
    out.value = truncate(getAttr(btn.node, 'value'), 80);
  }
  return out;
}

function buildDetail(inp, defaultButton, reason, blockingTotal) {
  const typeLabel = inp.hasType ? `type="${inp.type}"` : '无 type（按 text 处理）';
  switch (reason) {
    case 'disabled':
      return '控件自身带 disabled 属性，已失效，Enter 不提交';
    case 'disabled-fieldset':
      return '控件位于 disabled fieldset 后代中（首个 legend 子树例外），已失效，Enter 不提交';
    case 'no-form-owner':
      if (inp.formAttr === '') return 'form 属性为空，input 无表单归属，Enter 不提交';
      if (inp.formAttr !== null) {
        const target = inp.formAttr;
        return `form="${target}" 未指向文档序首个同 id 的 form，input 无表单归属，Enter 不提交`;
      }
      return 'input 不在任何 form 内，Enter 不提交';
    case 'not-blocking-type':
      return `${typeLabel} 不是阻止型输入（仅无 type 或 text/search/url/tel/email/password/number 会触发隐式提交），Enter 不提交`;
    case 'default-button':
      return `所属 form 的默认按钮是第 ${defaultButton.dom} 号 <${defaultButton.tag}>（文档序首个提交按钮，当前可用），Enter 触发其提交`;
    case 'default-button-disabled':
      return `所属 form 的默认按钮是第 ${defaultButton.dom} 号 <${defaultButton.tag}>，但它已失效且不会改选其他按钮，Enter 不提交`;
    case 'single-blocking-input':
      return '所属 form 没有提交按钮，且可用阻止型输入仅此一个，Enter 直接提交表单';
    case 'multiple-blocking-inputs':
      return `所属 form 没有提交按钮，且存在 ${blockingTotal} 个可用阻止型输入（超过一个），Enter 不提交`;
    default:
      return reason;
  }
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

module.exports = { implicitSubmit };
