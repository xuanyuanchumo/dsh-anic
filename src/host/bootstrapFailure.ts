/**
 * 自举失败根因（cycle-72 P0-BOOTSTRAP-NO-ROOTCAUSE）。
 *
 * 被守卫缺陷：EXHAUSTED 与 CONVERGED 可区分了，但「为什么没收敛」在磁盘上不可见——
 * 只能靠外侧读 gate-check 的 stdout/stderr 才能拼出（真机实例：Q5 循环依赖误判 →
 * G0-Quality FAIL；随后 auto-fix-report.md 顶替正典报告 → G2 FAIL）。调用方（网关/面板/
 * 大模型）因此只能看到一个裸的 evalScore 0 / FAIL，语义上像「质量差」而不是「有具体门禁理由」。
 *
 * 拆分为独立模块的原因（T3 250 行纪律）：selfBootstrap.ts 加入本域后越界。放在 src/host/ 根
 * 而非 src/host/runtime/ 是**有意为之**——runtime 下的编排器 import 本文件的上层
 *（../selfBootstrap.ts），若本文件也 import runtime 就会构成真实运行时环（Q5 会判 FAIL）。
 * 本模块零依赖、零副作用，谁都可以安全引用。
 */

export interface BootstrapFailure {
  round: number;
  evalScore: number;
  gateVerdict: string;
  /** 门禁输出的失败行（原样摘录，已去重截断；空数组 = 脚本未给出可识别理由）。 */
  reasons: string[];
  timestamp: string;
}

/** 失败行的字符上限（单行）与条数上限——根因要可读，不能把整份日志塞进状态文件。 */
const MAX_REASON_CHARS = 300;
const MAX_REASONS = 10;

/**
 * 从一次脚本结果里提取**失败理由行**（原样摘录，去重、截断、有界）。
 *
 * 只认脚本自己打印的失败行（『[FAIL] ...』与『N dimension(s) failed: ...』），
 * 不做语义推断：拿不到理由就返回空数组（诚实为空），绝不编造。
 */
export function extractFailureReasons(result: { stdout: string; stderr: string } | undefined): string[] {
  if (!result) return [];
  const lines = (result.stderr + String.fromCharCode(10) + result.stdout).split(String.fromCharCode(10));
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const isFailLine = line.startsWith('[FAIL]') || /dimension\(s\) failed:/.test(line);
    if (!isFailLine) continue;
    const clipped = line.length > MAX_REASON_CHARS ? line.slice(0, MAX_REASON_CHARS) + '...' : line;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    picked.push(clipped);
    if (picked.length >= MAX_REASONS) break;
  }
  return picked;
}

/** 失败理由是否为空（调用方据此如实区分「有理由」与「脚本没给理由」）。 */
export function hasFailureReasons(failure: BootstrapFailure | undefined): boolean {
  return !!failure && failure.reasons.length > 0;
}
