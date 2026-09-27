'use strict';

const express = require('express');
const { auditHtml } = require('./audit');
const { accessibleNames } = require('./accessible-names');
const { implicitSubmit } = require('./implicit-submit');
const { tableHeaders } = require('./table-headers');

const app = express();

app.use(express.text({ type: ['text/html', 'text/plain', 'application/xhtml+xml'], limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 请求体支持 text/html 原始片段或 JSON { "html": "..." }；解析失败返回 null
function extractHtml(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body.html === 'string') return req.body.html;
  if (req.body && Object.keys(req.body).length === 0) return '';
  return null;
}

function badRequest(res) {
  return res.status(400).json({
    error: 'BAD_REQUEST',
    message: '请以 text/html 原始片段，或 JSON { "html": "..." } 提交 HTML 片段',
  });
}

app.post('/audit', (req, res) => {
  const html = extractHtml(req);
  if (html === null) return badRequest(res);

  try {
    const result = auditHtml(html);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'AUDIT_FAILED',
      message: err && err.message ? err.message : '审计失败',
    });
  }
});

app.post('/accessible-names', (req, res) => {
  const html = extractHtml(req);
  if (html === null) return badRequest(res);

  try {
    const result = accessibleNames(html);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'NAMES_FAILED',
      message: err && err.message ? err.message : '名称计算失败',
    });
  }
});

app.post('/implicit-submit', (req, res) => {
  const html = extractHtml(req);
  if (html === null) return badRequest(res);

  try {
    const result = implicitSubmit(html);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'IMPLICIT_SUBMIT_FAILED',
      message: err && err.message ? err.message : '隐式提交判定失败',
    });
  }
});

app.post('/table-headers', (req, res) => {
  const html = extractHtml(req);
  if (html === null) return badRequest(res);

  try {
    const result = tableHeaders(html);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'TABLE_HEADERS_FAILED',
      message: err && err.message ? err.message : '表头关联审计失败',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: `未找到路径 ${req.method} ${req.path}` });
});

module.exports = app;
