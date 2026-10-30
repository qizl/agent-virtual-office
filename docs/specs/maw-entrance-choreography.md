# MAW 入场编排与工位关联缓存（CR-14 / CR-15）

**Status**: implemented (AVO side) · **Rule source**: kit 编排方案 §2 CR-14 / CR-15
（`multi-agent-workflow-office-animation-choreography-2026-10-22.md` v2.10 / R12，
本文件不复制规则正文，只登记 AVO 侧实现面与验收映射）。

## Owner 需求（2026-10-29）

1. 入场动画不要"一个一个进办公室"（呆板）——统一实时与历史为同一条通用入场规则。
2. 浏览器缓存角色↔工位关联：重复加载同一进行中任务或历史任务时，关联不变。

## 规则要点（引用）

- **CR-14 通用入场动画规则**：入场时刻全部成员同时出发，从默认休息席位直达稳定工位
  （管理者到 gate）；无人工逐个错峰。门口按 AVO-187 单人门禁逐个放行、过门即释放，
  队伍节奏完全由门禁机制涌现。CR-1/CR-3/CR-5/CR-9/CR-12 语义不变。
- **CR-15 工位关联缓存**：CR-3 分配结果按「项目/任务」键缓存（localStorage，仅成员键
  与席位坐标）；同一进行中任务或其历史播放重复加载时关联不变；成员集合变化或缓存损坏
  时按 CR-3 重派并覆写；读写异常安全降级；与 CR-1 的 sessionStorage 标记互不影响。

## AVO 实现面

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 入场齐发 | `src/systems/mawChoreography.js` | 发射循环 `delay = 0`（删除 batchStagger）；`planChoreography` `staggerMs` 恒 0（字段保留）；`STAGGER_MS` 仅存于 CR-11 待命 sweep |
| 在途恢复 | `src/systems/mawChoreography.js` enteringStale | 齐发后 stale 边界会冻结整条入场流：被杀的中途行走按 `walkBounds`（member/meeting）回滚 `prevPhase`，恢复后从冻结位置重走当前相位工位（不瞬移）；旧等差时序曾掩盖此洞 |
| 缓存模块 | `src/systems/mawWorkSeatCache.js`（新） | localStorage 单键存储、按任务 8 条 LRU（单调写序号裁决同毫秒并列）、损坏/非法座位过滤、存储不可用静默降级 |
| 实时接线 | `src/systems/mawChoreography.js` + `src/inference/dashboardIntegration.js` | `startMawChoreography({ workSeatCache, onWorkSeatBound })`；`stableWorkSeat` 优先级 = 会话内绑定 > CR-15 缓存 > 建员随机戳 > 桌组扫描 |
| 历史接线 | `src/inference/dashboardIntegration.js` `historyRosterFor` | 历史 roster 同源消费缓存（管理者恒 gate）；roster 座位写回同一缓存 |

## 验收映射

- AVP-C01/C02：`tests/mawChoreography.test.js`（51 项，含齐发/齐批/在途恢复/CR-15 种子）、
  `tests/mawWorkSeatCache.test.js`（6 项：往返、非法过滤、损坏忽略、LRU 清理、历史
  roster 同源、花名册变化重派）、`tests/dashboardIntegration.test.js`（齐发开场 +
  启动快照保路径）；全量 `npm test` 相对基线零新增失败。
- AVP-C03：headless 截图（mock 驱动）供 owner 目验门口成流。
- 门口流效果为 owner 选择（全员齐发·门口成流）；观感验收归 owner。
