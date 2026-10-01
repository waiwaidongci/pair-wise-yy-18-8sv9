const express = require('express');
const handlers = require('./handlers');

const router = express.Router();

// 可演出清单（规则过滤：待修补/待处理缺损不列入）
router.get('/performable', handlers.performableList);

// 装箱单缺少清单
router.get('/tourBoxes/:id/missing', handlers.missingList);

// 巡演状态链操作（入箱 / 换箱 / 返场清点 / 确认缺损）
router.post('/tourBoxes/:id/pack', handlers.pack);
router.post('/tourBoxes/:id/return', handlers.returnTour);
router.post('/tourBoxes/:id/confirm', handlers.confirm);
router.post('/changeBox', handlers.changeBox);

// 通用 CRUD
router.get('/:collection', handlers.listCollection);
router.post('/:collection', handlers.createRecord);
router.get('/:collection/:id', handlers.getRecord);
router.patch('/:collection/:id', handlers.updateRecord);
router.post('/:collection/:id/events', handlers.addEvent);
router.get('/:collection/:id/timeline', handlers.timeline);
router.delete('/:collection/:id', handlers.deleteRecord);

module.exports = router;
