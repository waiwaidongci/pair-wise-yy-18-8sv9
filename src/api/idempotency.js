const idempotency = require('../storage/idempotency');

// 请求编号幂等：同一 requestId 只执行第一次，重试沿用第一次结果（含失败）。
// 写入失败后保留请求编号，重试不重复执行；状态变更必须伴随事件。
function withIdempotency(action, handler) {
  return async (req, res, next) => {
    try {
      const requestId = req.body.requestId || req.header('X-Request-Id');
      if (!requestId) {
        return res.status(400).json({ error: '缺少 requestId（请求编号）' });
      }
      const existing = idempotency.find(requestId);
      if (existing) {
        const { _status, ...body } = existing.result;
        return res.status(_status || 200).json(body);
      }
      try {
        const result = await handler(req);
        const statusCode = result._status || 200;
        const { _status, ...body } = result;
        idempotency.store({
          requestId,
          collection: result.collection || (req.params && req.params.collection) || '',
          action,
          recordId: result.recordId || result.item?.id || result.tourBox?.id || '',
          status: 'succeeded',
          result
        });
        res.status(statusCode).json(body);
      } catch (error) {
        const failure = {
          _status: error.status || 500,
          error: error.message,
          code: error.code,
          currentBoxNo: error.currentBoxNo,
          currentVersion: error.currentVersion,
          currentItem: error.currentItem,
          missing: error.missing
        };
        idempotency.store({
          requestId,
          collection: '',
          action,
          recordId: '',
          status: 'failed',
          result: failure
        });
        const { _status, ...body } = failure;
        res.status(error.status || 500).json(body);
      }
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { withIdempotency };
