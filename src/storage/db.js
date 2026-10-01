const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let SQL = null;
let db = null;
let inTransaction = false;

async function init() {
  SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  return db;
}

function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}

function persist() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function run(sql, params) {
  db.run(sql, params || []);
}

function select(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function rowsModified() {
  return db.getRowsModified();
}

// 原子事务：fn 内全部成功才 COMMIT 并落盘，任一失败 ROLLBACK。
function transaction(fn) {
  inTransaction = true;
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    inTransaction = false;
    persist();
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    inTransaction = false;
    throw error;
  }
}

// 事务内不落盘（等 COMMIT 一起），事务外单次写入立即落盘。
function maybePersist() {
  if (!inTransaction) persist();
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return randomUUID();
}

module.exports = {
  init,
  getDb,
  persist,
  maybePersist,
  run,
  select,
  rowsModified,
  transaction,
  now,
  uuid,
  DATA_DIR,
  DB_FILE
};
