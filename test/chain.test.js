'use strict';

// 状态链端到端测试：用独立 DATA_DIR 起内存隔离的服务，验证：
// 1) 待修补/待处理缺损不进可演出清单、不能入箱
// 2) 入箱写明箱号与场次
// 3) 两班并发抢同一物件换箱：一成一败，后到拿当前箱号 + 两箱缺少清单
// 4) 返场清点先待确认；确认后状态/数量/清点同事务生效；闭环
// 5) 写失败保留请求编号，重试沿用第一次结果
// 6) 每次状态变更必有事件（状态与事件同生共死）

process.env.DATA_DIR = require('path').join(__dirname, '..', 'data-test');
process.env.PORT = '3988';

const fs = require('fs');
if (fs.existsSync(process.env.DATA_DIR)) {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}

const http = require('http');
const app = require('../server');
const store = require('../src/store');

let passed = 0;
let failed = 0;
function assert(cond, message) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + message);
  } else {
    failed += 1;
    console.error('  ✗ ' + message);
  }
}

let server;
function request(method, url, body, requestId) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = { 'content-type': 'application/json' };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (requestId) headers['x-request-id'] = requestId;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: process.env.PORT, path: encodeURI('/api' + url), method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

async function main() {
  await new Promise((resolve) => {
    server = app.listen(process.env.PORT, resolve);
  });

  // ---------- 1. 可演出清单排除待修补 ----------
  console.log('\n[1] 待修补物件不进可演出清单');
  let res = await request('GET', '/state/performable?play=火焰山');
  const headIds = res.body.puppetHeads.map((h) => h.id);
  assert(headIds.includes('head-seed-2'), '可演出的孙悟空在清单内');
  assert(!headIds.includes('head-seed-1'), '待修补的武生不在清单内');

  // ---------- 2. 建两张箱 + 入箱 ----------
  console.log('\n[2] 入箱写明箱号与场次，不可演出被挡');
  res = await request('POST', '/tourBoxes', {
    showName: '江南巡演',
    venue: '苏州开明戏院',
    play: '火焰山',
    boxNo: '木箱甲-01',
    showSession: '2026-11-02-晚场'
  }, rid('boxA'));
  assert(res.status === 201, '装箱单A创建');
  const boxA = res.body.id;

  res = await request('POST', '/tourBoxes', {
    showName: '江南巡演',
    venue: '杭州红星剧院',
    play: '火焰山',
    boxNo: '木箱乙-02',
    showSession: '2026-11-03-晚场'
  }, rid('boxB'));
  const boxB = res.body.id;
  assert(res.status === 201, '装箱单B创建');

  res = await request('POST', '/state/pack', {
    tourBoxId: boxA,
    itemType: 'puppetHeads',
    itemIds: ['head-seed-2', 'head-seed-1'],
    finalize: true
  }, rid('pack1'));
  assert(res.status === 200, '装箱返回200');
  assert(res.body.packed.some((p) => p.itemId === 'head-seed-2'), '孙悟空成功入箱');
  assert(res.body.blocked.some((p) => p.itemId === 'head-seed-1'), '待修补武生被挡下列入 blocked');
  assert(res.body.tourBox.boxNo === '木箱甲-01', '装箱单带箱号');
  assert(res.body.tourBox.showSession === '2026-11-02-晚场', '装箱单带场次');

  res = await request('GET', '/puppetHeads/head-seed-2');
  assert(res.body.tourBoxId === boxA, '物件档案写入所属箱');
  assert(res.body.boxNo === '木箱甲-01' && res.body.showSession === '2026-11-02-晚场', '物件档案写明箱号与场次');

  // 配件入箱
  res = await request('POST', '/state/pack', {
    tourBoxId: boxA,
    itemType: 'accessories',
    itemIds: ['accessory-seed-2']
  }, rid('pack2'));
  assert(res.body.blocked.length === 0, '紫金冠正常入箱');

  // ---------- 3. 两班并发换箱 ----------
  console.log('\n[3] 两班同时抢同一物件换箱，只一笔成功');
  const idA = rid('move-A');
  const idB = rid('move-B');
  const [r1, r2] = await Promise.all([
    request('POST', '/state/move', { itemType: 'puppetHeads', itemId: 'head-seed-2', fromBoxId: boxA, toBoxId: boxB }, idA),
    request('POST', '/state/move', { itemType: 'puppetHeads', itemId: 'head-seed-2', fromBoxId: boxA, toBoxId: boxB }, idB)
  ]);
  const winner = r1.status === 200 ? r1 : r2;
  const loser = r1.status === 200 ? r2 : r1;
  assert(winner.status === 200, '一笔换箱成功');
  assert(loser.status === 409 && loser.body.code === 'BOX_MOVED', '后到一笔冲突 409 BOX_MOVED');
  assert(loser.body.currentBoxId === boxB, '后到一笔返回当前箱号(目标箱)');
  assert(loser.body.sourceBox.checklist && loser.body.targetBox.checklist, '后到一笔带回两张装箱单清点');
  const srcMissing = loser.body.sourceBox.checklist.missing;
  assert(srcMissing.some((m) => m.itemId === 'head-seed-2'), '源箱缺少清单包含被换走的物件');

  res = await request('GET', '/puppetHeads/head-seed-2');
  assert(res.body.tourBoxId === boxB, '物件最终只属于目标箱（无重复挂箱）');

  // 失败班按当前箱号重试 -> 成功换回
  res = await request('POST', '/state/move', { itemType: 'puppetHeads', itemId: 'head-seed-2', fromBoxId: boxB, toBoxId: boxA }, rid('move-retry'));
  assert(res.status === 200 && res.body.moved.toBoxId === boxA, '按返回的当前箱号重试换箱成功');

  // ---------- 4. 幂等：同请求编号重试沿用第一次结果 ----------
  console.log('\n[4] 写入幂等：同 requestId 重试不产生第二次效果');
  const sameId = rid('idem');
  const first = await request('POST', '/state/pack', {
    tourBoxId: boxB,
    itemType: 'accessories',
    itemIds: ['accessory-seed-1']
  }, sameId);
  const again = await request('POST', '/state/pack', {
    tourBoxId: boxB,
    itemType: 'accessories',
    itemIds: ['accessory-seed-1']
  }, sameId);
  assert(first.status === 200 && again.status === 200, '两次都200');
  const tlBox = await request('GET', '/tourBoxes/' + boxB + '/timeline');
  const tlItem = await request('GET', '/accessories/accessory-seed-1/timeline');
  const boxIdemEvents = tlBox.body.events.filter((e) => e.requestId === sameId);
  const itemIdemEvents = tlItem.body.events.filter((e) => e.requestId === sameId);
  assert(boxIdemEvents.length === 1, '同 requestId 装箱单只产生一次事件，got ' + boxIdemEvents.length);
  assert(itemIdemEvents.length === 1 && itemIdemEvents[0].action === '入箱', '同 requestId 物件只入箱一次');

  // ---------- 5. 写入失败后保留请求编号，重试沿用第一次结果 ----------
  console.log('\n[5] 写入失败：状态不变、无事件；重试同编号成功且只生效一次');
  const failId = rid('failmove');
  store._setFault(failId);
  let failedCall;
  try {
    failedCall = await request('POST', '/state/move', { itemType: 'accessories', itemId: 'accessory-seed-1', fromBoxId: boxB, toBoxId: boxA }, failId);
  } catch (e) {
    failedCall = { status: 500, body: null };
  }
  assert(failedCall.status === 500, '注入写失败时返回500');
  res = await request('GET', '/accessories/accessory-seed-1');
  assert(res.body.tourBoxId === boxB, '失败后物件仍在原箱（事务回滚）');
  const tlB = await request('GET', '/tourBoxes/' + boxB + '/timeline');
  assert(!tlB.body.events.some((e) => e.requestId === failId), '失败请求没有留下任何事件');

  const retryOk = await request('POST', '/state/move', { itemType: 'accessories', itemId: 'accessory-seed-1', fromBoxId: boxB, toBoxId: boxA }, failId);
  assert(retryOk.status === 200 && retryOk.body.moved.toBoxId === boxA, '同一请求编号重试成功');
  const retryAgain = await request('POST', '/state/move', { itemType: 'accessories', itemId: 'accessory-seed-1', fromBoxId: boxB, toBoxId: boxA }, failId);
  assert(retryAgain.status === 200 && retryAgain.body.moved.toBoxId === boxA, '再次重试沿用第一次结果');
  const tlB2 = await request('GET', '/tourBoxes/' + boxB + '/timeline');
  const failEvents = tlB2.body.events.filter((e) => e.requestId === failId);
  assert(failEvents.length >= 1 && new Set(failEvents.map((e) => e.seq)).size === failEvents.length, '失败编号只在真正成功时产生一次事件链');

  // ---------- 6. 返场清点：待确认不影响可用，确认后一起生效 ----------
  console.log('\n[6] 返场清点：待确认 -> 确认修复，状态/数量/清点同事务生效');
  // 先确认孙悟空在箱A
  res = await request('GET', '/state/boxes/' + boxA + '/checklist');
  const usableBefore = res.body.checklist.usableHeadCount;

  res = await request('POST', '/state/checkins', {
    tourBoxId: boxA,
    items: [{ itemType: 'puppetHeads', itemId: 'head-seed-2', problem: '凤翅零星褪色' }]
  }, rid('checkin'));
  assert(res.status === 201, '清点登记成功');
  assert(res.body.lossReports[0].status === '待确认', '缺损先记待确认');
  assert(res.body.tourBox.status === '返场清点中', '装箱单进入返场清点中');

  // 待确认阶段：物件状态与可用数量不变
  res = await request('GET', '/puppetHeads/head-seed-2');
  assert(res.body.status === '已装箱' && res.body.currentUsable === true, '待确认阶段物件仍可演出');
  res = await request('GET', '/state/performable?play=火焰山');
  assert(res.body.puppetHeads.some((h) => h.id === 'head-seed-2'), '待确认阶段仍在可演出清单');

  // 锁定后不能再入箱/换箱
  res = await request('POST', '/state/move', { itemType: 'puppetHeads', itemId: 'head-seed-2', fromBoxId: boxA, toBoxId: boxB }, rid('move-locked'));
  assert(res.status === 409 && res.body.code === 'BOX_LOCKED', '清点中的装箱单锁定，拒绝换箱');

  // 确认修复：同事务生效
  const lossId = (await request('GET', '/lossReports?tourBoxId=' + boxA)).body[0].id;
  res = await request('POST', '/lossReports/' + lossId + '/confirm', {
    resolution: 'repair',
    repairType: '补漆',
    handler: '陈师傅'
  }, rid('confirm'));
  assert(res.status === 200, '确认缺损成功');
  assert(res.body.lossReport.status === '修复中', '缺损转修复中');
  assert(res.body.item.status === '待修补' && res.body.item.currentUsable === false, '物件同事务转待修补且不可用');
  assert(res.body.repair && res.body.repair.status === '待处理' && res.body.repair.handler === '陈师傅', '同事务开立修补单');
  assert(res.body.tourBox.usableHeadCount === Math.max(0, usableBefore - 1), '可用数量同事务重算');
  assert(res.body.checklist.blocked.some((b) => b.itemId === 'head-seed-2'), '清点结果同步标 blocked');

  // 可演出清单立即排除
  res = await request('GET', '/state/performable?play=火焰山');
  assert(!res.body.puppetHeads.some((h) => h.id === 'head-seed-2'), '修复中的偶头退出可演出清单');

  // ---------- 7. 修补完成 -> 已补齐 -> 装箱单闭环 ----------
  console.log('\n[7] 修补完成恢复可用，缺损补齐，装箱单闭环');
  const repairId = (await request('GET', '/repairRecords?itemId=head-seed-2')).body[0].id;
  res = await request('POST', '/repairRecords/' + repairId + '/complete', { resultNote: '补漆完成' }, rid('repair-done'));
  assert(res.body.repair.status === '已完成', '修补单完成');
  assert(res.body.item.currentUsable === true && ['可演出', '已装箱'].includes(res.body.item.status), '物件恢复可用');
  assert(res.body.lossReport.status === '已补齐', '缺损已补齐');
  assert(res.body.tourBox.status === '已闭环', '所有缺损闭环后装箱单自动闭环');

  res = await request('GET', '/state/performable?play=火焰山');
  assert(res.body.puppetHeads.some((h) => h.id === 'head-seed-2'), '补齐后偶头重回可演出清单');

  // ---------- 8. 遗失分支 + 状态必有事件 ----------
  console.log('\n[8] 遗失分支与事件一致性');
  // 新建一箱走遗失
  res = await request('POST', '/tourBoxes', {
    showName: '北方巡演', venue: '天津', play: '钟馗嫁妹', boxNo: '木箱丙-03', showSession: '2026-12-01-午场'
  }, rid('boxC'));
  const boxC = res.body.id;
  res = await request('POST', '/state/checkins', {
    tourBoxId: boxC,
    items: [{ itemType: 'accessories', itemName: '官帽', problem: '清点无此件' }]
  }, rid('checkin-c'));
  const lossC = res.body.lossReports[0].id;
  res = await request('POST', '/lossReports/' + lossC + '/confirm', { resolution: 'lost' }, rid('lost-c'));
  assert(res.body.lossReport.status === '确认为遗失', '缺损确认为遗失');
  assert(res.body.tourBox.status === '已闭环', '无其他未决缺损，装箱单闭环');

  // 状态与事件一致性：扫描所有记录，每次状态都能在时间线找到对应事件
  const summary = store.read((s) => {
    let checked = 0;
    let eventful = 0;
    for (const key of Object.keys(s.records)) {
      const [collection, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
      const record = s.records[key];
      const events = s.events.filter((e) => e.recordId === id);
      checked += 1;
      if (events.length === 0) return { ok: false, id, reason: '记录无事件' };
      const statuses = new Set(events.map((e) => e.status).filter(Boolean));
      if (!statuses.has(record.status)) return { ok: false, id, reason: '当前状态在时间线无对应事件' };
      eventful += 1;
    }
    return { ok: true, checked, eventful };
  });
  assert(summary.ok, '每条记录都有事件且当前状态在时间线可追溯（checked=' + summary.checked + '）');

  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败\n');
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  server && server.close();
  process.exit(1);
});
