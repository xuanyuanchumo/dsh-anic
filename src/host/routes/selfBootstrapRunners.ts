/**
 * 自举端点的「记账 + 解析」执行体 —— **cycle-96 起本文件只做转发**。
 *
 * ## 实现已下沉到 `runtime/bootstrapTrackedRunners.ts`
 *
 * 搬迁理由（分层，不是行数）：cycle-96 起 `anic_bootstrap_other` 工具也要在
 * **目标工作区**跑一次 eval / gate-check，于是这段「跑脚本 + 记 FlowTracker + 解析三态」
 * 的纯执行逻辑多了一个**工具面**消费者。若工具继续 import 本文件，依赖方向就成了
 * `tools → routes`（反向）：路由是**装配层**、工具是**入口层**，两者都该向下依赖
 * 执行层。故实现下沉到 `runtime/`（L0）。
 *
 * ## 为什么保留这个文件而不是删掉
 *
 * `routes/selfBootstrapRoute.ts`、`routes/selfBootstrapIterate.ts` 的调用点属于
 * 别的工作流写域（本任务书禁止触碰）。删掉旧路径会让不属于本任务的代码编译失败。
 * 因此保留为**零逻辑转发**——不是兼容层（兼容层会留两套形态），这里只有一处实现：
 * `runtime/bootstrapTrackedRunners.ts`。语义、签名、返回值形状均一字未改。
 */
export {
  runEvalTracked,
  runGateTracked,
  type TrackTarget,
  type EvalTrackedResult,
  type GateTrackedResult,
} from '../runtime/bootstrapTrackedRunners.ts';
