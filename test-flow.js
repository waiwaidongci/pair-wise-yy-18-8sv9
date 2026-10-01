const http = require('http');

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3914,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rid() {
  return 'req-' + Math.random().toString(36).slice(2, 10);
}

async function main() {
  console.log('=== 1. 创建巡演装箱单 ===');
  const createBox = await request('POST', '/api/tourBoxes', {
    requestId: rid(),
    showName: '火焰山巡演-上海站',
    venue: '上海大剧院',
    play: '火焰山',
    headIds: [],
    accessoryIds: []
  });
  console.log('状态:', createBox.status);
  const boxId = createBox.body.id;
  console.log('装箱单ID:', boxId);

  console.log('\n=== 2. 入箱：偶头 + 配件 ===');
  const packHead = await request('POST', `/api/tourBoxes/${boxId}/pack`, {
    requestId: rid(),
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    boxNo: '木箱甲-01',
    showName: '火焰山巡演-上海站',
    actor: '班主'
  });
  console.log('偶头入箱:', packHead.status, packHead.body.item ? packHead.body.item.status : packHead.body.error);

  const packAcc = await request('POST', `/api/tourBoxes/${boxId}/pack`, {
    requestId: rid(),
    itemType: 'accessory',
    itemId: 'accessory-seed-1',
    boxNo: '配件箱-01',
    showName: '火焰山巡演-上海站',
    actor: '班主'
  });
  console.log('配件入箱:', packAcc.status, packAcc.body.item ? packAcc.body.item.status : packAcc.body.error);

  console.log('\n=== 3. 可演出清单（入箱后应都不可演出）===');
  const perf = await request('GET', '/api/performable?play=' + encodeURIComponent('火焰山'));
  console.log('可演出偶头:', perf.body.heads.map((h) => h.role));
  console.log('可用配件:', perf.body.accessories.map((a) => a.name));

  console.log('\n=== 4. 缺少清单（刚入箱，应为空）===');
  const missing = await request('GET', `/api/tourBoxes/${boxId}/missing`);
  console.log('缺少:', missing.body.missing.map((m) => m.id));

  console.log('\n=== 5. 换箱并发测试：两个班同时换同一偶头 ===');
  // 先把偶头换到箱乙
  const reqA = rid();
  const reqB = rid();
  const changeA = request('POST', '/api/changeBox', {
    requestId: reqA,
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    fromBoxNo: '木箱甲-01',
    toBoxNo: '木箱乙-04',
    toTourBoxId: boxId,
    actor: '甲班'
  });
  const changeB = request('POST', '/api/changeBox', {
    requestId: reqB,
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    fromBoxNo: '木箱甲-01',
    toBoxNo: '木箱丙-07',
    toTourBoxId: boxId,
    actor: '乙班'
  });
  const [ra, rb] = await Promise.all([changeA, changeB]);
  console.log('甲班换箱:', ra.status, ra.body.item ? ra.body.item.boxNo : ra.body.error);
  console.log('乙班换箱:', rb.status, rb.body.error || '', '当前箱号:', rb.body.currentBoxNo);
  console.log('冲突响应缺少清单:', JSON.stringify(rb.body.missing));

  console.log('\n=== 6. 幂等测试：用同一 requestId 重试乙班换箱 ===');
  const retryB = await request('POST', '/api/changeBox', {
    requestId: reqB,
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    fromBoxNo: '木箱甲-01',
    toBoxNo: '木箱丙-07',
    toTourBoxId: boxId,
    actor: '乙班'
  });
  console.log('重试乙班:', retryB.status, retryB.body.error || '成功', '(应与首次一致)');

  console.log('\n=== 7. 返场清点：登记待确认缺损 ===');
  const ret = await request('POST', `/api/tourBoxes/${boxId}/return`, {
    requestId: rid(),
    defects: [
      { itemType: 'puppetHead', itemId: 'head-seed-1', itemName: '武生偶头', problem: '回箱时磕碰，左颊掉漆' },
      { itemType: 'accessory', itemId: 'accessory-seed-1', itemName: '红缨冠', problem: '冠缨散乱' }
    ],
    actor: '班主'
  });
  console.log('返场清点:', ret.status, '装箱单状态:', ret.body.tourBox ? ret.body.tourBox.status : ret.body.error);
  console.log('待确认缺损数:', ret.body.lossReports ? ret.body.lossReports.length : 0);
  const lossId = ret.body.lossReports ? ret.body.lossReports[0].id : null;

  console.log('\n=== 8. 确认缺损：偶头待修补、配件缺损、装箱单闭环 ===');
  const conf = await request('POST', `/api/tourBoxes/${boxId}/confirm`, {
    requestId: rid(),
    resolutions: [
      { lossReportId: lossId, result: '修复' },
      { lossReportId: ret.body.lossReports[1].id, result: '修复' }
    ],
    actor: '班主'
  });
  console.log('确认:', conf.status, '装箱单状态:', conf.body.tourBox ? conf.body.tourBox.status : conf.body.error);
  console.log('偶头状态:', conf.body.items ? conf.body.items.find((i) => i.id === 'head-seed-1').status : 'N/A');
  console.log('配件状态:', conf.body.items ? conf.body.items.find((i) => i.id === 'accessory-seed-1').status : 'N/A');

  console.log('\n=== 9. 可演出清单（确认后偶头待修补，应排除）===');
  const perf2 = await request('GET', '/api/performable?play=' + encodeURIComponent('火焰山'));
  console.log('可演出偶头:', perf2.body.heads.map((h) => h.role));
  console.log('可用配件:', perf2.body.accessories.map((a) => a.name));

  console.log('\n=== 10. 时间线：偶头的状态链事件 ===');
  const tl = await request('GET', '/api/puppetHeads/head-seed-1/timeline');
  console.log('事件数:', tl.body.events.length);
  tl.body.events.forEach((e) => console.log(' -', e.action, e.status, e.note));
}

main().catch(console.error);
