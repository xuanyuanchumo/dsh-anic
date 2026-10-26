import { defineConfig } from 'vitest/config';

/**
 * dsh-anic 测试配置。vitest 本体装在本仓 node_modules（pnpm 独立工程，非父工程借用），
 * 经 scripts/run-vitest.mjs / scripts/coverage.mjs 以本 config 运行。
 *
 * 测试面（层数不在注释里写死，实际执行层以 scripts/run-tests.mjs 的 STEPS 为准）：
 *   tests/unit/       —— 纯函数与宿主路由单元（snapshotCore / snapshotRoute / apply）
 *   tests/contract/   —— DSH 规范契约守卫（源码形状 + 构建产物，含反向自检）
 *   scripts/offline-smoke.mjs —— 机制冒烟（stub 宿主，由 run-tests.mjs 编排）
 *   scripts/j0-probe.mjs      —— 真实宿主 E2E（需 start-dsh-test.mjs 环境，--live）
 *
 * coverage（cycle-79 WS-2）：`.cycles/config.yml` 的 gates.G2.coverage_threshold 长期
 * 只有声明没有测量（@vitest/coverage-v8 未安装，require.resolve 直接失败）——"声明了
 * 阈值却从不测量"是装饰性声明。此处接上真实测量面：
 *   - provider v8：与 vitest 免费集成，无额外 babel 链；
 *   - include 只含 src 下的 .ts 源码（被测面就是插件源码本身；dist/ 构建产物不计）；
 *   - reporter text-summary（人读）+ json-summary（机器读，契约测试真读 JSON）；
 *   - reportsDirectory 落**循环工件目录**，不污染仓库根（`coverage/` 不进 git）。
 * 注意：报告目录按循环滚动；**本行与 coverageEvidenceContract 的路径断言必须同轮一起改**
 * （cycle-80 已从 cycle-79 滚动到 cycle-80）——两处漂移会被契约判红。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // 隔离：每个文件独立 worker，宿主路由测试里改 process.cwd 互不影响
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: '.cycles/cycles/cycle-80/coverage',
      // all 默认 true：未被任何测试导入的源码文件也计入分母（否则"没测到"会被隐藏）
      all: true,
      // 关键：vitest 默认 reportOnFailure=false —— 测试一红就**不生成任何覆盖率报告**，
      // 证据会在最需要它的时候消失（实测：全量红 6 文件时 coverage-summary.json 完全缺失，
      // 只剩"没有证据"）。测量必须先于判定存在，故显式开启；测试失败仍由退出码传达。
      reportOnFailure: true,
      // 关键：clean 默认 true，而 clean 发生在 start()（跑测试之前）——它会把**上一轮**摘要
      // 先删掉，导致同一次 coverage 运行里的 coverageEvidenceContract 读到"文件不存在"而假红
      // （实测 3 红）。关掉后：运行期间读到的是上一次完成的测量，运行结束时被完整重写。
      // "最新鲜的数字"由 scripts/coverage.mjs 在同一次运行结束后现场判定（阈值门在脚本里），
      // 契约则守住"已落盘的证据"不被伪造/下调——两者分工，互补而不互相打架。
      clean: false,
    },
  },
});
