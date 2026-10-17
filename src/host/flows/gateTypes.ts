/**
 * gateEngine / gateArtifacts 的共享类型（L0）。单列一文件避免解析器与引擎互相 import。
 */

/** 任务表行（parseTaskRows 的返回；末列是状态）。 */
export type TaskRow = string[];

/** G2 测试汇总（recognized=false = 格式不可识别 = 无证据 = FAIL）。 */
export interface TestSummary {
  recognized: boolean;
  failures: number;
  errors: number;
}

/** 质量行三态；null = 行缺失（unevaluated）。 */
export type QualityRow = 'PASS' | 'FAIL' | 'SKIP' | null;

/** 单门判定（与技能 gate-check.mjs 的 {pass, detail} 同构）。 */
export interface GateCheckResult {
  pass: boolean;
  detail: string;
}

/** 原生门禁总结果（native 模式输出；script 模式解析出的对照面同构）。 */
export interface NativeGateResult {
  gates: Record<string, GateCheckResult>;
  quality: Record<string, GateCheckResult>;
  allPass: boolean;
  /** 与脚本 exit code 语义对齐：全过 0，有失败 1，配置缺失 1。 */
  exitCode: 0 | 1;
  /** 配置缺失等致命错误（脚本侧在门禁前 exit(1) 的路径）。 */
  fatal?: string;
}
