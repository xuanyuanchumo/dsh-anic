/**
 * 拆卸隔离（cycle-89 T-12）—— **一个 disposer 抛错不得阻断其余**。
 *
 * ## 被守卫的缺陷（实测，非推断）
 *
 * `src/host/routes/index.ts` 与 `src/host/tools.ts` 此前都是：
 *
 * ```ts
 * return () => { for (const d of cleanups) d(); };
 * ```
 *
 * `for` 循环里任一 `d()` 抛错，**后续 disposer 一个都不会执行**。后果在插件
 * 热重载场景下是致命的：上一轮注册的路由/工具**留在宿主里没注销**，新一轮又
 * 注册一份 → 同路径双注册、旧工具仍可被调用、状态机投影读到陈旧实现。
 *
 * 更隐蔽的次生伤害：这些 disposer 里包着 `ctx.effect(() => () => service.dispose())`
 * 形态的**能力撤销**。一个抛错就意味着**该撤销的权限没撤销** —— 能力守卫会
 * 半途卡死，后续整条链路跟着冻结。
 *
 * ## 纪律（照搬 dsh-ops 的 `safeDisposeAll` 语义）
 *
 * 1. **先快照再遍历**：`Map.values()` / `Set` 的迭代器在遍历中修改会跳项，
 *    所以先 `[...cleanups]` 拍平快照。
 * 2. **错误隔离**：每个 disposer 独立 try/catch，抛错只记录，**不中断**其余。
 * 3. **错误 sink 自身抛错也要吞**：连"记录失败"都失败时，不能让整段爆炸。
 * 4. **返回失败数**：调用方可以据此上报，但**不因此放弃其余 disposer**。
 *
 * ## 为什么不能吞掉错误
 *
 * 拆卸失败必须**可观测**（记进 scoped logger），否则「插件没卸载干净」这件事
 * 就彻底静默了 —— 而静默的残留比显式的报错更难查。这里选「记录并继续」，
 * 而不是「记录并抛出」：抛出会让最后一个失败者盖掉前面所有失败者，
 * 反而丢掉大部分信息。
 */
import { createScoped } from '../logger.ts';

/** 拆卸失败的单条记录。 */
export interface DisposeFailure {
  /** disposer 在清理面里的序号（便于定位是哪一个）。 */
  index: number;
  /** 错误消息。 */
  message: string;
}

/** 拆卸结果：成功数 + 失败明细。 */
export interface DisposeReport {
  /** 尝试拆卸的 disposer 数量。 */
  total: number;
  /** 成功数。 */
  ok: number;
  /** 失败明细（每条含序号与消息）。 */
  failures: DisposeFailure[];
}

/**
 * 依次执行所有 disposer，**单个失败不阻断其余**。
 *
 * @param cleanups 待执行的 disposer（可能是 null —— 调用方常有「注册失败返回 null」的形态）
 * @param onError 失败回调；**它自己抛错也不会影响后续 disposer**
 * @param label 标签（进日志，便于定位是路由面还是工具面）
 */
export function safeDisposeAll(
  cleanups: ReadonlyArray<(() => void) | null | undefined>,
  onError: (failure: DisposeFailure) => void,
  label: string,
): DisposeReport {
  // 先拍平快照：遍历期间修改集合会导致漏项。
  const list = [...cleanups].filter((d): d is () => void => typeof d === 'function');
  const failures: DisposeFailure[] = [];
  let ok = 0;
  for (let i = 0; i < list.length; i += 1) {
    const d = list[i];
    if (d === undefined) continue;
    try {
      d();
      ok += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({ index: i, message });
      try {
        onError({ index: i, message });
      } catch {
        // 错误 sink 自身抛错：吞掉。理由见文件头「错误 sink 自身抛错也要吞」。
      }
    }
  }
  if (failures.length > 0) {
    try {
      const log = createScoped('anic.teardown');
      log.warn(`${label}: ${String(failures.length)}/${String(list.length)} 个 disposer 失败（其余已正常执行）`);
    } catch {
      // logger 不可用（宿主未就绪）→ 静默，但失败数已在返回值里。
    }
  }
  return { total: list.length, ok, failures };
}

/**
 * 为「已知标签的清理面」建立默认错误回调（写 scoped 日志）。
 *
 * 单独成函数而不是让每个调用点各写一遍：日志口径统一，且调用点不必 import logger。
 */
export function disposeErrorSink(label: string): (failure: DisposeFailure) => void {
  return (failure: DisposeFailure): void => {
    try {
      const log = createScoped('anic.teardown');
      log.warn(`${label}: disposer #${String(failure.index)} 失败：${failure.message}`);
    } catch {
      // logger 不可用 → 静默（失败数已在返回值里）。
    }
  };
}
