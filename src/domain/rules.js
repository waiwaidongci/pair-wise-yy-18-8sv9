// 规则层：纯函数，不依赖存储与入口。
// 状态链：装箱单 → 入箱(箱号+场次) → 巡演 → 返场清点(待确认缺损) → 确认(物件状态/可用数量/装箱单清点一起生效) → 闭环。

// 偶头可演出状态：处于这些状态才可能上清单
const HEAD_PERFORMABLE_STATUSES = ['可演出', '已装箱'];

// 配件可用状态
const ACCESSORY_AVAILABLE_STATUSES = ['在库', '已装箱'];

// 缺损追踪中会挡住可演出清单的状态
const LOSS_BLOCKING_STATUSES = ['待处理', '待确认'];

// 修补记录未完成的状态
const REPAIR_OPEN_STATUSES = ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中'];

// 偶头可演出条件：
// 1. status 在可演出状态集
// 2. 没有未完成的修补记录
// 3. 没有待处理/待确认的缺损追踪
function isHeadPerformable(head, openRepairs, pendingLosses) {
  if (!HEAD_PERFORMABLE_STATUSES.includes(head.status)) return false;
  const hasOpenRepair = openRepairs.some(
    (repair) => repair.puppetHeadId === head.id && REPAIR_OPEN_STATUSES.includes(repair.status)
  );
  if (hasOpenRepair) return false;
  const hasPendingLoss = pendingLosses.some(
    (loss) =>
      loss.itemType === 'puppetHead' &&
      loss.itemId === head.id &&
      LOSS_BLOCKING_STATUSES.includes(loss.status)
  );
  if (hasPendingLoss) return false;
  return true;
}

// 配件可用条件：
// 1. status 不在 缺损/遗失
// 2. 没有待处理/待确认的缺损追踪
function isAccessoryAvailable(accessory, pendingLosses) {
  if (!ACCESSORY_AVAILABLE_STATUSES.includes(accessory.status)) return false;
  const hasPendingLoss = pendingLosses.some(
    (loss) =>
      loss.itemType === 'accessory' &&
      loss.itemId === accessory.id &&
      LOSS_BLOCKING_STATUSES.includes(loss.status)
  );
  if (hasPendingLoss) return false;
  return true;
}

// 装箱单缺少清单：单据列出但未实际装箱（tourBoxId 不符或 boxNo 为空）
function missingItems(tourBox, allItems) {
  const listedIds = [...(tourBox.headIds || []), ...(tourBox.accessoryIds || [])];
  return allItems.filter(
    (item) =>
      listedIds.includes(item.id) && (item.tourBoxId !== tourBox.id || !item.boxNo)
  );
}

// 返场清点确认结果
const CONFIRM_RESULTS = {
  REPAIR: '修复',
  LOST: '遗失'
};

// 确认缺损后偶头的目标状态
function headStatusAfterLoss(result) {
  return result === CONFIRM_RESULTS.LOST ? '不可演出' : '待修补';
}

// 确认缺损后配件的目标状态
function accessoryStatusAfterLoss(result) {
  return result === CONFIRM_RESULTS.LOST ? '遗失' : '缺损';
}

// 确认缺损后缺损追踪单的目标状态
function lossStatusAfterConfirm(result) {
  return result === CONFIRM_RESULTS.LOST ? '确认为遗失' : '待处理';
}

module.exports = {
  HEAD_PERFORMABLE_STATUSES,
  ACCESSORY_AVAILABLE_STATUSES,
  LOSS_BLOCKING_STATUSES,
  REPAIR_OPEN_STATUSES,
  isHeadPerformable,
  isAccessoryAvailable,
  missingItems,
  CONFIRM_RESULTS,
  headStatusAfterLoss,
  accessoryStatusAfterLoss,
  lossStatusAfterConfirm
};
