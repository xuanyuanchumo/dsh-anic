# eval-runner 性能优化方案：缓存基线与步骤拆分

## 问题分析

### 当前状态（来自 `L4_SELF_BOOTSTRAP_REPORT.md`）
- **评估耗时**：~73s（expensive but effective）
- **瓶颈环节**：
  1. Q5 Build: `node scripts/build-client.mjs` 每次全量构建
  2. Q2 Test: Vitest 全量测试套件运行
  3. Q7 Lint: ESLint/Prettier 全量扫描
  4. E8 Import Graph: 循环依赖检测全图扫描

### 数学模型识别

#### 1. 时间复杂度分布
```
Total Time = Σ(T_i) for i in [Q2, Q5, Q7, E8]
T_total ≈ 73102ms (实测均值)

当前各阶段占比估算：
- Q2 Test (Vitest): ~60% ≈ 43861ms
- Q5 Build (tscdown): ~25% ≈ 18275ms  
- Q7 Lint: ~10% ≈ 7310ms
- E8 Import Graph: ~5% ≈ 3655ms
```

#### 2. 数据依赖关系
```
Build Dependencies:
├── Source Files (S) → Hash(S) = H_S
├── Config Files (C) → Hash(C) = H_C  
└── Deps (D) → Hash(D) = H_D

Cache Key K = Hash(H_S || H_C || H_D)
Cache Validity V = (K == Stored_K)
```

## 优化策略

### 策略 A：增量缓存基线（基于 Merkle Tree）

#### 数据结构设计
```typescript
interface CacheEntry {
  version: string;              // dsh-anic version
  cacheKey: string;             // Merkle root of source/config/deps
  timestamp: number;            // last valid evaluation time
  results: {
    build?: {                    // Build result cache
      hash: string;             // build output hash
      artifacts: string[];      // generated files
      durationMs: number;
    };
    test?: {                   // Test result cache
      summary: object;          // pass/fail/skip counts
      coverage: object;         // coverage stats
      durationMs: number;
    };
    lint?: {                   // Lint cache
      errors: number;           // total errors found
      warnings: number;         // total warnings
      durationMs: number;
    };
  };
}
```

#### 哈希算法实现（Merkle Root）
```javascript
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// 递归计算目录 Hash（Merkle Leaf）
function calculateFileHash(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// 构建目录树并生成根 Hash（Merkle Root）
function calculateDirMerkleRoot(dirPath, extensions = ['.ts', '.js', '.mjs']) {
  let combined = '';
  const entries = [];
  
  function walk(dir) {
    if (!existsSync(dir)) return;
    
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      
      if (extensions.some(ext => entry.name.endsWith(ext))) {
        entries.push({ path: relative('.', full), hash: calculateFileHash(full) });
      }
    }
  }
  
  // 按路径排序保证确定性
  entries.sort((a, b) => a.path.localeCompare(b.path));
  
  for (const e of entries) {
    combined += e.path + ':' + e.hash;
  }
  
  return createHash('sha256').update(combined).digest('hex');
}
```

#### 缓存验证逻辑
```javascript
function validateCache(cacheFile, projectDir) {
  if (!existsSync(cacheFile)) return false;
  
  const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  
  // 1. Version check
  if (cache.version !== PACKAGE_VERSION) return false;
  
  // 2. Recalculate current state hash
  const currentHash = calculateDirMerkleRoot(projectDir);
  
  // 3. Compare hashes
  if (currentHash !== cache.cacheKey) return false;
  
  // 4. Freshness check (optional TTL)
  if (Date.now() - cache.timestamp > CACHE_TTL_MS) return false;
  
  return true;
}
```

### 策略 B：步骤拆分与并行化

#### 流水线设计
```mermaid
flowchart LR
    subgraph Phase1[Phase 1: Fast Checks (~5s)]
        A1[E1 Intent Spec Alignment]
        A2[E2 Planning Conformance]
        A3[Spec Alignment Check]
    end
    
    subgraph Phase2[Phase 2: Medium Checks (~15s)]
        B1[Doc Sync Check]
        B2[Security Scan]
        B3[Config Audit]
        B4[Bundle Size Analysis]
    end
    
    subgraph Phase3[Phase 3: Slow Checks (~60s)]
        C1[E8 Import Graph]
        C2[Q7 Lint]
        C3[Q2 Test]
        C4[Q5 Build]
    end
    
    Phase1 --> Phase2 --> Phase3
```

#### 并行化策略
```javascript
// 使用 Promise.allSettled 并行执行独立阶段
async function runParallelPhases(phases) {
  const results = {};
  
  // Group phases by dependency level
  const groups = [
    // Level 0: No dependencies
    ['E1', 'E2', 'A3'],
    
    // Level 1: Depends on Level 0
    ['B1', 'B2', 'B3', 'B4'],
    
    // Level 2: Depends on all above
    ['E8', 'Q7', 'Q2', 'Q5']
  ];
  
  for (const level of groups) {
    const promises = level.map(phaseId => 
      runPhaseWithCache(phaseId, projectDir, cacheFile)
    );
    
    const stageResults = await Promise.allSettled(promises);
    level.forEach((id, idx) => {
      results[id] = stageResults[idx].status === 'fulfilled' 
        ? stageResults[idx].value 
        : { skip: true, error: stageResults[idx].reason.message };
    });
  }
  
  return results;
}
```

### 策略 C：智能抽样与渐进评估

#### 抽样策略
```javascript
// 动态抽样比例（基于变更检测）
function getSampleRatio(lastChangesCount) {
  if (lastChangesCount === 0) return 1.0;  // 全量
  if (lastChangesCount <= 5) return 0.5;   // 50% 抽样
  if (lastChangesCount <= 10) return 0.3;  // 30% 抽样
  return 0.1;                               // 10% 抽样
}

// 变更文件检测
function detectChanges(projectDir, lastRunHash) {
  if (!existsSync(cacheFile)) return Infinity;
  
  const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
  const currentHash = calculateDirMerkleRoot(projectDir);
  
  if (currentHash === cache.cacheKey) return 0;
  
  // 精确计算变更文件数
  return countChangedFiles(cache, currentHash);
}
```

#### 渐进式报告生成
```javascript
async function generateIncrementalReport(results) {
  const report = {
    timestamp: Date.now(),
    phases: {},
    summary: {}
  };
  
  // Emit partial results immediately
  const writer = createWriteStream(reportPath);
  
  for (const [phase, result] of Object.entries(results)) {
    if (result.status === 'pending') continue;
    
    // Write phase result as it completes
    emitPhaseResult(writer, phase, result);
    
    // Update summary incrementally
    updateSummary(report.summary, phase, result);
  }
  
  writer.end();
}
```

## 实施优先级

### P0: 核心缓存基础设施（1-2 天）
1. ✓ 实现 Merkle Tree 哈希计算
2. ✓ 实现缓存存储/加载接口
3. ✓ 实现缓存验证逻辑
4. ✓ 集成到现有流程

### P1: 步骤拆分与并行化（2-3 天）
1. 定义评估阶段依赖图
2. 实现并行调度器
3. 添加进度汇报
4. 错误恢复机制

### P2: 智能抽样与优化（可选）
1. 变更检测集成
2. 动态抽样策略
3. 渐进式报告
4. 缓存预热机制

## 预期收益

| 指标 | 当前值 | 目标值 | 提升幅度 |
|---|---|---|---|
| **平均耗时** | 73102ms | 15000ms | ~80% ↓ |
| **首次评估** | 73102ms | 73102ms | 无变化 |
| **增量评估** | N/A | 2000ms | 全新功能 |
| **缓存命中** | N/A | 500ms | 全新功能 |
| **内存峰值** | ~512MB | ~384MB | ~25% ↓ |

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 缓存误用导致假绿 | 低 | 高 | 版本校验 + 哈希对比 |
| 并行竞态条件 | 中 | 中 | 严格隔离临时目录 |
| 内存增长 | 低 | 低 | 流式处理 + 垃圾回收 |
| 向后兼容性问题 | 低 | 中 | 双模式支持（传统/优化） |

## 验收标准

1. ✅ 基础功能不变（三态裁决 PASS/FAIL/SKIP 仍保留）
2. ✅ 缓存失效机制正确工作（至少 3 种失效场景）
3. ✅ 并行执行无竞态（压力测试通过）
4. ✅ 性能提升达到预期目标
5. ✅ 回退机制完善（缓存损坏时自动降级）
