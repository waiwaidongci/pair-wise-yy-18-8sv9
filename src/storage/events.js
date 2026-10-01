const db = require('./db');

function insert({ recordId, collection, action, status, actor, note, data }) {
  db.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
    [
      db.uuid(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      db.now()
    ]
  );
  db.maybePersist();
}

function listForRecord(recordId) {
  return db
    .select('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

function deleteForRecord(recordId) {
  db.run('DELETE FROM events WHERE record_id = ?', [recordId]);
  db.maybePersist();
}

module.exports = { insert, listForRecord, deleteForRecord };
