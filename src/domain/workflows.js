const db = require('../storage/db');
const records = require('../storage/records');
const events = require('../storage/events');
const rules = require('./rules');
const { findCollection, titleFor } = require('../config');

const ITEM_COLLECTIONS = { puppetHead: 'puppetHeads', accessory: 'accessories' };

function itemCollection(itemType) {
  const collection = ITEM_COLLECTIONS[itemType];
  if (!collection) {
    const error = new Error('unknown itemType: ' + itemType);
    error.status = 400;
    throw error;
  }
  return collection;
}

function loadItem(itemType, itemId) {
  return records.findById(itemCollection(itemType), itemId);
}

function cleanForSave(record) {
  const next = { ...record };
  delete next.id;
  delete next.collection;
  delete next.createdAt;
  delete next.updatedAt;
  delete next.version;
  return next;
}

// 受影响的装箱单：物件当前所在单 + 请求换入的单
function affectedTourBoxes(item, toTourBoxId) {
  const ids = new Set();
  if (item.tourBoxId) ids.add(item.tourBoxId);
  if (toTourBoxId) ids.add(toTourBoxId);
  return [...ids];
}

// 重算多张装箱单的缺少清单
function recomputeMissing(tourBoxIds) {
  const allItems = [...records.list('puppetHeads'), ...records.list('accessories')];
  const result = {};
  for (const id of tourBoxIds) {
    const box = records.findById('tourBoxes', id);
    if (box) result[id] = rules.missingItems(box, allItems);
  }
  return result;
}

function boxConflictError(item, toTourBoxId) {
  const error = new Error('换箱冲突：物件当前在 ' + item.boxNo + '，不是预期箱号');
  error.status = 409;
  error.code = 'BOX_CONFLICT';
  error.currentBoxNo = item.boxNo;
  error.currentVersion = item.version;
  error.currentItem = item;
  error.missing = recomputeMissing(affectedTourBoxes(item, toTourBoxId));
  return error;
}

// 入箱：写明所属箱和场次
function pack(tourBoxId, body) {
  const tourBox = records.findById('tourBoxes', tourBoxId);
  if (!tourBox) {
    const error = new Error('装箱单不存在');
    error.status = 404;
    throw error;
  }
  const { itemType, itemId, boxNo, showName, note } = body;
  if (!itemType || !itemId || !boxNo) {
    const error = new Error('缺少 itemType / itemId / boxNo');
    error.status = 400;
    throw error;
  }
  const item = loadItem(itemType, itemId);
  if (!item) {
    const error = new Error('物件不存在');
    error.status = 404;
    throw error;
  }

  const result = db.transaction(() => {
    const collection = itemCollection(itemType);
    const itemConfig = findCollection(collection);
    const nextItem = cleanForSave(item);
    nextItem.tourBoxId = tourBoxId;
    nextItem.boxNo = boxNo;
    nextItem.showName = showName || tourBox.showName || '';
    if (itemType === 'puppetHead') {
      nextItem.status = '已装箱';
    } else {
      nextItem.status = '已装箱';
      const qty = nextItem.quantity != null ? nextItem.quantity : 1;
      nextItem.availableQty = Math.max(0, (nextItem.availableQty != null ? nextItem.availableQty : qty) - 1);
    }
    const updatedItem = records.update(collection, itemId, {
      status: nextItem.status,
      title: titleFor(itemConfig, nextItem),
      data: nextItem
    });
    events.insert({
      recordId: itemId,
      collection,
      action: '入箱',
      status: nextItem.status,
      actor: body.actor || '',
      note: note || ('入箱 ' + boxNo),
      data: { boxNo, showName: nextItem.showName, tourBoxId }
    });

    const boxConfig = findCollection('tourBoxes');
    const nextBox = cleanForSave(tourBox);
    nextBox.headIds = [...(nextBox.headIds || [])];
    nextBox.accessoryIds = [...(nextBox.accessoryIds || [])];
    if (itemType === 'puppetHead') {
      if (!nextBox.headIds.includes(itemId)) nextBox.headIds.push(itemId);
    } else {
      if (!nextBox.accessoryIds.includes(itemId)) nextBox.accessoryIds.push(itemId);
    }
    const updatedBox = records.update('tourBoxes', tourBoxId, {
      status: tourBox.status,
      title: titleFor(boxConfig, nextBox),
      data: nextBox
    });
    events.insert({
      recordId: tourBoxId,
      collection: 'tourBoxes',
      action: '入箱',
      status: tourBox.status,
      actor: body.actor || '',
      note: note || ('物件 ' + itemId + ' 入箱'),
      data: { itemType, itemId, boxNo }
    });

    return { item: updatedItem, tourBox: updatedBox };
  });

  result.missing = recomputeMissing(affectedTourBoxes(result.item, null));
  return result;
}

// 换箱：两个班同时提交同一物件只有一笔成功，后到的返回当前箱号并重算两张装箱单缺少清单
function changeBox(body) {
  const { itemType, itemId, fromBoxNo, toBoxNo, toTourBoxId, note } = body;
  if (!itemType || !itemId || !fromBoxNo || !toBoxNo) {
    const error = new Error('缺少 itemType / itemId / fromBoxNo / toBoxNo');
    error.status = 400;
    throw error;
  }
  const collection = itemCollection(itemType);
  const item = records.findById(collection, itemId);
  if (!item) {
    const error = new Error('物件不存在');
    error.status = 404;
    throw error;
  }

  // 业务乐观锁：物件当前箱号必须等于 fromBoxNo
  if (item.boxNo !== fromBoxNo) {
    throw boxConflictError(item, toTourBoxId);
  }

  let result;
  try {
    result = db.transaction(() => {
      const itemConfig = findCollection(collection);
      const nextItem = cleanForSave(item);
      const oldBoxNo = nextItem.boxNo;
      nextItem.boxNo = toBoxNo;
      if (toTourBoxId) nextItem.tourBoxId = toTourBoxId;
      const updatedItem = records.update(collection, itemId, {
        status: nextItem.status,
        title: titleFor(itemConfig, nextItem),
        data: nextItem,
        expectedVersion: item.version
      });
      events.insert({
        recordId: itemId,
        collection,
        action: '换箱',
        status: nextItem.status,
        actor: body.actor || '',
        note: note || (oldBoxNo + ' → ' + toBoxNo),
        data: { fromBoxNo: oldBoxNo, toBoxNo, toTourBoxId: toTourBoxId || null }
      });

      // 若指定目标装箱单，把物件加入目标单清单（源单清单保留，缺少清单据此重算）
      if (toTourBoxId) {
        const targetBox = records.findById('tourBoxes', toTourBoxId);
        if (targetBox) {
          const boxConfig = findCollection('tourBoxes');
          const nextBox = cleanForSave(targetBox);
          nextBox.headIds = [...(nextBox.headIds || [])];
          nextBox.accessoryIds = [...(nextBox.accessoryIds || [])];
          if (itemType === 'puppetHead') {
            if (!nextBox.headIds.includes(itemId)) nextBox.headIds.push(itemId);
          } else {
            if (!nextBox.accessoryIds.includes(itemId)) nextBox.accessoryIds.push(itemId);
          }
          records.update('tourBoxes', toTourBoxId, {
            status: targetBox.status,
            title: titleFor(boxConfig, nextBox),
            data: nextBox
          });
          events.insert({
            recordId: toTourBoxId,
            collection: 'tourBoxes',
            action: '换箱调入',
            status: targetBox.status,
            actor: body.actor || '',
            note: '物件 ' + itemId + ' 换箱调入',
            data: { itemType, itemId, fromBoxNo: oldBoxNo, toBoxNo }
          });
        }
      }

      return { item: updatedItem, oldBoxNo, newBoxNo: toBoxNo };
    });
  } catch (error) {
    if (error.code === 'VERSION_CONFLICT') {
      const current = records.findById(collection, itemId);
      throw boxConflictError(current, toTourBoxId);
    }
    throw error;
  }

  result.missing = recomputeMissing(affectedTourBoxes(result.item, toTourBoxId));
  return result;
}

// 返场清点：先记待确认缺损，不改物件状态
function returnTour(tourBoxId, body) {
  const tourBox = records.findById('tourBoxes', tourBoxId);
  if (!tourBox) {
    const error = new Error('装箱单不存在');
    error.status = 404;
    throw error;
  }
  const { defects, note } = body;
  if (!Array.isArray(defects)) {
    const error = new Error('缺少 defects 数组');
    error.status = 400;
    throw error;
  }

  const result = db.transaction(() => {
    const boxConfig = findCollection('tourBoxes');
    const nextBox = cleanForSave(tourBox);
    nextBox.status = '返场清点中';
    const updatedBox = records.update('tourBoxes', tourBoxId, {
      status: nextBox.status,
      title: titleFor(boxConfig, nextBox),
      data: nextBox
    });
    events.insert({
      recordId: tourBoxId,
      collection: 'tourBoxes',
      action: '返场清点',
      status: nextBox.status,
      actor: body.actor || '',
      note: note || '返场清点开始',
      data: { defectCount: defects.length }
    });

    const lossConfig = findCollection('lossReports');
    const lossReports = [];
    for (const defect of defects) {
      const id = db.uuid();
      const lossData = {
        tourBoxId,
        itemType: defect.itemType,
        itemId: defect.itemId,
        itemName: defect.itemName || '',
        problem: defect.problem,
        status: '待确认'
      };
      records.insert({
        id,
        collection: 'lossReports',
        status: '待确认',
        title: titleFor(lossConfig, lossData),
        data: lossData
      });
      events.insert({
        recordId: id,
        collection: 'lossReports',
        action: '返场登记',
        status: '待确认',
        actor: body.actor || '',
        note: defect.problem,
        data: lossData
      });
      lossReports.push(records.findById('lossReports', id));
    }
    return { tourBox: updatedBox, lossReports };
  });
  return result;
}

// 确认缺损：物件状态、可用数量、装箱单清点一起生效（原子事务）
function confirm(tourBoxId, body) {
  const tourBox = records.findById('tourBoxes', tourBoxId);
  if (!tourBox) {
    const error = new Error('装箱单不存在');
    error.status = 404;
    throw error;
  }
  const resolutions = body.resolutions || [];
  const resolutionMap = {};
  for (const r of resolutions) resolutionMap[r.lossReportId] = r.result;

  const pendingLosses = records
    .list('lossReports')
    .filter((loss) => loss.tourBoxId === tourBoxId && loss.status === '待确认');
  if (pendingLosses.length === 0) {
    const error = new Error('没有待确认的缺损');
    error.status = 400;
    throw error;
  }

  const result = db.transaction(() => {
    const updatedLosses = [];
    const updatedItems = [];
    for (const loss of pendingLosses) {
      const resultType = resolutionMap[loss.id] || rules.CONFIRM_RESULTS.REPAIR;
      const lossConfig = findCollection('lossReports');
      const nextLoss = cleanForSave(loss);
      nextLoss.status = rules.lossStatusAfterConfirm(resultType);
      nextLoss.result = resultType;
      const updatedLoss = records.update('lossReports', loss.id, {
        status: nextLoss.status,
        title: titleFor(lossConfig, nextLoss),
        data: nextLoss
      });
      events.insert({
        recordId: loss.id,
        collection: 'lossReports',
        action: '确认缺损',
        status: nextLoss.status,
        actor: body.actor || '',
        note: '确认结果：' + resultType,
        data: { result: resultType }
      });
      updatedLosses.push(updatedLoss);

      // 物件状态联动
      const itemCollectionName = loss.itemType === 'puppetHead' ? 'puppetHeads' : 'accessories';
      const item = records.findById(itemCollectionName, loss.itemId);
      if (item) {
        const itemConfig = findCollection(itemCollectionName);
        const nextItem = cleanForSave(item);
        if (loss.itemType === 'puppetHead') {
          nextItem.status = rules.headStatusAfterLoss(resultType);
        } else {
          nextItem.status = rules.accessoryStatusAfterLoss(resultType);
          if (resultType === rules.CONFIRM_RESULTS.LOST) {
            nextItem.availableQty = Math.max(0, (nextItem.availableQty != null ? nextItem.availableQty : 1) - 1);
          }
        }
        const updatedItem = records.update(itemCollectionName, loss.itemId, {
          status: nextItem.status,
          title: titleFor(itemConfig, nextItem),
          data: nextItem
        });
        events.insert({
          recordId: loss.itemId,
          collection: itemCollectionName,
          action: '缺损确认联动',
          status: nextItem.status,
          actor: body.actor || '',
          note: '缺损确认：' + resultType,
          data: { lossReportId: loss.id, result: resultType }
        });
        updatedItems.push(updatedItem);
      }
    }

    // 装箱单清点闭环
    const boxConfig = findCollection('tourBoxes');
    const nextBox = cleanForSave(tourBox);
    nextBox.status = '已闭环';
    nextBox.closedAt = db.now();
    const updatedBox = records.update('tourBoxes', tourBoxId, {
      status: nextBox.status,
      title: titleFor(boxConfig, nextBox),
      data: nextBox
    });
    events.insert({
      recordId: tourBoxId,
      collection: 'tourBoxes',
      action: '确认闭环',
      status: '已闭环',
      actor: body.actor || '',
      note: '返场清点确认完成',
      data: { confirmedCount: pendingLosses.length }
    });

    return { tourBox: updatedBox, lossReports: updatedLosses, items: updatedItems };
  });
  return result;
}

// 可演出清单：待修补或待处理缺损的不列入
function performableList(query) {
  const play = query.play;
  const heads = records.list('puppetHeads');
  const accessories = records.list('accessories');
  const openRepairs = records.list('repairRecords');
  const pendingLosses = records
    .list('lossReports')
    .filter((loss) => rules.LOSS_BLOCKING_STATUSES.includes(loss.status));

  let filteredHeads = heads.filter((head) => rules.isHeadPerformable(head, openRepairs, pendingLosses));
  let filteredAccessories = accessories.filter((accessory) =>
    rules.isAccessoryAvailable(accessory, pendingLosses)
  );

  if (play) {
    filteredHeads = filteredHeads.filter((head) => head.play === play);
    filteredAccessories = filteredAccessories.filter((accessory) => accessory.play === play);
  }

  return { heads: filteredHeads, accessories: filteredAccessories };
}

module.exports = {
  pack,
  changeBox,
  returnTour,
  confirm,
  performableList,
  recomputeMissing
};
