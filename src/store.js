'use strict';

// ============================================================
// 存储层：只管持久化与事务，不认识任何业务规则。
// 纯 Node 实现（无原生依赖）：进程内互斥串行化写事务，
// 提交时原子落盘（临时文件 + rename），失败整体回滚不留半截状态。
// ============================================================

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db.json');

let state = null;
let writeChain = Promise.resolve();
let seqCounter = 0;

// 测试钩子：安排下一次落盘按 requestId 抛错（模拟写入失败），事务整体回滚，
// 但请求编号由客户端保留；不注入状态、不注入事件。
const fault = { requestId: null };
function _setFault(requestId) {
  fault.requestId = requestId;
}

function freshState() {
  return { records: {}, events: [], requests: {} };
}

function load() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = raw.trim() ? JSON.parse(raw) : freshState();
  } else {
    state = freshState();
  }
  state.records = state.records || {};
  state.events = state.events || [];
  state.requests = state.requests || {};
  seqCounter = state.events.reduce((max, event) => Math.max(max, event.seq || 0), 0);
  return state;
}

function persist() {
  const tmp = DB_FILE + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

// 只读访问，不排队、不落盘
function read(fn) {
  const s = load();
  return fn(s);
}

// 写事务：互斥串行；fn 在状态深拷贝上操作，抛错则整体回滚，
// 正常返回后原子落盘。绝不允许“状态变了却没有事件”——
// 状态与事件在同一次提交里一起落盘。
function transaction(fn, { requestId = null } = {}) {
  const run = writeChain.then(async () => {
    const s = load();
    const working = structuredClone(s);
    const result = await fn(working);
    if (fault.requestId && fault.requestId === requestId) {
      fault.requestId = null;
      throw new Error('INJECTED_WRITE_FAILURE');
    }
    state = working;
    persist();
    return result;
  });
  // 无论成败都放行队列
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// ---- 基础读写（在事务/只读回调拿到的 s 上操作）----

function getRecord(s, collection, id) {
  const key = collection + '/' + id;
  return s.records[key] ? structuredClone(s.records[key]) : null;
}

function listRecords(s, collection) {
  const prefix = collection + '/';
  return Object.keys(s.records)
    .filter((key) => key.startsWith(prefix))
    .map((key) => structuredClone(s.records[key]));
}

function putRecord(s, record) {
  s.records[record.collection + '/' + record.id] = structuredClone(record);
}

function deleteRecord(s, collection, id) {
  delete s.records[collection + '/' + id];
}

// 追加事件。recordId 可空（如装箱单汇总事件），seq 保证时间线有序。
function appendEvent(s, event) {
  seqCounter += 1;
  const full = {
    id: randomUUID(),
    seq: seqCounter,
    recordId: event.recordId || null,
    collection: event.collection,
    action: event.action,
    status: event.status || null,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || {},
    requestId: event.requestId || null,
    createdAt: nowIso()
  };
  s.events.push(full);
  return full;
}

function eventsOf(s, recordId) {
  return s.events
    .filter((event) => event.recordId === recordId)
    .sort((a, b) => a.seq - b.seq)
    .map((event) => structuredClone(event));
}

// ---- 幂等请求台账（和状态、事件在同一事务里写入）----

function getRequest(s, requestId) {
  return requestId && s.requests[requestId] ? structuredClone(s.requests[requestId]) : null;
}

function saveRequest(s, entry) {
  if (entry.requestId) s.requests[entry.requestId] = structuredClone(entry);
}

function toView(record) {
  return {
    id: record.id,
    collection: record.collection,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...record.data
  };
}

module.exports = {
  read,
  transaction,
  getRecord,
  listRecords,
  putRecord,
  deleteRecord,
  appendEvent,
  eventsOf,
  getRequest,
  saveRequest,
  toView,
  nowIso,
  _setFault
};
