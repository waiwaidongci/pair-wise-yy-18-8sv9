# 传统木偶戏班偶头与巡演装箱 API

把**巡演装箱单、偶头档案、服装配件、修补记录、缺损追踪**五本档案接成一条状态链。

## 分层

- `src/store.js` — 存储层。纯 Node（无原生依赖），事务内深拷贝改状态、提交时原子落盘（临时文件 + rename），写事务进程内互斥串行。状态与事件在同一事务写入，失败整体回滚。
- `src/domain.js` — 规则层。全部状态链规则在此：可演出判定、入箱、换箱乐观并发、返场清点与缺损确认、修补恢复、清点重算。
- `src/routes.js` + `server.js` — 入口层。HTTP 只做参数搬运、`X-Request-Id` 透传和响应码，不含业务规则。
- `project.config.js` — 规则配置（状态取值、必填字段、未闭环缺损状态集合等）。

数据文件首次启动创建到 `data/app.db.json`。

## 启动 / 测试

```bash
npm install
npm start          # http://localhost:3914
npm test           # 状态链端到端测试（49 项）
```

## 状态链规则

1. **可演出清单**：待修补 / 修补中 / 试演中 / 缺损 / 遗失，或有未完成修补单、未闭环缺损（`待处理`、`修复中`）的物件，一律排除。
2. **入箱**：`POST /api/state/pack`，物件档案写入所属箱 `tourBoxId`、箱号 `boxNo` 和场次 `showSession`；不可演出物件不列入，返回在 `blocked`。
3. **两班换箱**：`POST /api/state/move`，带期望箱号 `fromBoxId`（乐观并发）。两班同时提交同一物件只一笔成功；后到的一笔拿到 `409 BOX_MOVED`，响应里带**当前箱号**和两张装箱单重算后的缺少清单（`sourceBox.checklist` / `targetBox.checklist`），按当前箱号重试即可。
4. **返场清点**：`POST /api/state/checkins` 先把缺损记为 `待确认`，装箱单进入 `返场清点中` 并锁定（不能再入箱/换箱）。待确认阶段不影响物件状态和可用数量。
5. **缺损确认**：`POST /api/lossReports/:id/confirm`，`resolution=repair|lost|none`：
   - `repair`：同事务把物件转待修补/缺损、置不可用、开立修补单、重算可用数量与清点；
   - `lost`：物件转遗失；`none`：缺损排除。
   全部未决缺损了结后装箱单自动 `已闭环`。
6. **修补完成**：`POST /api/repairRecords/:id/complete`，物件恢复可用、关联缺损标 `已补齐`、重算清点。
7. **幂等**：所有写操作支持 `X-Request-Id`（或 body `requestId`）。写入失败后用同一编号重试，返回第一次成功的结果，不会产生第二次状态变更或重复事件。

## 装箱单清点结构

`GET /api/state/boxes/:id/checklist`：

- `missing` — 清单声明但实物不在本箱（被换走/档案缺失），带 `currentBoxId/currentBoxNo`
- `extra` — 实物在箱但清单未声明（别班换入/串箱）
- `blocked` — 在场但不可演出（待修补、未闭环缺损…），带原因
- `usableHeadCount` / `usableAccessoryCount` — 可演出数量

## 常用接口

- `GET  /api/state/performable?play=火焰山` 可演出清单
- `POST /api/tourBoxes` 创建装箱单（必填 `boxNo` 箱号 + `showSession` 场次）
- `POST /api/state/pack` 物件入箱
- `POST /api/state/move` 换箱（乐观并发）
- `POST /api/state/checkins` 返场清点登记
- `POST /api/lossReports/:id/confirm` 缺损确认
- `POST /api/repairRecords/:id/complete` 修补完成
- `GET  /api/:collection/:id/timeline` 任一档案的事件时间线
- `GET/PATCH /api/:collection[/:id]` 五本档案的通用查询与非状态字段编辑
  （`status`、`tourBoxId`、`showSession`、`currentUsable` 由状态链托管，PATCH 直改会被拒绝）

## 幂等请求示例

```bash
curl -X POST localhost:3914/api/state/move \
  -H 'content-type: application/json' \
  -H 'X-Request-Id: req-20261102-0007' \
  -d '{"itemType":"puppetHeads","itemId":"head-seed-2","fromBoxId":"...","toBoxId":"..."}'
# 网络失败/5xx 后用相同 X-Request-Id 原样重发即可
```
