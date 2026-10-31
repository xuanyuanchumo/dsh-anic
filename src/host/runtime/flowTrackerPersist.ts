/**
 * flow-tracker 的**持久化面**（cycle-94 · 从 `flowTracker.ts` 拆出，守 T3 ≤250 行）。
 *
 * ## 为什么拆（职责，不是行数）
 *
 * `flowTracker.ts` 回答的是「一次流程怎么从 INVOKING 走到终态」（**生命周期**），
 * 本文件回答的是「这份状态怎么落到磁盘、怎么从磁盘读回来」（**持久化**）。
 * 两者的变更节奏完全不同：生命周期每轮都在改（新增状态、新增字段），
 * 而持久化只在**文件形状变化**时改。
 *
 * 混在一起的真实代价：cycle-94 引入 `watermark` 字段时，改的是**文件形状**
 * （纯序列化问题），却必须动那个正在被 6 个调用点依赖的生命周期文件 ——
 * 结果就是把 `flowTracker.ts` 顶过了 250 行。
 *
 * ## 向后兼容契约（三条，都有测试钉死）
 *
 * 1. **v1 文件**（无 `version`）：`flows` / `counter` 语义与 v2 完全一致
 *    （`counter` 本来就是单调累计值）⇒ **无需迁移**。
 * 2. **无 `watermark` 的旧文件**：回落空水位线，**不伪造** `evictedThrough`。
 *    这不是省略，是诚实：旧文件里我们**确实不知道**丢过多少。`counter` 与
 *    `flows.length` 之差可作"丢过多少"的下界（那是 `truncationInfo` 的判据），
 *    但**淘汰落点**（切在哪一条之后）只能从淘汰发生的那一刻记下来——事后无法反推。
 * 3. **写侧不写 undefined 键**：`watermark` 缺失时整个键不出现，让"从未淘汰过"
 *    的项目，其 `flow-tracker.json` 与改造前**逐字节可比**（既有 golden 测试零 diff）。
 *
 * ## 边界
 *
 * 只做序列化。不做裁剪（那是 `flowRetention.ts`）、不做合并（那是本目录的
 * `loadAllFlowRecords`）、不判定版本是否需要迁移（本插件自己写的文件，
 * 宽容读 + 显式降级优于拒绝读——见 `flowTrackerStore.ts` 的
 * `UNKNOWN_VERSION_BEHAVIOR`）。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { atomicWriteFileSync, safeReadFileSync } from '../../shared/fs-safe.ts';
import { createScoped } from '../logger.ts';
import { EMPTY_WATERMARK } from './flowRetention.ts';
import { TRACKER_FILE, TRACKER_VERSION, UNKNOWN_VERSION_BEHAVIOR } from './flowTrackerStore.ts';
import type { EvictionWatermark, FlowRecord, FlowTrackerState } from './flowTrackerTypes.ts';

const log = createScoped('anic:flow-tracker-persist');

/** 空状态。 */
export function initialFlowTrackerState(): FlowTrackerState {
  return { flows: [], counter: 0 };
}

/**
 * 从磁盘加载状态。文件不存在或损坏时返回空状态（见文件头「向后兼容契约」）。
 *
 * ## cycle-95 接线：未知版本**真的**被警告了（此前是注释里的空承诺）
 *
 * `flowTrackerStore.ts` 的 `UNKNOWN_VERSION_BEHAVIOR` 注释写的是「返回时带上
 * `versionMismatch`，由调用方决定是否提示」—— 但**读侧从没读过 `version` 字段**，
 * 全仓也没有任何 `versionMismatch` 的消费者。也就是说：写下一条「宽容读 + 显式
 * 警告」策略常量，却没有任何代码执行这个策略 ⇒ 策略常量本身成了死导出。
 *
 * 现在它在**唯一合法的位置**被消费：`version` 与 `TRACKER_VERSION` 不符
 * （含 v1 无版本号文件，那是**已知合法**的旧格式）时 `log.warn` 一行。
 * 注意这是**警告不是拒绝** —— 拒绝会让一整个可观测性面消失（见 store 头注）。
 * v1 无版本号属于契约第 1 条「无需迁移」，故单独措辞，不与"未知版本"混为一谈。
 */
export function loadFlowTracker(cyclesDir: string): FlowTrackerState {
  const file = join(cyclesDir, TRACKER_FILE);
  const raw = safeReadFileSync(file);
  if (!raw) return initialFlowTrackerState();
  try {
    const parsed = JSON.parse(raw) as Partial<FlowTrackerState> & { version?: number };
    if (Array.isArray(parsed.flows) && typeof parsed.counter === 'number') {
      // cycle-95：执行 UNKNOWN_VERSION_BEHAVIOR（宽容读 + 显式警告）。
      if (parsed.version !== TRACKER_VERSION) {
        log.warn(`flow-tracker version ${String(parsed.version ?? 'v1(no field)')} ≠ ${String(TRACKER_VERSION)} — ${UNKNOWN_VERSION_BEHAVIOR}`);
      }
      const wm = parsed.watermark;
      // 坏形状回落 EMPTY_WATERMARK（不采信坏数据，也不伪造落点）。
      // `evictedThrough` 允许为 null（从未淘汰），所以只查键存在性 + 类型。
      const watermark: EvictionWatermark = wm !== undefined
        && (wm.evictedThrough === null || typeof wm.evictedThrough === 'string')
        && typeof wm.evictedTotal === 'number'
        ? wm
        : EMPTY_WATERMARK;
      return { flows: parsed.flows, counter: parsed.counter, watermark };
    }
  } catch { /* corrupt → reset */ }
  return initialFlowTrackerState();
}

/** 持久化状态到磁盘（原子写入；见文件头「向后兼容契约」第 3 条）。 */
export function saveFlowTracker(cyclesDir: string, state: FlowTrackerState): void {
  if (!existsSync(cyclesDir)) mkdirSync(cyclesDir, { recursive: true });
  const file = join(cyclesDir, TRACKER_FILE);
  const payload: {
    version: number;
    flows: FlowRecord[];
    counter: number;
    watermark?: EvictionWatermark;
  } = {
    version: TRACKER_VERSION,
    flows: state.flows,
    counter: state.counter,
  };
  // `watermark` 为 undefined 时不写该键 —— "从未淘汰过"的项目零 diff。
  if (state.watermark !== undefined) payload.watermark = state.watermark;
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2));
}
