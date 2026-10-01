'use strict';

// ============================================================
// 入口层：HTTP 路由。只负责取参数、透传 requestId、按结果码应答，
// 不写业务规则（规则在 src/domain.js，持久化在 src/store.js）。
//
// 幂等约定：所有状态链写操作从 header X-Request-Id 或 body.requestId
// 取请求编号。写入失败后客户端用同一编号重试，直接返回第一次的结果。
// ============================================================

const express = require('express');
const config = require('../project.config');
const domain = require('./domain');

const router = express.Router();

function requestIdOf(req) {
  return req.header('X-Request-Id') || (req.body && req.body.requestId) || null;
}

async function send(resultPromise, res, next) {
  try {
    const result = await resultPromise;
    res.status(result.statusCode || 200).json(result.body);
  } catch (error) {
    next(error);
  }
}

// ---- 元数据 / 健康检查 ----

router.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title });
});

router.get('/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// ---- 状态链入口（须定义在通用 /:collection 之前，避免被截获）----

// 可演出清单：自动排除待修补/修补中/待处理缺损
router.get('/state/performable', (req, res, next) => {
  try {
    res.json(domain.performable(req.query));
  } catch (error) {
    next(error);
  }
});

// 装箱单清点（缺少清单 / 可用数量）
router.get('/state/boxes/:boxId/checklist', (req, res, next) => {
  try {
    res.json(domain.boxChecklist(req.params.boxId));
  } catch (error) {
    next(error);
  }
});

// 物件入箱：写明所属箱与场次；不可演出物件被挡下
router.post('/state/pack', (req, res, next) => {
  send(domain.pack(req.body, { requestId: requestIdOf(req) }), res, next);
});

// 两班换箱：fromBoxId 为期望箱号；冲突时 409 返回当前箱号和两箱缺少清单
router.post('/state/move', (req, res, next) => {
  send(domain.move(req.body, { requestId: requestIdOf(req) }), res, next);
});

// 返场清点：缺损先记待确认，装箱单进入清点中并锁定
router.post('/state/checkins', (req, res, next) => {
  send(domain.checkin(req.body, { requestId: requestIdOf(req) }), res, next);
});

// 缺损确认：repair / lost / none —— 物件状态、修补单、可用数量、装箱单清点同事务生效
router.post('/lossReports/:id/confirm', (req, res, next) => {
  send(domain.confirmLoss(req.params.id, req.body, { requestId: requestIdOf(req) }), res, next);
});

// 修补完成：恢复物件可用，关联缺损标已补齐，重算装箱单
router.post('/repairRecords/:id/complete', (req, res, next) => {
  send(domain.completeRepair(req.params.id, req.body, { requestId: requestIdOf(req) }), res, next);
});

// ---- 五本档案的只读与通用建档 ----

router.get('/:collection', (req, res, next) => {
  try {
    res.json(domain.queryRecords(req.params.collection, req.query));
  } catch (error) {
    next(error);
  }
});

router.get('/:collection/:id', (req, res, next) => {
  try {
    const rows = domain.queryRecords(req.params.collection, {});
    const record = rows.find((row) => row.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

router.get('/:collection/:id/timeline', (req, res, next) => {
  try {
    res.json(domain.timeline(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

router.post('/:collection', (req, res, next) => {
  const collection = req.params.collection;
  // 装箱单走专用建箱入口（强制箱号+场次）；缺损走待确认登记入口
  if (collection === 'tourBoxes') return send(domain.createBox(req.body, { requestId: requestIdOf(req) }), res, next);
  if (collection === 'lossReports') return send(domain.createLoss(req.body, { requestId: requestIdOf(req) }), res, next);
  return send(domain.createRecord(collection, req.body, { requestId: requestIdOf(req) }), res, next);
});

router.patch('/:collection/:id', (req, res, next) => {
  send(domain.patchRecord(req.params.collection, req.params.id, req.body, { requestId: requestIdOf(req) }), res, next);
});

module.exports = router;
