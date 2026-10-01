const db = require('./db');

// 请求编号幂等：同一 requestId 只执行第一次，重试沿用第一次结果（含失败）。
function find(requestId) {
  const rows = db.select('SELECT * FROM idempotency WHERE request_id = ?', [requestId]);
  if (!rows[0]) return null;
  return {
    requestId: rows[0].request_id,
    collection: rows[0].collection,
    action: rows[0].action,
    recordId: rows[0].record_id,
    status: rows[0].status,
    result: JSON.parse(rows[0].result),
    createdAt: rows[0].created_at
  };
}

function store({ requestId, collection, action, recordId, status, result }) {
  db.run(
    'INSERT OR IGNORE INTO idempotency (request_id, collection, action, record_id, status, result, created_at) ' +
      'VALUES (?,?,?,?,?,?,?)',
    [
      requestId,
      collection,
      action,
      recordId || null,
      status,
      JSON.stringify(result),
      db.now()
    ]
  );
  db.maybePersist();
}

module.exports = { find, store };
