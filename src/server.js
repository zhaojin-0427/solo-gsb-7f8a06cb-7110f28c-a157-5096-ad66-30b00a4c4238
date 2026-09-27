'use strict';

const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`焦点审计 API 已启动: http://localhost:${PORT} (POST /audit, POST /accessible-names, POST /implicit-submit, POST /table-headers)`);
});
