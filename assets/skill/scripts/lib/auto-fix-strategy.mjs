// auto-fix-strategy.mjs — 自动修复循环的智能修复策略库
// 实现智能故障分类、根因分析、修复建议生成
// 核心目标：75% 超时率优化 → 通过并行化 + 预算分配 + 失败隔离

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 修复策略枚举
 */
export const FIX_STRATEGIES = {
  NONE: 'none',              // 无需修复（测试通过）
  OPTIMIZE_RETRY: 'optimize-retry',  // 优化重试（代码缺陷）
  ADJUST_BUDGET: 'adjust-budget',    // 调整预算（超时问题）
  PARALLELIZE: 'parallelize',        // 并行化（性能问题）
  ISOLATE: 'isolate',                // 隔离运行（环境依赖冲突）
  PARTIAL: 'partial',            // 部分运行（抽样执行）
  SKIP: 'skip',                // 跳过（不可评估）
  INVESTIGATE: 'investigate'     // 需人工调查
};

/**
 * 修复决策树（基于数学模型的概率论与决策树算法）
 * @param {Object} testResult - 测试结果
 * @param {Array} attempts - 历史尝试记录
 * @returns {Object} {strategy, reason, confidence, actions}
 */
export function recommendFixStrategy(testResult, attempts, configContent) {
  const strategyData = analyzeFailurePattern(attempts);

  // 1. 检测超时模式（cycle-96 WS-C C3 的核心发现）
  if (testResult.timedOut) {
    return handleTimeoutStrategy(testResult, attempts, configContent);
  }

  // 2. 检测重复失败模式（repeating failure detection）
  if (strategyData.isRepeatingFailure) {
    return handleRepeatingFailure(testResult, attempts);
  }
  
  // 3. 检测级联失败模式（cascading failure）
  if (strategyData.hasCascadingPattern) {
    return handleCascadingFailure(testResult, attempts);
  }
  
  // 4. 默认策略：单次随机失败
  return handleSingleFailure(testResult, attempts);
}

/**
 * 超时处理策略（基于概率模型的决策树）
 * @param {Object} testResult - 包含超时信息的测试结果
 * @param {Array} attempts - 历史尝试记录
 * @param {string} configContent - 配置文件内容
 * @returns {Object} 修复策略详情
 */
export function handleTimeoutStrategy(testResult, attempts, configContent) {
  const timeoutMs = testResult.timeoutMs;
  const durationMs = testResult.durationMs;
  
  // 计算预算利用率（关键指标）
  const budgetUtilization = durationMs / timeoutMs;
  
  // 决策树分支 1：是否打满预算？
  if (budgetUtilization >= 0.95) {
    // 几乎确定是预算不足
    return {
      strategy: FIX_STRATEGIES.ADJUST_BUDGET,
      reason: `命令打满 ${humanMs(timeoutMs)} 预算（实耗 ${humanMs(durationMs)}，占比 ${(budgetUtilization*100).toFixed(1)}%）`,
      confidence: 0.95,
      actions: [
        `增加 test_timeout_ms 到 ${Math.round(timeoutMs * 1.5)}ms`,
        `或缩小测试集（减少测试文件数量）`
      ],
      shouldRetry: false,  // ⚠️ 关键：超时不应重试
      recommendedTimeout: Math.round(timeoutMs * 1.5),
      parallelExecution: true  // ✅ 推荐并行化降低单任务时间
    };
  }
  
  // 决策树分支 2：多次尝试都超时？
  const timeoutAttempts = attempts.filter(a => a.timedOut);
  if (timeoutAttempts.length >= 2) {
    // 稳定超时 ⇒ 系统能力不足
    return {
      strategy: FIX_STRATEGIES.PARALLELIZE,
      reason: `连续 ${timeoutAttempts.length} 次超时，检测到系统性性能瓶颈`,
      confidence: 0.85,
      actions: [
        '启用并行测试（split tests by file/count）',
        '使用只读内存文件系统提升 IO 速度',
        '考虑分布式测试（如 GitHub Actions Matrix）'
      ],
      shouldRetry: false,
      recommendedParallelism: Math.ceil(timeoutMs / durationMs * 4),
      estimatedSpeedup: '40-60%'
    };
  }
  
  // 决策树分支 3：瞬时超时（可能是网络/IO 抖动）
  if (durationMs < timeoutMs * 0.1) {
    return {
      strategy: FIX_STRATEGIES.INVESTIGATE,
      reason: `瞬时超时仅用 ${(durationMs/timeoutMs*100).toFixed(1)}% 预算，可能为外部依赖问题`,
      confidence: 0.6,
      actions: [
        '检查网络连接稳定性',
        '验证数据库/服务可用性',
        '查看是否有 GC 停顿'
      ],
      shouldRetry: true,
      maxRetries: 2,
      retryDelayMs: 1000
    };
  }
  
  // 边界情况：中间比例超时
  return {
    strategy: FIX_STRATEGIES.INVESTIGATE,
    reason: `中等比例超时 ${(budgetUtilization*100).toFixed(1)}%，需进一步分析`,
    confidence: 0.5,
    actions: ['查看详细日志输出', '检查资源使用监控'],
    shouldRetry: true,
    maxRetries: 1
  };
}

/**
 * 重复失败处理策略
 * @param {Object} testResult - 测试结果
 * @param {Array} attempts - 历史尝试记录
 * @returns {Object} 修复策略详情
 */
export function handleRepeatingFailure(testResult, attempts) {
  const allFailures = attempts.flatMap(a => a.failures || []);
  const failureTypes = {};
  
  for (const f of allFailures) {
    const key = f.type || 'unknown';
    if (!failureTypes[key]) failureTypes[key] = [];
    failureTypes[key].push(f);
  }
  
  const mostCommonType = Object.keys(failureTypes).reduce((a, b) => 
    failureTypes[a].length > failureTypes[b].length ? a : b
  );
  
  return {
    strategy: FIX_STRATEGIES.OPTIMIZE_RETRY,
    reason: `重复失败检测：${failureTypes[mostCommonType].length} 次相同的 ${mostCommonType}`,
    confidence: 0.9,
    actions: [
      '查看失败详情（具体错误消息）',
      '检查是否相关代码已提交变更',
      '运行单一失败测试进行隔离验证'
    ],
    shouldRetry: true,
    maxRetries: 3,
    isolationRecommended: true,
    expectedSuccessRate: 0.7
  };
}

/**
 * 级联失败处理策略
 * @param {Object} testResult - 测试结果
 * @param {Array} attempts - 历史尝试记录
 * @returns {Object} 修复策略详情
 */
export function handleCascadingFailure(testResult, attempts) {
  const allFailures = attempts.flatMap(a => a.failures || []);
  
  return {
    strategy: FIX_STRATEGIES.ISOLATE,
    reason: '检测到多个不同的失败类型同时发生（级联失效）',
    confidence: 0.85,
    actions: [
      '按模块拆分测试（dependency isolation）',
      '检查最近引入的依赖变更',
      '逐步恢复测试（binary search for culprit）'
    ],
    shouldRetry: false,
    isolationSteps: [
      '识别受影响的独立测试套件',
      '逐个验证每个套件的独立性',
      '定位共享状态或外部依赖'
    ],
    expectedTimeToResolution: '~30 mins'
  };
}

/**
 * 单次失败处理策略
 * @param {Object} testResult - 测试结果
 * @param {Array} attempts - 历史尝试记录
 * @returns {Object} 修复策略详情
 */
export function handleSingleFailure(testResult, attempts) {
  return {
    strategy: FIX_STRATEGIES.NONE,
    reason: '单次失败，无明确模式',
    confidence: 0.4,
    actions: ['查看错误详情', '手动验证测试'],
    shouldRetry: true,
    maxRetries: 1,
    note: '非确定性失败，可能需要人工干预'
  };
}

/**
 * 失败模式分析器（统计学习与模式识别）
 * @param {Array} attempts - 历史尝试记录
 * @returns {Object} 统计分析结果
 */
export function analyzeFailurePattern(attempts) {
  if (attempts.length === 0) {
    return {
      isRepeatingFailure: false,
      hasMultipleFailureTypes: false,
      hasCascadingPattern: false,
      averageDuration: 0,
      avgBudgetUtilization: 0,
      failureDistribution: {}
    };
  }
  
  const allFailures = attempts.flatMap(a => a.failures || []);
  const failureTypes = {};
  const durations = [];
  const budgets = [];
  
  for (const attempt of attempts) {
    if (attempt.durationMs) durations.push(attempt.durationMs);
    if (attempt.timeoutMs && attempt.durationMs) {
      budgets.push(attempt.durationMs / attempt.timeoutMs);
    }
    
    for (const f of attempt.failures || []) {
      const key = f.type || 'unknown';
      if (!failureTypes[key]) failureTypes[key] = 0;
      failureTypes[key]++;
    }
  }
  
  const isRepeatingFailure = Object.values(failureTypes).some(count => count >= 3);
  const hasMultipleFailureTypes = Object.keys(failureTypes).length > 1;
  const hasCascadingPattern = hasMultipleFailureTypes && Object.values(failureTypes).some(count => count >= 2);
  
  return {
    isRepeatingFailure,
    hasMultipleFailureTypes,
    hasCascadingPattern,
    averageDuration: durations.reduce((a, b) => a + b, 0) / durations.length || 0,
    avgBudgetUtilization: budgets.reduce((a, b) => a + b, 0) / budgets.length || 0,
    failureDistribution: failureTypes,
    totalAttempts: attempts.length
  };
}

/**
 * 智能预算分配器（基于历史数据的贝叶斯推断）
 * @param {number} currentBudgetMs - 当前预算
 * @param {Array} history - 历史执行记录
 * @returns {Object} {recommendedMs, justification, confidenceInterval}
 */
export function recommendOptimalBudget(currentBudgetMs, history) {
  if (history.length === 0) {
    return {
      recommendedMs: currentBudgetMs,
      justification: '无历史数据，使用当前预算',
      confidenceInterval: null
    };
  }
  
  const successfulRuns = history.filter(h => h.success);
  if (successfulRuns.length === 0) {
    // 全部失败 ⇒ 需要大幅增加预算
    const worstDuration = Math.max(...history.map(h => h.durationMs));
    return {
      recommendedMs: Math.round(worstDuration * 1.5),
      justification: `所有运行都失败，最慢用时 ${humanMs(worstDuration)}`,
      confidenceInterval: [worstDuration, worstDuration * 2]
    };
  }
  
  const durations = successfulRuns.map(h => h.durationMs);
  const p95Duration = percentile(durations, 95);
  const meanDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  
  // 贝叶斯更新：后验期望 = 加权平均
  const weight = 0.7; // 新数据权重
  const recommended = Math.round(weight * p95Duration + (1 - weight) * meanDuration * 1.3);
  
  return {
    recommendedMs: recommended,
    justification: `P95 延迟 ${humanMs(p95Duration)}，平均值 ${humanMs(meanDuration)}`,
    confidenceInterval: [p95Duration * 0.8, p95Duration * 1.2],
    suggestion: '建议使用 P95 + 30% 安全边际'
  };
}

/**
 * 并行度推荐器（基于 Amdahl 定律的计算）
 * @param {Object} testConfig - 测试配置
 * @param {Array} fileCounts - 各测试文件大小分布
 * @returns {Object} {optimalThreads, expectedSpeedup, diminishingReturnsAt}
 */
export function recommendParallelism(testConfig, fileCounts) {
  if (!fileCounts || fileCounts.length === 0) {
    return { optimalThreads: 1, expectedSpeedup: 1.0, diminishingReturnsAt: 1 };
  }
  
  const totalTime = fileCounts.reduce((a, b) => a + b.time, 0);
  const serialPortion = fileCounts.some(f => f.dependencies?.length > 0) ? 0.2 : 0.05; // 估算串行比例
  
  // Amdahl's Law: Speedup = 1 / (S + (1-S)/P)
  const speeds = [];
  for (let threads = 1; threads <= 8; threads++) {
    const theoreticalSpeedup = 1 / (serialPortion + (1 - serialPortion) / threads);
    const actualSpeedup = calculateActualSpeedup(fileCounts, threads);
    speeds.push({ threads, theoreticalSpeedup, actualSpeedup });
  }
  
  const optimal = findDiminishingReturns(speeds);
  
  return {
    optimalThreads: optimal.threads,
    expectedSpeedup: Math.round(optimal.actualSpeedup * 100) / 100,
    diminishingReturnsAt: optimal.threads + 1,
    recommendation: `建议 ${optimal.threads} 线程（超过后收益递减）`
  };
}

// 辅助函数

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function calculateActualSpeedup(fileCounts, threads) {
  // 简化模型：假设可完美并行化
  const totalFiles = fileCounts.length;
  const filesPerThread = Math.ceil(totalFiles / threads);
  const maxThreadTime = Math.max(
    ...Array.from({ length: threads }, (_, i) => {
      const start = i * filesPerThread;
      const end = Math.min(start + filesPerThread, totalFiles);
      return fileCounts.slice(start, end).reduce((a, b) => a + b.time, 0);
    })
  );
  return totalTime / maxThreadTime;
}

function findDiminishingReturns(speeds) {
  let best = speeds[0];
  let bestMarginalGain = 0;
  
  for (const s of speeds) {
    const marginalGain = s.actualSpeedup - best.actualSpeedup;
    if (marginalGain > bestMarginalGain * 0.5) {
      best = s;
      bestMarginalGain = marginalGain;
    }
  }
  
  return best;
}

export function humanMs(ms) {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return n >= 1000 ? `${Math.round(n / 1000)}s` : `${Math.round(n)}ms`;
}
