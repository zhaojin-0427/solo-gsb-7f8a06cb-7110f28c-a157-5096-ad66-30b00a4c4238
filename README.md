# 焦点审计 API（Focus Audit API）

用 **Node.js + Express + parse5** 实现的可访问性审计服务，提供四个接口：

- `POST /audit`：提交一段 HTML 片段，返回其中可聚焦控件的 Tab 顺序、从 1 起的元素序号以及可访问性风险
- `POST /accessible-names`：计算片段中控件与带 `role` 元素的可访问名称（accessible name），并报告缺失/循环引用与无名称元素
- `POST /implicit-submit`：判定片段中每个 `<input>` 聚焦后按 Enter 能否触发[隐式提交（implicit submission）](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission)，返回表单归属、默认按钮、结果与原因
- `POST /table-headers`：为每个 `<table>` 独立建立网格，审计每个 `<td>` 的显式表头（`<th>`）关联，返回 td 的全局元素先序号、所属表格序号、关联表头的全局先序号与问题

## 审计规则

### 纳入 Tab 计算的元素

- `a[href]`
- `button`
- 非 `hidden` 类型的 `input`
- `select`、`textarea`
- 任何显式设置了 `tabindex` 属性的元素

### 排除条件（自身或祖先满足任一即排除整棵子树）

- 带 `hidden` 或 `inert` 属性
- 内联样式 `display: none`
- 内联样式 `visibility: hidden`
- 控件自身带 `disabled` 属性（`button` / `input` / `select` / `textarea`）

### Tab 顺序

1. 正 `tabindex`（≥ 1）：按数值升序；数值相同按文档顺序
2. 随后是 `tabindex="0"` 与无 `tabindex` 的原生控件：统一按文档顺序
3. 负 `tabindex` 不参与 Tab 顺序（会列入 `skipped`）
4. 无法解析为整数的非法 `tabindex`：浏览器忽略该属性，同时报一条 `INVALID_TABINDEX` 风险（非原生元素因此不可聚焦）

### radio 分组

- 按**最近的 `<form>` 祖先**分组；不在任何 form 内则以文档根为分组作用域
- 同一作用域内再按 `name` 分组
- 组内选中（`checked`）成员中的**最后一个**作为代表参与 Tab 顺序；没有选中项时取**第一个可用**成员；其余成员列入 `skipped`
- 没有 `name` 的 radio 各自独立，不参与分组

### 风险（risks）

- `FOCUSABLE_IN_ARIA_HIDDEN`：元素位于 `aria-hidden="true"` 子树内（自身显式声明优先），却仍可通过 Tab 聚焦
- `INVALID_TABINDEX`：`tabindex` 属性值不是合法整数

每个结果元素都带：

- `dom`：从 1 起的**文档序**元素号
- `seq`：在 Tab 顺序中的**从 1 起序号**（仅 `tabOrder`/入序风险含此字段）

## 启动

### Docker Compose 一键启动（推荐）

```bash
docker compose up --build
```

服务启动后监听 <http://localhost:3000>。

### Docker

```bash
docker build -t focus-audit .
docker run --rm -p 3000:3000 focus-audit
```

### 本地 Node.js 直接运行（需要 Node.js ≥ 20）

```bash
npm install
npm start
```

默认地址：<http://localhost:3000>

可用环境变量 `PORT`（默认 3000）、`HOST`（默认 `0.0.0.0`）修改监听配置。

## 使用

### `POST /audit`

请求体支持两种形式：

1. 直接发送 HTML 片段（`Content-Type: text/html`）
2. JSON：`{ "html": "<片段>" }`（`Content-Type: application/json`）

```bash
curl -X POST http://localhost:3000/audit \
  -H 'Content-Type: text/html' \
  --data-binary '<button>提交</button>
<div aria-hidden="true"><a href="/help">帮助</a></div>
<form>
  <input type="radio" name="color" value="r">
  <input type="radio" name="color" value="g" checked>
</form>
<div tabindex="wat">坏 tabindex</div>'
```

返回示例（节选）：

```json
{
  "count": { "candidates": 5, "tabOrder": 3, "skipped": 2, "risks": 2 },
  "tabOrder": [
    { "dom": 1, "tag": "button", "text": "提交", "seq": 1 },
    { "dom": 2, "tag": "a", "href": "/help", "ariaHidden": true, "text": "帮助", "seq": 2 },
    {
      "dom": 4, "tag": "input", "type": "radio", "name": "color",
      "checked": true, "seq": 3,
      "radioGroup": { "name": "color", "size": 2, "checked": true }
    }
  ],
  "skipped": [
    { "reason": "radio-group", "dom": 3, "tag": "input", "repDom": 4, "...": "..." },
    { "reason": "invalid-tabindex", "dom": 5, "tag": "div", "tabindex": "wat", "...": "..." }
  ],
  "risks": [
    { "type": "FOCUSABLE_IN_ARIA_HIDDEN", "dom": 2, "seq": 2, "...": "..." },
    { "type": "INVALID_TABINDEX", "dom": 5, "tabindex": "wat", "...": "..." }
  ]
}
```

`skipped.reason` 取值：

- `negative-tabindex`：负 `tabindex`，不参与 Tab 顺序
- `radio-group`：radio 组内的非代表成员（`repDom` 指向代表元素的 dom 号）
- `invalid-tabindex`：非法 `tabindex` 导致非原生元素不可聚焦

### `POST /accessible-names`

请求体形式与 `/audit` 相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "<片段>" }`。

纳入计算的元素（与文档序一致，`dom` 从 1 起）：

- `button`、`a[href]`、非 `hidden` 类型的 `input`、`select`、`textarea`
- 任何带非空 `role` 属性的元素

名称按以下优先级计算（所有文本统一折叠空白，即连续空白合并为单个空格并去除首尾空白）：

1. **`aria-labelledby`**：属性值按空白拆成 id 令牌，按令牌顺序解析并拼接；被引用元素若自身也带 `aria-labelledby`，则**递归展开**，否则贡献其文本内容
2. **`aria-label`**：折叠空白后非空时生效
3. **关联 `<label>`**（仅 `button` / `input` / `select` / `textarea`）：在 `for` 指向本控件 id 的 label 与包裹本控件（且 `for` 未指向别处）的 label 中，取**文档序最靠前**的一个；label 文本会剔除其中嵌套的控件子树
4. **自身文本内容**

四步都得不到文本时该元素没有可访问名称（`source: null`），并报告一条 `UNNAMED` 问题。此外：

- `MISSING_REFERENCE`：`aria-labelledby` 引用了片段中不存在的 id（`refId` 指出缺失的 id）
- `CIRCULAR_REFERENCE`：`aria-labelledby` 引用成环，`chain` 给出 id 环（如 `["c1", "c2", "c1"]`，自引用为 `["x", "x"]`）

出现缺失或循环引用时仍会继续向下一级来源回退。所有 `issues` 按 `dom`、类型稳定排序。

```bash
curl -X POST http://localhost:3000/accessible-names \
  -H 'Content-Type: text/html' \
  --data-binary '<span id="first">名</span><span id="last">字</span>
<input id="name" aria-labelledby="last first">
<button aria-label="  保存   更改 ">x</button>
<label for="mail">邮箱 <span>*</span></label><input id="mail">
<a href="/help">帮助中心</a>
<div role="button" aria-labelledby="ghost"></div>'
```

返回示例：

```json
{
  "count": { "elements": 5, "named": 4, "unnamed": 1, "issues": 2 },
  "elements": [
    { "dom": 1, "tag": "input", "id": "name", "name": "字 名", "source": "aria-labelledby" },
    { "dom": 2, "tag": "button", "name": "保存 更改", "source": "aria-label" },
    { "dom": 3, "tag": "input", "id": "mail", "name": "邮箱 *", "source": "label" },
    { "dom": 4, "tag": "a", "href": "/help", "name": "帮助中心", "source": "content" },
    { "dom": 5, "tag": "div", "role": "button", "name": "", "source": null }
  ],
  "issues": [
    { "type": "MISSING_REFERENCE", "dom": 5, "refId": "ghost",
      "detail": "第 5 号元素 <div>的 aria-labelledby 引用了不存在的 id \"ghost\"" },
    { "type": "UNNAMED", "dom": 5, "detail": "第 5 号元素 <div> 没有可访问名称" }
  ]
}
```

`source` 取值：`aria-labelledby`、`aria-label`、`label`、`content`，无名称时为 `null`。

### `POST /implicit-submit`

请求体形式与其他接口相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "<片段>" }`。

按**文档序**返回片段中的**每一个 `<input>`**（包括无归属、失效、`type=hidden` 等），逐一判定聚焦后按 Enter 能否提交表单。`dom` 是该 input 在全部元素中文档序从 1 起的编号（非 input 元素也占位）。

#### 表单归属（form owner）

- input 带 `form` 属性时，取文档序**首个拥有该 id 的元素**；只有它是 `<form>` 时归属才成立。id 不存在、`form=""`、或首个同 id 元素不是 form（即使后面还有同 id 的 form）都属于**无归属**，且不会回退到祖先 form
- 未设置 `form` 属性时，取最近的 `<form>` 祖先
- 结果中 `form` 为 `{ dom, id? }` 或 `null`；带 `form` 属性时另附原始值 `formAttr` 与布尔值 `formAttrValid`

#### 失效（disabled）

- input 自身带 `disabled` 属性，或位于 `disabled <fieldset>` 的后代中，均视为失效（`disabled: true`）
- **例外**：fieldset 的第一个 `<legend>` 元素子树内的后代不受该 fieldset 影响；嵌套时内层 legend 只能解除内层 fieldset，无法解除外层
- 失效 input 仍保留其表单归属与默认按钮信息，但 Enter 不提交

#### 默认按钮（default button）

默认按钮是所属 form 的**文档序第一个提交按钮**，即使该按钮失效也**不会改选**为后面的按钮。提交按钮包括：

- `<button>` 无 `type` 或 `type=submit`（无 type 时按 submit 处理）
- `<input>` `type=submit` 或 `type=image`

提交按钮自身的 `form` 属性同样用于决定它属于哪个 form。

#### Enter 提交判定

只有**阻止型 input**（无 `type`，或 `type=text/search/url/tel/email/password/number`，大小写不敏感）才会触发隐式提交；`checkbox`、`hidden`、`date`、`submit`、`image` 等其他类型（包括空 `type=""` 与未知类型）均不触发。对阻止型 input：

1. 无归属 / 自身失效 → 不提交
2. 所属 form 存在默认按钮 → 默认按钮可用则提交；**默认按钮失效则不提交**（不会改选，也不适用下面的兜底规则）
3. 所属 form 没有任何提交按钮 → 该 form 中**可用的阻止型 input 不超过一个**时才提交（失效 input 与非阻止型 input 不计入）

`reason` 取值：

| reason | 含义 | `submits` |
| --- | --- | --- |
| `default-button` | 默认按钮可用，Enter 触发它提交 | `true` |
| `single-blocking-input` | 无提交按钮且可用阻止型输入仅此一个，Enter 直接提交 | `true` |
| `default-button-disabled` | 默认按钮失效且不改选 | `false` |
| `multiple-blocking-inputs` | 无提交按钮且有多个可用阻止型输入 | `false` |
| `not-blocking-type` | 非阻止型 input，不参与隐式提交 | `false` |
| `no-form-owner` | 无表单归属（无 form 祖先 / `form` 属性无效） | `false` |
| `disabled` | 自身带 `disabled` 属性 | `false` |
| `disabled-fieldset` | 位于 disabled fieldset 后代中 | `false` |

```bash
curl -X POST http://localhost:3000/implicit-submit \
  -H 'Content-Type: text/html' \
  --data-binary '<form id="f1">
  <input name="q">
  <button type="submit" disabled>失效按钮</button>
  <button type="submit">不会改选我</button>
</form>
<form id="f2">
  <input type="text">
  <input type="email">
</form>
<input form="ghost">'
```

返回示例（节选）：

```json
{
  "count": { "inputs": 4, "blocking": 4, "submits": 0, "noFormOwner": 1, "disabled": 0 },
  "inputs": [
    {
      "dom": 2, "tag": "input", "name": "q", "type": "text", "typeMissing": true,
      "blocking": true, "form": { "dom": 1, "id": "f1" },
      "disabled": false, "inDisabledFieldset": false,
      "defaultButton": { "dom": 3, "tag": "button", "type": "submit", "disabled": true, "text": "失效按钮" },
      "submits": false, "reason": "default-button-disabled",
      "detail": "所属 form 的默认按钮是第 3 号 <button>，但它已失效且不会改选其他按钮，Enter 不提交",
      "location": { "line": 2, "column": 3 }
    }
  ]
}
```

### `POST /table-headers`

请求体形式与其他接口相同：直接发送 HTML 片段（`Content-Type: text/html`），或 JSON `{ "html": "<片段>" }`。

审计 HTML 表格的**显式表头关联**，按 **td 文档序**返回片段中的**每一个 `<td>`**（`<th>` 不在结果中）。

#### 网格（每个 table 独立）

- 各 `<table>` 独立建网格，**嵌套表另算**：外表单元格里的嵌套表不会影响外表的行列，自身作为独立表格编号
- 行只取本表**直属 `<tr>`** 以及 `<thead>/<tbody>/<tfoot>` 下的 `<tr>`（按文档序）；其他位置的行忽略
- 每行按文档序放置其**直属 `<th>`、`<td>`**，落格时先跳过被上方 `rowspan` 占据的跨行占位；嵌套表里的单元格不是直属单元格，不会进入外表网格
- `rowspan`、`colspan` 仅接受 **1～20 的十进制整数**（允许前后空白），`0`、负数、小数、非数字、大于 20 等一律按 `1` 处理；表头覆盖其跨越的所有格

#### 表头关联（只处理 td）

1. **带 `headers` 属性的 td**：属性值按空白拆成令牌，按令牌顺序关联**本表**首个同 `id` 的 `<th>`，关联结果按令牌顺序去重；引用不到的令牌记 `INVALID_HEADER_REFERENCE`（同一 td 内重复的无效 id 只报一次）。**不再自动推断**——即使全部引用无效也不回退到 scope 推断；`id` 解析只在本表内进行，外表/嵌套表的 id 互不可见
2. **其余 td 自动推断**：
   - **上方**：列区间与该 td 列区间相交（表头列覆盖 td 任一列）且表头整体位于 td 上方的 `scope="col"` 表头
   - **左侧**：行区间与该 td 行区间相交（表头行覆盖 td 任一行）且表头整体位于 td 左侧的 `scope="row"` 表头
   - `scope` 大小写不敏感、允许前后空白；`colgroup`/`rowgroup` 及其他 scope 值**不处理**，无 `scope` 的 `<th>` 也不参与
   - 两组结果合并后按**表头文档序去重**

没有任何有效表头关联（含 `headers` 全部引用无效）的 td 记 `NO_HEADER`。

每个结果单元格字段：

- `dom`：td 在全部元素中的**全局先序号**（从 1 起，非 td 元素、合成的 `<tbody>` 等也占位）
- `table`：所属表格的**表格序号**（表格按文档序从 1 起）
- `headers`：关联到的 `<th>` 的**全局元素先序号**数组
- `issues`：该 td 的问题（`INVALID_HEADER_REFERENCE` 带 `refId`；`NO_HEADER`）

```bash
curl -X POST http://localhost:3000/table-headers \
  -H 'Content-Type: text/html' \
  --data-binary '<table>
  <tr><th id="name" scope="col">项目</th><th id="age" scope="col">数值</th></tr>
  <tr><th scope="row">年龄</th><td headers="age ghost">28</td></tr>
</table>
<table>
  <tr><td>没有表头</td></tr>
</table>'
```

返回示例（节选；注意 parse5 会为直属 `<tr>` 合成 `<tbody>`，合成元素同样占全局序号）：

```json
{
  "count": { "tables": 2, "cells": 2, "issues": 2, "invalidHeaderReferences": 1, "noHeader": 1 },
  "cells": [
    {
      "dom": 8, "tag": "td", "table": 1, "headers": [5],
      "issues": [
        { "type": "INVALID_HEADER_REFERENCE", "refId": "ghost",
          "detail": "第 8 号元素 <td> 的 headers 引用了本表中不存在的 id \"ghost\"" }
      ],
      "location": { "line": 3, "column": 30 }
    },
    {
      "dom": 12, "tag": "td", "table": 2, "headers": [],
      "issues": [
        { "type": "NO_HEADER", "detail": "第 12 号元素 <td> 没有任何有效表头关联" }
      ],
      "location": { "line": 6, "column": 7 }
    }
  ],
  "issues": [
    { "type": "INVALID_HEADER_REFERENCE", "dom": 8, "tag": "td", "table": 1, "refId": "ghost", "detail": "…" },
    { "type": "NO_HEADER", "dom": 12, "tag": "td", "table": 2, "detail": "…" }
  ]
}
```

上例中第 1 个 td 显式 `headers` 里 `age` 成功关联到本表第 5 号 `<th>`，`ghost` 引用无效（但不再补推断左侧的行表头）；第 2 个表格的 td 找不到任何表头，报 `NO_HEADER`。

问题类型：

- `INVALID_HEADER_REFERENCE`：`headers` 令牌在本表中找不到同 id 的 `<th>`（首个同 id 元素不是 th 也算无效）
- `NO_HEADER`：该 td 没有任何有效表头关联

### `GET /health`

健康检查，返回 `{"status":"ok"}`。

## 测试

```bash
npm test
```

使用 Node.js 内置测试运行器，覆盖排序、排除、radio 分组、风险判定，可访问名称的优先级、递归展开、缺失/循环引用、label 关联，隐式提交的表单归属、默认按钮（含失效不改选）、阻止型输入计数、disabled fieldset 与 legend 例外，表头关联的网格落格（rowspan/colspan 占位与取值范围）、`headers` 显式关联（含无效引用、本表作用域、去重）、scope 推断与嵌套表隔离，以及 HTTP 端点接线等 74 个用例。

## 项目结构

```
src/
  audit.js             # 焦点顺序审计逻辑（parse5 解析 + 规则判定）
  accessible-names.js  # 可访问名称计算（aria-labelledby 递归展开、label 关联等）
  implicit-submit.js   # Enter 隐式提交判定（表单归属、默认按钮、disabled fieldset 等）
  table-headers.js     # 表格表头关联审计（每表独立网格、headers 显式关联与 scope 推断）
  app.js               # Express 应用（/audit、/accessible-names、/implicit-submit、/table-headers、/health）
  server.js            # 启动入口
test/
  audit.test.js
  accessible-names.test.js
  implicit-submit.test.js
  table-headers.test.js
Dockerfile
docker-compose.yml
```
