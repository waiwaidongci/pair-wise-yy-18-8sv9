'use strict';

// 入口装配：HTTP 框架在这里，规则在 src/domain.js，存储在 src/store.js。
const express = require('express');
const config = require('./project.config');
const routes = require('./src/routes');
const domain = require('./src/domain');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.json({ ok: true, service: config.title }));
app.use('/api', routes);

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const body = { error: error.message || 'server error', code: error.code || 'INTERNAL' };
  if (error.fields) body.fields = error.fields;
  if (error.tourBoxId) body.tourBoxId = error.tourBoxId;
  res.status(status).json(body);
});

domain.seedIfEmpty();

const PORT = process.env.PORT || config.port;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

module.exports = app;
