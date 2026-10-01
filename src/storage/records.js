const db = require('./db');

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findById(collection, id) {
  const rows = db.select(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1',
    [collection, id]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function list(collection) {
  return db
    .select('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC', [collection])
    .map(toRecord);
}

function insert({ id, collection, status, title, data }) {
  const ts = db.now();
  db.run(
    'INSERT INTO records (id, collection, status, title, version, data, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)',
    [id, collection, status, title, JSON.stringify(data), ts, ts]
  );
  db.maybePersist();
  return findById(collection, id);
}

// 乐观锁更新：expectedVersion 不匹配时抛 409 并带回当前记录。
function update(collection, id, { status, title, data, expectedVersion }) {
  const ts = db.now();
  if (expectedVersion !== undefined && expectedVersion !== null) {
    db.run(
      'UPDATE records SET status = ?, title = ?, data = ?, version = version + 1, updated_at = ? ' +
        'WHERE collection = ? AND id = ? AND version = ?',
      [status, title, JSON.stringify(data), ts, collection, id, expectedVersion]
    );
    if (db.rowsModified() === 0) {
      const current = findById(collection, id);
      const error = new Error('记录已被他人修改，请刷新后重试');
      error.status = 409;
      error.code = 'VERSION_CONFLICT';
      error.current = current;
      throw error;
    }
  } else {
    db.run(
      'UPDATE records SET status = ?, title = ?, data = ?, version = version + 1, updated_at = ? ' +
        'WHERE collection = ? AND id = ?',
      [status, title, JSON.stringify(data), ts, collection, id]
    );
  }
  db.maybePersist();
  return findById(collection, id);
}

function remove(collection, id) {
  db.run('DELETE FROM records WHERE collection = ? AND id = ?', [collection, id]);
  db.maybePersist();
}

module.exports = { toRecord, findById, list, insert, update, remove };
