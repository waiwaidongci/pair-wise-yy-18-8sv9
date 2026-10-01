const db = require('./db');

function columnExists(table, column) {
  const rows = db.select(`PRAGMA table_info(${table});`);
  return rows.some((row) => row.name === column);
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);`);

  // 旧库迁移：补 version 列
  if (!columnExists('records', 'version')) {
    db.run(`ALTER TABLE records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT,
      actor TEXT,
      note TEXT,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS idempotency (
      request_id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      action TEXT NOT NULL,
      record_id TEXT,
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.persist();
}

module.exports = { initSchema };
