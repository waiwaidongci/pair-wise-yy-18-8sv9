module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  // 规则配置：状态机取值只在这里声明，流转规则见 src/domain.js
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '已装箱', '遗失'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['itemType', 'itemId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'boxNo', 'showSession'],
      titleFields: ['showName', 'play'],
      // 返场清点后锁定，不能再入箱/换箱
      lockedStatuses: ['返场清点中', '已闭环']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待确认',
      // 待确认 -> 修复中/确认为遗失/已排除；修复中 -> 已补齐
      statuses: ['待确认', '待处理', '修复中', '已补齐', '确认为遗失', '已排除'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  // 物件类型 -> 档案集合
  itemTypes: {
    puppetHeads: 'puppetHeads',
    accessories: 'accessories'
  },
  // 已确认且未闭环的缺损状态：命中即不可演出（“待处理缺损”）。
  // 注意“待确认”不在其中——清点先登记，确认后才影响物件状态与可用数量。
  openLossStatuses: ['待处理', '修复中'],
  // 装箱单闭环前必须全部了结的缺损状态（含待确认）
  unresolvedLossStatuses: ['待确认', '待处理', '修复中'],
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '彩面完好',
        mechanism: '活眼灵活',
        accessories: ['紫金冠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '紫金冠',
        role: '孙悟空',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'tourBoxes',
      id: 'box-seed-1',
      status: '草稿',
      data: {
        showName: '江南巡演',
        venue: '苏州开明戏院',
        play: '火焰山',
        boxNo: '木箱甲-01',
        showSession: '2026-11-02-晚场',
        headIds: [],
        accessoryIds: [],
        usableHeadCount: 0,
        usableAccessoryCount: 0
      }
    }
  ],
  examples: [
    'GET /api/state/performable?play=火焰山 查询可演出清单（自动排除待修补/待处理缺损）',
    'POST /api/tourBoxes 创建巡演装箱单（boxNo 箱号 + showSession 场次）',
    'POST /api/state/pack 物件入箱，写明所属箱与场次',
    'POST /api/state/move 两班换箱冲突时后到方拿回当前箱号与两箱缺少清单',
    'POST /api/state/checkins 返场清点，缺损先记待确认',
    'POST /api/lossReports/:id/confirm 确认缺损：修复/遗失/无缺损，状态与清点一起生效'
  ]
};
