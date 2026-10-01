const express = require('express');
const db = require('./storage/db');
const { initSchema } = require('./storage/schema');
const { seedIfEmpty } = require('./storage/seed');
const routes = require('./api/routes');
const { config } = require('./config');

async function createApp() {
  await db.init();
  initSchema();
  seedIfEmpty();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title, port: config.port });
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      title: config.title,
      description: config.description,
      collections: config.collections,
      examples: config.examples || []
    });
  });

  app.use('/api', routes);

  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message || 'server error' });
  });

  return app;
}

module.exports = { createApp };
