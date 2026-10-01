const db = require('../storage/db');
const records = require('../storage/records');
const events = require('../storage/events');
const rules = require('../domain/rules');
const workflows = require('../domain/workflows');
const { findCollection, titleFor, validate } = require('../config');
const { withIdempotency } = require('./idempotency');

function applyQuery(list, query) {
  return list.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

function listCollection(req, res, next) {
  try {
    findCollection(req.params.collection);
    const rows = records.list(req.params.collection);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
}

function getRecord(req, res, next) {
  try {
    findCollection(req.params.collection);
    const record = records.findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
}

const createRecord = withIdempotency('创建', async (req) => {
  const collectionConfig = findCollection(req.params.collection);
  const data = { ...collectionConfig.defaults, ...req.body };
  const status = data.status || collectionConfig.defaultStatus || '';
  data.status = status;
  validate(collectionConfig, data);
  const id = db.uuid();
  const record = db.transaction(() => {
    const created = records.insert({
      id,
      collection: req.params.collection,
      status,
      title: titleFor(collectionConfig, data),
      data
    });
    events.insert({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    return created;
  });
  record._status = 201;
  record.collection = req.params.collection;
  record.recordId = id;
  return record;
});

function updateRecord(req, res, next) {
  try {
    findCollection(req.params.collection);
    const record = records.findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const collectionConfig = findCollection(req.params.collection);
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    delete nextData.version;
    const status = nextData.status || record.status;
    nextData.status = status;
    const updated = db.transaction(() => {
      const saved = records.update(req.params.collection, req.params.id, {
        status,
        title: titleFor(collectionConfig, nextData),
        data: nextData
      });
      events.insert({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      return saved;
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
}

function addEvent(req, res, next) {
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = records.findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    delete nextData.version;
    const updated = db.transaction(() => {
      const saved = records.update(req.params.collection, req.params.id, {
        status,
        title: titleFor(collectionConfig, nextData),
        data: nextData
      });
      events.insert({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      return saved;
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
}

function timeline(req, res, next) {
  try {
    findCollection(req.params.collection);
    const record = records.findById(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const eventList = events.listForRecord(req.params.id);
    res.json({ record, events: eventList });
  } catch (error) {
    next(error);
  }
}

function deleteRecord(req, res, next) {
  try {
    findCollection(req.params.collection);
    db.transaction(() => {
      records.remove(req.params.collection, req.params.id);
      events.deleteForRecord(req.params.id);
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

// 可演出清单：待修补或待处理缺损的不列入
function performableList(req, res, next) {
  try {
    res.json(workflows.performableList(req.query));
  } catch (error) {
    next(error);
  }
}

// 装箱单缺少清单
function missingList(req, res, next) {
  try {
    findCollection('tourBoxes');
    const box = records.findById('tourBoxes', req.params.id);
    if (!box) return res.status(404).json({ error: 'not found' });
    const allItems = [...records.list('puppetHeads'), ...records.list('accessories')];
    res.json({ tourBoxId: box.id, missing: rules.missingItems(box, allItems) });
  } catch (error) {
    next(error);
  }
}

// 巡演状态链操作（均带请求编号幂等）
const pack = withIdempotency('入箱', async (req) => {
  const result = workflows.pack(req.params.id, req.body);
  result.collection = 'tourBoxes';
  result.recordId = req.params.id;
  return result;
});

const changeBox = withIdempotency('换箱', async (req) => {
  const result = workflows.changeBox(req.body);
  result.collection = req.body.itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
  result.recordId = result.item ? result.item.id : '';
  return result;
});

const returnTour = withIdempotency('返场清点', async (req) => {
  const result = workflows.returnTour(req.params.id, req.body);
  result.collection = 'tourBoxes';
  result.recordId = req.params.id;
  return result;
});

const confirm = withIdempotency('确认缺损', async (req) => {
  const result = workflows.confirm(req.params.id, req.body);
  result.collection = 'tourBoxes';
  result.recordId = req.params.id;
  return result;
});

module.exports = {
  listCollection,
  getRecord,
  createRecord,
  updateRecord,
  addEvent,
  timeline,
  deleteRecord,
  performableList,
  missingList,
  pack,
  changeBox,
  returnTour,
  confirm
};
