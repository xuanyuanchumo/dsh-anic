# GitHub Actions 编写面（actions-authoring）

> 归属：`ci-cd-release` 叶技能的参考文件（cycle-108）。所有结论以**本仓两份真实工作流**为锚：
> `.github/workflows/ci.yml`、`.github/workflows/release.yml`。
> 本文件讲"怎么写对"，`operations.md` 讲"发布流程怎么走"，`troubleshooting.md` 讲"红了怎么查"。

## 1. 触发面（on）

| 形态 | 写法 | 本仓决策 |
|---|---|---|
| 分支 push | `push.branches: [master, 'feat/**', 'fix/**', 'chore/**']` | ✅ ci.yml 用（功能分支也跑，主干保护靠 PR 门而非触发面） |
| PR | `pull_request.branches: [master]` | ✅ ci.yml 用 |
| tag | `push.tags: ['v*']` | ✅ release.yml 用（**只认 vX.Y.Z**，与 CHANGELOG 版本段一一对应） |
| 手工 | `workflow_dispatch.inputs.<name>` | ✅ release.yml 用（重跑失败发布，必须显式给 tag） |

**纪律**：`workflow_dispatch` 的输入必须**必填**（`required: true`）并做形状校验——
`release.yml` 用 `TAG = event_name == 'workflow_dispatch' && inputs.tag || ref_name`，
再由「Verify tag matches package.json version」步骤硬校验；不匹配直接红，不猜。

## 2. 并发（concurrency）——省配额与防撞车

```yaml
# CI：同一 ref 的新 push 取消旧运行（旧结论已被新提交作废）
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

# Release：绝不取消（发布是原子动作，取消可能留下半发布状态）
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

**判据**：只读校验用 `cancel-in-progress: true`；任何**写发布物/写 registry** 的作业必须 `false`。

## 3. 权限（permissions）——最小化

```yaml
# 默认只读（显式声明，防仓库级默认被放宽）
permissions:
  contents: read

# 发布作业才提权，且逐条说明用途
permissions:
  contents: write   # gh release create
  id-token: write   # npm publish --provenance（OIDC；未配 NPM_TOKEN 时该步不执行）
```

**纪律**：`id-token: write` 只在需要 provenance 的作业上开；普通 CI 作业**不要**开。

## 4. 依赖与缓存

```yaml
- uses: pnpm/action-setup@v4
  with: { version: 11 }          # 与本地大版本一致；pnpm 专属设置在 pnpm-workspace.yaml
- uses: actions/setup-node@v4
  with:
    node-version: '22'           # engines.node >=22.19
    cache: 'pnpm'                # 缓存键 = lockfile 哈希（自动）
- run: pnpm install --frozen-lockfile
```

- `--frozen-lockfile` 是硬纪律：CI 不许改锁文件（否则"CI 绿"证明的不是提交的依赖树）。
- `autoInstallPeers=false` 写在 `pnpm-workspace.yaml`，**不要**在 CI 改成 true——
  会把整棵宿主 peer 树（~824 包）拖进来。
- matrix 只在真有维度时用（node 22/24 双跑）；本仓单版本，**不用 matrix 造仪式感**。

## 5. 作业内顺序（本仓实测踩坑后的定序）

`.github/workflows/ci.yml` 的 `verify` 作业顺序：

```
checkout → pnpm → node → install
→ Build            ← 必须早于 lint/test：lint 检查 dist 存在性；smoke 直接读 dist
→ Typecheck
→ Lint
→ Seed（init-cycle → gate-ledger ×4 → coverage → snapshot → 再 Build → 产物占位）
→ Test（四层离线金字塔）
→ Upload artifacts
```

三条**非直觉**结论（每条都有真实红线历史）：

1. **Build 必须最早**：`validate-dsh.mjs` 检查 `dist/client.js`/`dist/host.js` 的存在与形状；
   smoke 层 `readFileSync(dist/client.js)`。`dist/` 在 `.gitignore` 里，CI 必须自己构建。
2. **播种（seed）必须在 Test 之前，且顺序敏感**：`coverage.mjs` 读 `.cycles/config.yml`，
   而 `.cycles/` 被 gitignore ⇒ **`init-cycle` 必须先跑**（否则 coverage 0.4s 退出 2）；
   账本四门锚点必须在 coverage **之前**落（`gateToolMappingContract` 要求账本非空时含 G0-G3 全集）。
3. **播种后要再 Build 一次**：`generate-snapshot` 重写了嵌入快照，而 dist 是更早打的；
   smoke 断言「dist 渲染 == artifacts 快照」同源 ⇒ 不重建就红。

## 6. 环境变量与自审计开关

`ANIC_SELF_AUDIT=0` 必须是 **job 级 `env`**，不能只设在 Test 步骤上——
`coverage.mjs` 内部会再起一次 vitest；只设在步骤上时，coverage 那次拿不到开关照样红
（真机实录：coverage 3s 非零退出）。

## 7. 产物与证据（artifacts）

```yaml
- uses: actions/upload-artifact@v4
  if: always()                     # 失败也要上传（失败诊断靠它）
  with:
    name: test-reports
    path: |
      .cycles/cycles/*/test-reports/
      test-results/
    if-no-files-found: warn        # 缺失要可见但不阻塞（由契约层判红）
    retention-days: 14
```

**纪律**：`.cycles/` 被 gitignore ⇒ 测试报告只有显式上传才可下载；`if: always()` 不可省。

## 8. 可复用工作流与组合

- `workflow_call` 适合**多仓共用**的发布骨架；本仓单仓自足，**不抽**（抽象层没有第二个消费者时
  只会把 YAML 变成两次跳转）。
- 若将来抽：把 `inputs` 全部显式化（tag/registry/provenance），**禁止**在 reusable workflow 里
  读调用方的 secrets 名（只能在 `jobs.<id>.secrets` 显式传入）。

## 9. Action 版本钉法

| 形态 | 评价 |
|---|---|
| `uses: actions/checkout@v4` | ✅ 本仓采用（官方仓库大版本标签，GitHub 维护） |
| `uses: actions/checkout@<40 位 SHA>` | 更严格（防 tag 被移动）；第三方 action **必须**用这种 |
| `uses: some-user/some-action@v1` | ❌ 第三方用浮动 tag = 供应链风险 |

**判据**：官方 `actions/*` 与 `pnpm/action-setup` 可接受大版本标签；**任何第三方**必须
钉 SHA 并在相邻注释写"为什么需要它"。

## 10. 发布产物的稳定名（marketplace 依赖）

`pnpm pack` 产出带版本号的 `dsh-anic-0.58.0.tgz`，而 marketplace 的 `tarball:` 字段必须
**长期不变** ⇒ 发布作业把它 `cp` 成稳定名 `dsh-anic.tgz` 并 `sha256sum` 一并上传：

```sh
rm -rf .pack && mkdir -p .pack
pnpm pack --pack-destination .pack
cp "$(ls .pack/*.tgz | head -1)" dsh-anic.tgz
sha256sum dsh-anic.tgz | tee dsh-anic.tgz.sha256
gh release create "$TAG" --verify-tag --notes-file release-notes.md dsh-anic.tgz dsh-anic.tgz.sha256
```

`--verify-tag` 防"本地有 tag、远端没有"的假发布；`gh release delete … || true` 让**重跑**不撞车
（`--cleanup-tag=false` 保住 tag）。

## 11. 可选步骤的正确形态

npm 发布在 `release.yml` 里是**可选**的：`if: env.NPM_TOKEN != ''`。
未配 secret ⇒ 显式 skip 并打一行说明，**不算失败**。反面形态（常见错误）：
把 publish 设成 `continue-on-error: true` —— 那会把"真的发失败"也吞成绿。

## 12. 自检清单（改完 workflow 必跑）

```sh
node assets/skills/ci-cd-release/scripts/workflow-lint.mjs <workspace>   # 结构校验
node assets/skills/ci-cd-release/scripts/release-check.mjs <workspace>   # 发布四件套卫生
```

逐条人工确认（脚本查不到语义的项）：

- [ ] 新增 `run:` 的**失败面**明确（非零即红，还是 `|| true` 有理由）
- [ ] 新增 `secrets.*` 只出现在需要它的作业里
- [ ] 新增 `actions/*` 版本与仓库既有风格一致
- [ ] 改了测试/构建命令 ⇒ 同步 `.cycles/config.yml` 的 `build.*`（双真相源）
- [ ] 改了工具/路由数字 ⇒ 同步 README + 市场条目 yml（**两份都无自动守卫**，见 doc 26 §3 B4）