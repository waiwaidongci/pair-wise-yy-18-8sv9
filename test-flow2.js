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
  console.log('=== A. 多数量配件：入箱与遗失确认的可用数量 ===');
  // 创建一个数量为 5 的配件
  const createAcc = await request('POST', '/api/accessories', {
    requestId: rid(),
    name: '红缨枪缨',
    role: '武生',
    play: '火焰山',
    boxNo: '配件箱-03',
    quantity: 5,
    availableQty: 5,
    actor: '班主'
  });
  const accId = createAcc.body.id;
  console.log('创建配件:', createAcc.status, '数量:', createAcc.body.quantity, '可用:', createAcc.body.availableQty);

  // 创建装箱单并入箱 1 件
  const box1 = await request('POST', '/api/tourBoxes', {
    requestId: rid(),
    showName: '火焰山巡演-北京站',
    venue: '北京剧院',
    play: '火焰山',
    headIds: [],
    accessoryIds: []
  });
  const box1Id = box1.body.id;
  await request('POST', `/api/tourBoxes/${box1Id}/pack`, {
    requestId: rid(),
    itemType: 'accessory',
    itemId: accId,
    boxNo: '配件箱-03',
    showName: '火焰山巡演-北京站',
    actor: '班主'
  });
  const accAfterPack = await request('GET', `/api/accessories/${accId}`);
  console.log('入箱后可用数量:', accAfterPack.body.availableQty, '(应=4)');

  // 返场清点：登记 1 件遗失
  const ret = await request('POST', `/api/tourBoxes/${box1Id}/return`, {
    requestId: rid(),
    defects: [{ itemType: 'accessory', itemId: accId, itemName: '红缨枪缨', problem: '枪缨在巡演中遗失' }],
    actor: '班主'
  });
  const lossId = ret.body.lossReports[0].id;
  console.log('返场清点:', ret.body.tourBox.status, '待确认缺损:', ret.body.lossReports.length);

  // 确认遗失
  const conf = await request('POST', `/api/tourBoxes/${box1Id}/confirm`, {
    requestId: rid(),
    resolutions: [{ lossReportId: lossId, result: '遗失' }],
    actor: '班主'
  });
  const accAfterConfirm = await request('GET', `/api/accessories/${accId}`);
  console.log('确认遗失后: 状态=', accAfterConfirm.body.status, '可用数量=', accAfterConfirm.body.availableQty, '(应=3)');
  console.log('缺损追踪状态=', conf.body.lossReports[0].status);
  console.log('装箱单状态=', conf.body.tourBox.status);

  console.log('\n=== B. 两张装箱单换箱冲突：缺少清单重算 ===');
  // 创建第二张装箱单
  const box2 = await request('POST', '/api/tourBoxes', {
    requestId: rid(),
    showName: '火焰山巡演-广州站',
    venue: '广州大剧院',
    play: '火焰山',
    headIds: [],
    accessoryIds: []
  });
  const box2Id = box2.body.id;

  // 把一个偶头（用种子偶头，当前在木箱乙-04）换箱
  // 甲班：木箱乙-04 → 木箱丁-09 (box1)
  // 乙班：木箱乙-04 → 木箱戊-10 (box2)
  const rA = rid();
  const rB = rid();
  const pA = request('POST', '/api/changeBox', {
    requestId: rA,
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    fromBoxNo: '木箱乙-04',
    toBoxNo: '木箱丁-09',
    toTourBoxId: box1Id,
    actor: '甲班'
  });
  const pB = request('POST', '/api/changeBox', {
    requestId: rB,
    itemType: 'puppetHead',
    itemId: 'head-seed-1',
    fromBoxNo: '木箱乙-04',
    toBoxNo: '木箱戊-10',
    toTourBoxId: box2Id,
    actor: '乙班'
  });
  const [a, b] = await Promise.all([pA, pB]);
  console.log('甲班:', a.status, a.body.item ? a.body.item.boxNo : a.body.error);
  console.log('乙班:', b.status, b.body.error || '', '当前箱号:', b.body.currentBoxNo);
  console.log('乙班冲突缺少清单 keys:', Object.keys(b.body.missing || {}));
  for (const [k, v] of Object.entries(b.body.missing || {})) {
    console.log('  ', k, '缺少:', v.map((i) => i.id));
  }

  console.log('\n=== C. 事件溯源：每次状态变更都有事件 ===');
  const tl = await request('GET', '/api/accessories/' + accId + '/timeline');
  console.log('配件事件数:', tl.body.events.length);
  tl.body.events.forEach((e) => console.log(' -', e.action, e.status, e.note));
}

main().catch(console.error);
