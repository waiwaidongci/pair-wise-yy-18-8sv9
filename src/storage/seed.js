const db = require('./db');
const records = require('./records');
const events = require('./events');
const { config, findCollection, titleFor } = require('../config');

function seedIfEmpty() {
  const count = db.select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return;
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || db.uuid();
    const createdAt = seed.createdAt || db.now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    records.insert({
      id,
      collection: seed.collection,
      status,
      title: titleFor(collectionConfig, data),
      data
    });
    events.insert({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
  db.persist();
}

module.exports = { seedIfEmpty };
