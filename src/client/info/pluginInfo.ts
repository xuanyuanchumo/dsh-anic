/**
 * 插件信息（cycle-111 · PluginInfoPanel 数据面）—— 构建期生成的**纯静态常量**。
 *
 * ## 为什么是生成文件（committed，不 gitignore）
 *
 * package.json 是版本号的唯一事实源。客户端 bundle 无法直接读 package.json
 * （打包边界：tsdown 不内联 JSON import 进 CJS 产物的可靠形态依赖宿主解析），
 * 所以构建脚本（`scripts/build-plugin-info.mjs`）读 package.json 生成此模块。
 * 生成物**入库**：① typecheck/契约测试/沙箱冒烟不依赖构建脚本先跑（测试即
 * 编译，生成文件缺席会假红）；② 版本同步测试对比生成物与 package.json，
 * 漂移即红（跑 `pnpm run build` 会顺手重新生成）。
 *
 * ## 改动纪律
 *
 * 本文件**只由脚本生成**，手工编辑会被下次构建覆盖——要改字段形状改
 * `scripts/build-plugin-info.mjs` 的模板，要改版本号改 package.json。
 */

/** 插件静态信息（构建期单一事实源投影；形状见 buildPluginInfo）。 */
export interface PluginInfo {
  /** 插件名（package.json name）。 */
  name: string;
  /** 插件版本（package.json version——发版三锚同步：package.json / CHANGELOG / dist）。 */
  version: string;
  /** 仓库主页（反馈入口跳转目标族）。 */
  homepage: string;
  /** 仓库 URL（API 形态 https，浏览器可直达）。 */
  repository: string;
  /** Issue 反馈入口。 */
  issues: string;
  /** npm 包页。 */
  npm: string;
  /** 文档根（仓库内 docs/anic/ 在 GitHub 的路径）。 */
  docs: string;
  /** 构建时间戳（ISO；锚定 package.json mtime——源变化才前进，保证生成器幂等）。 */
  builtAt: string;
}

export const PLUGIN_INFO: PluginInfo = {
  "name": "dsh-anic",
  "version": "0.61.0",
  "homepage": "https://github.com/xuanyuanchumo/dsh-anic#readme", // anic-url-data（跳转目标，非 fetch）
  "repository": "https://github.com/xuanyuanchumo/dsh-anic", // anic-url-data（跳转目标，非 fetch）
  "issues": "https://github.com/xuanyuanchumo/dsh-anic/issues", // anic-url-data（跳转目标，非 fetch）
  "npm": "https://www.npmjs.com/package/dsh-anic", // anic-url-data（跳转目标，非 fetch）
  "docs": "https://github.com/xuanyuanchumo/dsh-anic/tree/main/docs/anic", // anic-url-data（跳转目标，非 fetch）
  "builtAt": "2026-11-07T06:46:55.137Z"
};
