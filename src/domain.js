'use strict';

// ============================================================
// 规则层：偶头/服装配件 — 修补记录 — 巡演装箱单 — 缺损追踪
// 五本档案串成一条状态链。存储与入口不关心这里的规则。
//
// 核心不变量（由本层在事务内统一保证）：
//  1. 待修补 / 修补中 / 有未闭环缺损的物件，不进可演出清单，也不能入箱。
//  2. 入箱必写所属箱(boxNo/tourBoxId)与场次(showSession)。
//  3. 换箱带期望箱号（乐观并发）：两班抢同一物件只有一笔成功；
//     后到的拿回当前箱号，并重算两张装箱单缺少清单。
//  4. 返场清点先记“待确认”缺损；确认后物件状态、可用数量、
//     装箱单清点结果同一事务一起生效。
//  5. 每次状态变更必伴随事件，事件与状态在同一事务落盘。
// ============================================================

const { randomUUID } = require('crypto');
const store = require('./store');
const config = require('../project.config');

class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- 基础工具 ----------

function requireCollection(name) {
  const collectionConfig = config.collections[name];
  if (!collectionConfig) throw new DomainError(404, 'UNKNOWN_COLLECTION', '未知集合: ' + name);
  return collectionConfig;
}

function itemCollection(itemType) {
  const name = config.itemTypes[itemType];
  if (!name) throw new DomainError(400, 'BAD_ITEM_TYPE', '物件类型必须是 puppetHeads 或 accessories');
  return name;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validateRequired(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === null || data[field] === ''
  );
  if (missing.length) {
    throw new DomainError(400, 'MISSING_FIELDS', '缺少必填字段: ' + missing.join(', '), { fields: missing });
  }
}

function assertStatus(collectionConfig, status) {
  if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
    throw new DomainError(400, 'BAD_STATUS', '非法状态: ' + status);
  }
}

function mustGet(s, collection, id) {
  requireCollection(collection);
  const record = store.getRecord(s, collection, id);
  if (!record) throw new DomainError(404, 'NOT_FOUND', collection + ' / ' + id + ' 不存在');
  return record;
}

function makeRecord(collection, id, status, data, createdAt) {
  return {
    id,
    collection,
    status,
    title: titleFor(requireCollection(collection), data),
    data,
    createdAt,
    updatedAt: createdAt
  };
}

function saveState(s, record, event, requestId) {
  record.updatedAt = store.nowIso();
  store.putRecord(s, record);
  if (event) {
    store.appendEvent(s, {
      recordId: record.id,
      collection: record.collection,
      requestId,
      ...event
    });
  }
}

function listByCollection(s, collection) {
  return store.listRecords(s, collection).map(store.toView);
}

// 装箱单清单字段
function itemLinkField(itemType) {
  return itemType === 'puppetHeads' ? 'headIds' : 'accessoryIds';
}

function openRepairOf(s, itemType, itemId) {
  return listByCollection(s, 'repairRecords').find(
    (repair) => repair.itemType === itemType && repair.itemId === itemId && repair.status !== '已完成'
  ) || null;
}

function openLossOf(s, itemType, itemId) {
  return listByCollection(s, 'lossReports').find(
    (loss) =>
      loss.itemType === itemType &&
      loss.itemId === itemId &&
      config.openLossStatuses.includes(loss.status)
  ) || null;
}

// ---------- 可演出判定（规则 1）----------

// 返回 { usable, reason }；待修补/修补中/未闭环缺损均不可演出
function usability(s, item) {
  if (item.collection === 'puppetHeads' && item.data.currentUsable === false) {
    return { usable: false, reason: '偶头标记不可用' };
  }
  if (['待修补', '修补中', '试演中'].includes(item.status)) {
    return { usable: false, reason: '物件状态为' + item.status };
  }
  if (item.status === '遗失' || item.status === '缺损') {
    return { usable: false, reason: '物件状态为' + item.status };
  }
  const repair = openRepairOf(s, item.collection, item.id);
  if (repair) return { usable: false, reason: '有未完成修补单: ' + repair.id };
  const loss = openLossOf(s, item.collection, item.id);
  if (loss) return { usable: false, reason: '有未闭环缺损(' + loss.status + '): ' + loss.id };
  return { usable: true, reason: null };
}

// ---------- 装箱单清点（规则 2、3 的缺少清单重算）----------

function boxManifestIds(box) {
  return {
    headIds: Array.isArray(box.data.headIds) ? [...box.data.headIds] : [],
    accessoryIds: Array.isArray(box.data.accessoryIds) ? [...box.data.accessoryIds] : []
  };
}

function resolveItem(s, itemType, id) {
  return store.getRecord(s, itemCollection(itemType), id);
}

// 重算一张装箱单的清点结果：
// 清单里每个物件要么在场（在本箱），要么算缺少（被换走/档案缺失），
// 在场但不可演出的另列 blocked；可用数量按可用在场件数统计。
function recount(s, box) {
  const manifest = boxManifestIds(box);
  const result = {
    present: [],
    missing: [],
    blocked: [],
    extra: [],
    usableHeadCount: 0,
    usableAccessoryCount: 0
  };

  const inspect = (itemType, id) => {
    const item = resolveItem(s, itemType, id);
    if (!item) {
      result.missing.push({ itemType, itemId: id, reason: '档案缺失' });
      return;
    }
    if (item.data.tourBoxId !== box.id) {
      const currentBox = item.data.tourBoxId ? store.getRecord(s, 'tourBoxes', item.data.tourBoxId) : null;
      result.missing.push({
        itemType,
        itemId: id,
        itemName: item.data.role || item.data.name,
        reason: '不在本箱，当前所属箱: ' + (currentBox ? currentBox.data.boxNo : (item.data.boxNo || '在库')),
        currentBoxId: item.data.tourBoxId || null,
        currentBoxNo: currentBox ? currentBox.data.boxNo : (item.data.boxNo || null)
      });
      return;
    }
    const { usable, reason } = usability(s, item);
    const entry = {
      itemType,
      itemId: item.id,
      itemName: item.data.role || item.data.name,
      status: item.status
    };
    if (usable) {
      result.present.push(entry);
      if (itemType === 'puppetHeads') result.usableHeadCount += 1;
      else result.usableAccessoryCount += 1;
    } else {
      result.blocked.push({ ...entry, reason });
    }
  };

  manifest.headIds.forEach((id) => inspect('puppetHeads', id));
  manifest.accessoryIds.forEach((id) => inspect('accessories', id));

  // 实物在箱但清单未声明（别的班换入/串箱）
  const declared = new Set([
    ...manifest.headIds.map((id) => 'puppetHeads/' + id),
    ...manifest.accessoryIds.map((id) => 'accessories/' + id)
  ]);
  for (const itemType of ['puppetHeads', 'accessories']) {
    for (const item of store.listRecords(s, itemType)) {
      if (item.data.tourBoxId === box.id && !declared.has(itemType + '/' + item.id)) {
        result.extra.push({
          itemType,
          itemId: item.id,
          itemName: item.data.role || item.data.name,
          status: item.status
        });
      }
    }
  }

  box.data.usableHeadCount = result.usableHeadCount;
  box.data.usableAccessoryCount = result.usableAccessoryCount;
  box.data.checklist = {
    totalHeadCount: manifest.headIds.length,
    totalAccessoryCount: manifest.accessoryIds.length,
    presentCount: result.present.length,
    missingCount: result.missing.length,
    blockedCount: result.blocked.length,
    extraCount: result.extra.length,
    usableHeadCount: result.usableHeadCount,
    usableAccessoryCount: result.usableAccessoryCount,
    present: result.present,
    missing: result.missing,
    blocked: result.blocked,
    extra: result.extra,
    recountedAt: store.nowIso()
  };
  return box.data.checklist;
}

function mustGetBox(s, boxId) {
  return mustGet(s, 'tourBoxes', boxId);
}

function assertBoxOpen(box) {
  const locked = (config.collections.tourBoxes.lockedStatuses || []).includes(box.status);
  if (locked) {
    throw new DomainError(409, 'BOX_LOCKED', '装箱单已进入' + box.status + '，不能再调整物件', {
      tourBoxId: box.id,
      boxStatus: box.status
    });
  }
}

// ---------- 通用档案读写（仍保留五本档案的独立维护）----------

function createRecord(collection, body, { requestId } = {}) {
  const collectionConfig = requireCollection(collection);
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const id = body.id || randomUUID();
    if (store.getRecord(s, collection, id)) {
      throw new DomainError(409, 'DUPLICATE_ID', 'id 已存在: ' + id);
    }
    const data = { ...(collectionConfig.defaults || {}), ...body };
    delete data.id;
    delete data.collection;
    delete data.createdAt;
    delete data.updatedAt;
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    assertStatus(collectionConfig, status);
    validateRequired(collectionConfig, data);

    const record = makeRecord(collection, id, status, data, store.nowIso());
    store.putRecord(s, record);
    store.appendEvent(s, {
      recordId: id,
      collection,
      action: body.action || '建档',
      status,
      actor: body.actor || '',
      note: body.note || '',
      data: cleanBody(body),
      requestId
    });
    const result = { statusCode: 201, body: store.toView(record) };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

function patchRecord(collection, id, body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const collectionConfig = requireCollection(collection);
    const record = mustGet(s, collection, id);
    // 状态链物件禁止用通用 PATCH 直接改状态/所属箱，必须走状态链入口
    const guarded = ['status', 'tourBoxId', 'showSession', 'currentUsable'];
    const touched = guarded.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (touched.length) {
      throw new DomainError(
        409,
        'STATE_GUARDED',
        '字段 ' + touched.join(', ') + ' 由状态链管理，请走 /api/state 入口',
        { fields: touched }
      );
    }
    const nextData = { ...record.data, ...body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    validateRequired(collectionConfig, nextData);
    record.data = nextData;
    record.title = titleFor(collectionConfig, nextData);
    saveState(s, record, {
      action: body.action || '更新档案',
      status: record.status,
      actor: body.actor || '',
      note: body.note || '',
      data: cleanBody(body)
    }, requestId);
    const result = { statusCode: 200, body: store.toView(record) };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

function cleanBody(body) {
  const data = { ...body };
  delete data.requestId;
  delete data.action;
  delete data.actor;
  delete data.note;
  return data;
}

function queryRecords(collection, query) {
  return store.read((s) => {
    requireCollection(collection);
    let rows = listByCollection(s, collection);
    if (query.status) rows = rows.filter((row) => row.status === query.status);
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit', 'usable'].includes(key)) continue;
      rows = rows.filter((row) => String(row[key] === undefined ? '' : row[key]).includes(String(value)));
    }
    if (query.search) {
      const needle = String(query.search).toLowerCase();
      rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
    }
    if (query.usable !== undefined) {
      const want = String(query.usable) !== 'false';
      rows = rows.filter((row) => {
        const record = store.getRecord(s, collection, row.id);
        return usability(s, record).usable === want;
      });
    }
    const limit = Number(query.limit || 0);
    return limit > 0 ? rows.slice(0, limit) : rows;
  });
}

function timeline(collection, id) {
  return store.read((s) => {
    requireCollection(collection);
    const record = mustGet(s, collection, id);
    return { record: store.toView(record), events: store.eventsOf(s, id) };
  });
}

// ---------- 规则 2：建箱 / 入箱 ----------

function createBox(body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const cfg = requireCollection('tourBoxes');
    const id = body.id || randomUUID();
    if (store.getRecord(s, 'tourBoxes', id)) {
      throw new DomainError(409, 'DUPLICATE_ID', '装箱单 id 已存在: ' + id);
    }
    const data = {
      ...(cfg.defaults || {}),
      headIds: [],
      accessoryIds: [],
      usableHeadCount: 0,
      usableAccessoryCount: 0,
      ...body
    };
    const status = data.status || cfg.defaultStatus || '草稿';
    assertStatus(cfg, status);
    data.status = status;
    // 入箱信息在装箱单上必备：箱号 + 场次
    validateRequired({ required: ['showName', 'venue', 'play', 'boxNo', 'showSession'] }, data);

    const record = makeRecord('tourBoxes', id, status, data, store.nowIso());
    recount(s, record);
    store.putRecord(s, record);
    store.appendEvent(s, {
      recordId: id,
      collection: 'tourBoxes',
      action: '创建装箱单',
      status,
      actor: body.actor || '',
      note: body.note || '',
      data: { boxNo: data.boxNo, showSession: data.showSession, play: data.play },
      requestId
    });
    const result = { statusCode: 201, body: store.toView(record) };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// 入箱/装箱：写明所属箱与场次；待修补或待处理缺损的不能列入
function pack(body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const ids = body.itemIds || (body.itemId ? [body.itemId] : null);
    if (!ids || !ids.length) throw new DomainError(400, 'MISSING_FIELDS', '需要 itemIds');
    // 支持 headIds/accessoryIds 两种写法；否则必须给 itemType
    const groups = body.headIds || body.accessoryIds
      ? [['puppetHeads', body.headIds || []], ['accessories', body.accessoryIds || []]]
      : (body.itemType ? [[body.itemType, ids]] : null);
    if (!groups) throw new DomainError(400, 'MISSING_FIELDS', '需要 itemType');

    const tourBoxId = body.tourBoxId;
    if (!tourBoxId) throw new DomainError(400, 'MISSING_FIELDS', '需要 tourBoxId');
    const box = mustGetBox(s, tourBoxId);
    assertBoxOpen(box);

    let targetStatus = box.status;
    if (body.finalize) {
      targetStatus = body.toStatus || '已装箱';
      assertStatus(config.collections.tourBoxes, targetStatus);
    }

    const packed = [];
    const blocked = [];

    for (const [type, list] of groups) {
      if (!type) throw new DomainError(400, 'BAD_ITEM_TYPE', '需要 itemType');
      const coll = itemCollection(type);
      const linkField = itemLinkField(type);
      for (const rawId of list) {
        const item = store.getRecord(s, coll, rawId);
        if (!item) {
          blocked.push({ itemType: type, itemId: rawId, reason: '档案缺失' });
          continue;
        }
        const { usable, reason } = usability(s, item);
        if (!usable) {
          blocked.push({ itemType: type, itemId: item.id, itemName: item.data.role || item.data.name, reason });
          continue;
        }
        // 写明所属箱与场次
        item.data.tourBoxId = box.id;
        item.data.boxNo = box.data.boxNo;
        item.data.showSession = box.data.showSession;
        item.status = '已装箱';
        saveState(s, item, {
          action: '入箱',
          status: item.status,
          actor: body.actor || '',
          note: body.note || '',
          data: { tourBoxId: box.id, boxNo: box.data.boxNo, showSession: box.data.showSession }
        }, requestId);
        packed.push({ itemType: type, itemId: item.id, itemName: item.data.role || item.data.name });

        if (!box.data[linkField].includes(item.id)) box.data[linkField].push(item.id);
      }
    }

    if (targetStatus !== box.status) {
      box.status = targetStatus;
      box.data.status = targetStatus;
    }
    recount(s, box);
    saveState(s, box, {
      action: '入箱装箱',
      status: box.status,
      actor: body.actor || '',
      note: body.note || '',
      data: {
        tourBoxId: box.id,
        boxNo: box.data.boxNo,
        showSession: box.data.showSession,
        packedCount: packed.length,
        blockedCount: blocked.length,
        blocked
      }
    }, requestId);

    const result = {
      statusCode: 200,
      body: {
        tourBox: store.toView(box),
        packed,
        blocked,
        checklist: box.data.checklist
      }
    };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// ---------- 规则 3：两班换箱（乐观并发）----------

function move(body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const { itemType, itemId, fromBoxId, toBoxId } = body;
    if (!itemType || !itemId || !fromBoxId || !toBoxId) {
      throw new DomainError(400, 'MISSING_FIELDS', '需要 itemType, itemId, fromBoxId, toBoxId');
    }
    const coll = itemCollection(itemType);
    const item = store.getRecord(s, coll, itemId);
    if (!item) throw new DomainError(404, 'NOT_FOUND', '物件不存在: ' + itemId);
    const fromBox = mustGetBox(s, fromBoxId);
    const toBox = mustGetBox(s, toBoxId);
    if (fromBoxId === toBoxId) throw new DomainError(400, 'SAME_BOX', '源箱与目标箱相同');
    assertBoxOpen(fromBox);
    assertBoxOpen(toBox);

    // 乐观校验：后到的一笔看到当前箱号已不是自己的期望箱号 -> 冲突
    const currentBoxId = item.data.tourBoxId || null;
    if (currentBoxId !== fromBoxId) {
      recount(s, fromBox);
      recount(s, toBox);
      saveState(s, fromBox, {
        action: '换箱冲突-重算源箱',
        status: fromBox.status,
        actor: body.actor || '',
        note: body.note || '',
        data: { itemType, itemId, expectedBoxId: fromBoxId, currentBoxId }
      }, requestId);
      saveState(s, toBox, {
        action: '换箱冲突-重算目标箱',
        status: toBox.status,
        actor: body.actor || '',
        data: { itemType, itemId, expectedBoxId: fromBoxId, currentBoxId }
      }, requestId);
      const result = {
        statusCode: 409,
        body: {
          error: '物件已不在期望箱内，换箱失败',
          code: 'BOX_MOVED',
          itemType,
          itemId,
          expectedBoxId: fromBoxId,
          currentBoxId,
          currentBoxNo: currentBoxId ? (mustGetBox(s, currentBoxId).data.boxNo) : (item.data.boxNo || null),
          sourceBox: { tourBoxId: fromBox.id, checklist: fromBox.data.checklist },
          targetBox: { tourBoxId: toBox.id, checklist: toBox.data.checklist }
        }
      };
      store.saveRequest(s, { requestId, result, at: store.nowIso() });
      return result;
    }

    // 成功一笔：只改物件实际归属（写明箱号、场次）。
    // 两张装箱单的“应到声明”不动，缺少清单由 recount 比对声明与实际得出。
    item.data.tourBoxId = toBox.id;
    item.data.boxNo = toBox.data.boxNo;
    item.data.showSession = toBox.data.showSession;
    // 物件状态保持语义一致：本就在箱/库的可用件维持原状，不凭空变已装箱
    const movableStatuses = item.collection === 'puppetHeads'
      ? ['可演出', '已装箱']
      : ['在库', '已装箱'];
    item.status = movableStatuses.includes(item.status) ? item.status : '已装箱';
    item.data.status = item.status;
    saveState(s, item, {
      action: '换箱',
      status: item.status,
      actor: body.actor || '',
      note: body.note || '',
      data: { fromBoxId, toBoxId, boxNo: toBox.data.boxNo, showSession: toBox.data.showSession }
    }, requestId);

    recount(s, fromBox);
    recount(s, toBox);
    saveState(s, fromBox, {
      action: '换箱移出-重算',
      status: fromBox.status,
      actor: body.actor || '',
      data: { itemType, itemId, toBoxId }
    }, requestId);
    saveState(s, toBox, {
      action: '换箱接入-重算',
      status: toBox.status,
      actor: body.actor || '',
      data: { itemType, itemId, fromBoxId }
    }, requestId);

    const result = {
      statusCode: 200,
      body: {
        moved: { itemType, itemId, fromBoxId, toBoxId, boxNo: toBox.data.boxNo, showSession: toBox.data.showSession },
        sourceBox: { tourBoxId: fromBox.id, checklist: fromBox.data.checklist },
        targetBox: { tourBoxId: toBox.id, checklist: toBox.data.checklist }
      }
    };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// ---------- 规则 4a：返场清点先记待确认缺损 ----------

function checkin(body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const tourBoxId = body.tourBoxId;
    if (!tourBoxId) throw new DomainError(400, 'MISSING_FIELDS', '需要 tourBoxId');
    const box = mustGetBox(s, tourBoxId);

    // 进入返场清点中并锁定装箱单（此后不能再入箱/换箱）
    const wasLocked = (config.collections.tourBoxes.lockedStatuses || []).includes(box.status);
    if (!wasLocked) {
      box.status = '返场清点中';
      box.data.status = box.status;
    }
    recount(s, box);

    const items = Array.isArray(body.items)
      ? body.items
      : body.itemType && body.itemId
        ? [{ itemType: body.itemType, itemId: body.itemId, problem: body.problem }]
        : null;
    if (!items || !items.length) throw new DomainError(400, 'MISSING_FIELDS', '需要 items[] 或 itemType+itemId');

    const reports = [];
    for (const entry of items) {
      const coll = itemCollection(entry.itemType);
      const item = entry.itemId ? store.getRecord(s, coll, entry.itemId) : null;
      const data = {
        tourBoxId: box.id,
        itemType: entry.itemType,
        itemId: entry.itemId || null,
        itemName: entry.itemName || (item ? item.data.role || item.data.name : '') || '',
        problem: entry.problem,
        severity: entry.severity || '',
        status: '待确认',
        resolution: null
      };
      validateRequired(config.collections.lossReports, data);
      const id = randomUUID();
      const record = makeRecord('lossReports', id, '待确认', data, store.nowIso());
      store.putRecord(s, record);
      store.appendEvent(s, {
        recordId: id,
        collection: 'lossReports',
        action: '返场清点-登记待确认',
        status: '待确认',
        actor: body.actor || '',
        note: body.note || '',
        data: { tourBoxId: box.id, ...data },
        requestId
      });
      reports.push(store.toView(record));
    }

    saveState(s, box, {
      action: '返场清点',
      status: box.status,
      actor: body.actor || '',
      note: body.note || '',
      data: { reportCount: reports.length, checklist: box.data.checklist }
    }, requestId);

    const result = { statusCode: 201, body: { tourBox: store.toView(box), lossReports: reports } };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// 也允许直接 POST /api/lossReports 登记待确认缺损（不经清点动作时仍强制待确认）
function createLoss(body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;
    if (!body.tourBoxId) throw new DomainError(400, 'MISSING_FIELDS', '需要 tourBoxId');
    const box = mustGetBox(s, body.tourBoxId);

    const cfg = config.collections.lossReports;
    const data = { ...(cfg.defaults || {}), ...body, status: '待确认', resolution: null };
    validateRequired(cfg, data);
    const id = body.id || randomUUID();
    const record = makeRecord('lossReports', id, '待确认', data, store.nowIso());
    store.putRecord(s, record);
    store.appendEvent(s, {
      recordId: id,
      collection: 'lossReports',
      action: '登记待确认缺损',
      status: '待确认',
      actor: body.actor || '',
      note: body.note || '',
      data: cleanBody(data),
      requestId
    });
    recount(s, box);
    saveState(s, box, {
      action: '缺损登记-重算清点',
      status: box.status,
      actor: body.actor || '',
      data: { lossReportId: id }
    }, requestId);

    const result = { statusCode: 201, body: store.toView(record) };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// ---------- 规则 4b：确认缺损，状态/可用数量/清点一起生效 ----------

function confirmLoss(lossId, body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const loss = mustGet(s, 'lossReports', lossId);
    if (loss.status !== '待确认') {
      throw new DomainError(409, 'ALREADY_CONFIRMED', '缺损已确认，当前状态: ' + loss.status, {
        lossReportId: lossId,
        status: loss.status
      });
    }
    const resolution = body.resolution;
    if (!['repair', 'lost', 'none'].includes(resolution)) {
      throw new DomainError(400, 'BAD_RESOLUTION', "resolution 必须是 repair / lost / none");
    }
    const box = mustGetBox(s, loss.data.tourBoxId);
    const item = loss.data.itemId ? store.getRecord(s, itemCollection(loss.data.itemType), loss.data.itemId) : null;

    let repair = null;
    if (resolution === 'repair') {
      if (!item) throw new DomainError(422, 'ITEM_MISSING', '确认修复必须关联到具体物件档案');
      loss.status = '修复中';
      loss.data.status = '修复中';
      loss.data.resolution = 'repair';

      // 同事务：物件转待修补并置不可用
      item.status = loss.data.itemType === 'puppetHeads' ? '待修补' : '缺损';
      item.data.status = item.status;
      if (loss.data.itemType === 'puppetHeads') item.data.currentUsable = false;
      saveState(s, item, {
        action: '缺损确认-转修补',
        status: item.status,
        actor: body.actor || '',
        note: body.note || '',
        data: { lossReportId: loss.id }
      }, requestId);

      // 同事务：开修补单
      const repairData = {
        itemType: loss.data.itemType,
        itemId: item.id,
        repairType: body.repairType || loss.data.problem,
        handler: body.handler || '',
        status: '待处理',
        tourBoxId: box.id,
        lossReportId: loss.id
      };
      if (!repairData.handler) {
        throw new DomainError(400, 'MISSING_FIELDS', '修复需要 handler（修补人）', { fields: ['handler'] });
      }
      const repairId = randomUUID();
      repair = makeRecord('repairRecords', repairId, '待处理', repairData, store.nowIso());
      store.putRecord(s, repair);
      store.appendEvent(s, {
        recordId: repairId,
        collection: 'repairRecords',
        action: '缺损确认-开立修补单',
        status: '待处理',
        actor: body.actor || '',
        data: repairData,
        requestId
      });
    } else if (resolution === 'lost') {
      loss.status = '确认为遗失';
      loss.data.status = loss.status;
      loss.data.resolution = 'lost';
      if (item) {
        item.status = '遗失';
        item.data.status = '遗失';
        if (loss.data.itemType === 'puppetHeads') item.data.currentUsable = false;
        saveState(s, item, {
          action: '缺损确认-遗失',
          status: '遗失',
          actor: body.actor || '',
          note: body.note || '',
          data: { lossReportId: loss.id }
        }, requestId);
      }
    } else {
      // 复核无缺损
      loss.status = '已排除';
      loss.data.status = '已排除';
      loss.data.resolution = 'none';
    }

    saveState(s, loss, {
      action: '缺损确认',
      status: loss.status,
      actor: body.actor || '',
      note: body.note || '',
      data: { resolution, repairId: repair ? repair.id : null }
    }, requestId);

    // 同事务：重算可用数量与装箱单清点
    recount(s, box);
    saveState(s, box, {
      action: '缺损确认-清点生效',
      status: box.status,
      actor: body.actor || '',
      data: {
        lossReportId: loss.id,
        resolution,
        usableHeadCount: box.data.usableHeadCount,
        usableAccessoryCount: box.data.usableAccessoryCount
      }
    }, requestId);

    // 本箱缺损全部闭环（含待确认都了结）-> 装箱单闭环
    const pending = listByCollection(s, 'lossReports').filter(
      (report) => report.tourBoxId === box.id && (config.unresolvedLossStatuses || config.openLossStatuses).includes(report.status)
    );
    if (!pending.length && box.status === '返场清点中') {
      box.status = '已闭环';
      box.data.status = '已闭环';
      saveState(s, box, {
        action: '装箱单闭环',
        status: '已闭环',
        actor: body.actor || '',
        data: { usableHeadCount: box.data.usableHeadCount, usableAccessoryCount: box.data.usableAccessoryCount }
      }, requestId);
    }

    const result = {
      statusCode: 200,
      body: {
        lossReport: store.toView(loss),
        item: item ? store.toView(item) : null,
        repair: repair ? store.toView(repair) : null,
        tourBox: store.toView(box),
        checklist: box.data.checklist
      }
    };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// 修补完成：物件恢复可演出，并重算所在装箱单
function completeRepair(repairId, body, { requestId } = {}) {
  return store.transaction((s) => {
    const existing = store.getRequest(s, requestId);
    if (existing) return existing.result;

    const repair = mustGet(s, 'repairRecords', repairId);
    if (repair.status === '已完成') {
      throw new DomainError(409, 'ALREADY_DONE', '修补单已完成');
    }
    repair.status = '已完成';
    repair.data.status = '已完成';
    repair.data.completedAt = store.nowIso();
    if (body.resultNote) repair.data.resultNote = body.resultNote;
    saveState(s, repair, {
      action: '修补完成',
      status: '已完成',
      actor: body.actor || '',
      note: body.note || '',
      data: cleanBody(body)
    }, requestId);

    const item = store.getRecord(s, itemCollection(repair.data.itemType), repair.data.itemId);

    // 关联缺损先标已补齐（同事务），再判定物件能否恢复可用
    let loss = null;
    if (repair.data.lossReportId) {
      loss = store.getRecord(s, 'lossReports', repair.data.lossReportId);
      if (loss && loss.status === '修复中') {
        loss.status = '已补齐';
        loss.data.status = '已补齐';
        saveState(s, loss, {
          action: '修补完成-缺损已补齐',
          status: '已补齐',
          actor: body.actor || '',
          data: { repairId: repair.id }
        }, requestId);
      }
    }

    if (item) {
      // 仍有其他未闭环缺损则不恢复
      const otherLoss = openLossOf(s, item.collection, item.id);
      if (!otherLoss) {
        if (item.collection === 'puppetHeads') {
          item.status = item.data.tourBoxId ? '已装箱' : '可演出';
          item.data.currentUsable = true;
        } else {
          item.status = item.data.tourBoxId ? '已装箱' : '在库';
        }
        item.data.status = item.status;
        saveState(s, item, {
          action: '修补完成-恢复可用',
          status: item.status,
          actor: body.actor || '',
          data: { repairId: repair.id }
        }, requestId);
      }
    }

    const box = repair.data.tourBoxId ? mustGetBox(s, repair.data.tourBoxId) : null;
    if (box) {
      recount(s, box);
      saveState(s, box, {
        action: '修补完成-重算清点',
        status: box.status,
        actor: body.actor || '',
        data: { repairId: repair.id, usableHeadCount: box.data.usableHeadCount }
      }, requestId);

      // 本箱缺损全部闭环 -> 装箱单闭环
      const pending = listByCollection(s, 'lossReports').filter(
        (report) => report.tourBoxId === box.id && (config.unresolvedLossStatuses || config.openLossStatuses).includes(report.status)
      );
      if (!pending.length && box.status === '返场清点中') {
        box.status = '已闭环';
        box.data.status = '已闭环';
        saveState(s, box, {
          action: '装箱单闭环',
          status: '已闭环',
          actor: body.actor || '',
          data: { usableHeadCount: box.data.usableHeadCount, usableAccessoryCount: box.data.usableAccessoryCount }
        }, requestId);
      }
    }

    const result = {
      statusCode: 200,
      body: {
        repair: store.toView(repair),
        item: item ? store.toView(item) : null,
        lossReport: loss ? store.toView(loss) : null,
        tourBox: box ? store.toView(box) : null
      }
    };
    store.saveRequest(s, { requestId, result, at: store.nowIso() });
    return result;
  }, { requestId });
}

// ---------- 查询：可演出清单 ----------

function performable(query) {
  return store.read((s) => {
    const heads = listByCollection(s, 'puppetHeads').map((row) => {
      const record = mustGet(s, 'puppetHeads', row.id);
      return { record, check: usability(s, record) };
    });
    const accessories = listByCollection(s, 'accessories').map((row) => {
      const record = mustGet(s, 'accessories', row.id);
      return { record, check: usability(s, record) };
    });
    const filterRows = (pairs) =>
      pairs
        .filter(({ record, check }) => check.usable)
        .filter(({ record }) => {
          if (query.play && record.data.play !== query.play) return false;
          if (query.role && !String(record.data.role || '').includes(String(query.role))) return false;
          if (query.boxNo && record.data.boxNo !== query.boxNo) return false;
          if (query.tourBoxId && record.data.tourBoxId !== query.tourBoxId) return false;
          return true;
        })
        .map(({ record }) => store.toView(record));
    return {
      puppetHeads: filterRows(heads),
      accessories: filterRows(accessories)
    };
  });
}

function boxChecklist(boxId) {
  return store.read((s) => {
    const box = mustGetBox(s, boxId);
    // 只读也要给最新清点（不落盘）
    const checklist = recount(s, box);
    const reports = listByCollection(s, 'lossReports').filter((report) => report.tourBoxId === boxId);
    return { tourBox: store.toView(box), checklist, lossReports: reports };
  });
}

function seedIfEmpty() {
  const has = store.read((s) => Object.keys(s.records).length > 0);
  if (has) return;
  for (const seed of config.seed || []) {
    const collectionConfig = requireCollection(seed.collection);
    const createdAt = seed.createdAt || store.nowIso();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    store.transaction((s) => {
      if (store.getRecord(s, seed.collection, seed.id)) return;
      const record = makeRecord(seed.collection, seed.id, status, data, createdAt);
      record.updatedAt = seed.updatedAt || createdAt;
      store.putRecord(s, record);
      store.appendEvent(s, {
        recordId: seed.id,
        collection: seed.collection,
        action: seed.eventAction || '建档',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    });
  }
}

module.exports = {
  DomainError,
  seedIfEmpty,
  queryRecords,
  timeline,
  createRecord,
  patchRecord,
  createBox,
  pack,
  move,
  checkin,
  createLoss,
  confirmLoss,
  completeRepair,
  performable,
  boxChecklist
};
