# superagent-patterns · 故障排查

> 失败模式 → 根因 → 修复。每条都标注证据出处（研究报告 `§N Ln`）。
> ⚠️ Superagent 事实来自外部研究报告 `.cycles/research-inputs/A-dsh-superagent-study.md`，
> **非 dsh-anic 本地源码**。

## 1. 退出码错判：把 exit 2 当成功

**症状**：部件报错却被判为正常，或反过来。

**根因**：四类退出码语义混淆。

**修复**：严格按语义处置——

| 退出码 | 语义 | 处置 |
|---|---|---|
| 0 | 正常 | 静默 |
| 1 | 不运行 / 运行两次 / runtime 报错 | `--respect-stop restart`（重启可能修好） |
| 2 | 运行但某部件报错 | **只报告 errors，不重启**（重启修不好） |
| 3 | 运行但等 setup | **只报告 setup，不重启** |

证据：§8 L214-215。

## 2. hourly check 建错了 profile

**症状**：每小时 check 不生效，或把工作 profile 拖入重启。

**根因**：hourly check **必须建在日常使用的 profile（不是 superagent）**。

**修复**：在日常 profile 上用 schedule 每小时跑 `scripts/dsh-superagent --profile superagent status`；
`manually_stopped: true` 时保持停止；只有 `stop` 写 marker、`start` 清 marker、`restart` 不写。

证据：§8 L215。

## 3. profile 混用导致进程级副作用

**症状**：插件改了进程级 PATH 与 git 设置，工作 profile 受影响。

**根因**：superagent 与工作 profile 没有分开。

**修复**：`superagent` 必须是独立 profile，从 DSH Web profile 模板创建，服务面板于 `127.0.0.1`；
需要独立重启/升级。

证据：§8 L210。

## 4. `stateDir` 被面板改动

**症状**：改了面板上的 `stateDir` 不生效或报错。

**根因**：`stateDir` 不可经面板改（是唯一必填且不可变）。

**修复**：直接改 `examples/profile.cordis.patch.yml` 的 `config.stateDir`；`promptMaxChars` 等
volatile 字段才可面板改。

证据：§8 L212-213。

## 5. 准入表错配：未点名格在不该用时被用

**症状**：不点名的群消息被当作 inferred 候选。

**根因**：**未点名格只在该 scope 接收全部消息时可用**；CI 无发送者只有最后一格。

**修复**：逐行核对准入表；默认 `inferred`/`ignore`/`ignore`；CI 行只保留最后一格。
表格属于 Policy version，削弱一格不会立刻停掉已存在的 Ticket，只会在恢复前 revalidate 时 revoke。

证据：§3 L52。

## 6. Mandate 被错误撤销 / 沿用

**症状**：Ticket 莫名结束，或旧授权被沿用到新任务。

**根因**：只有三种操作改变 Mandate（accept 创建、人的 stop 撤回、失败 revalidate revoke）；
恢复前必须 revalidate。

**修复**：
- explicit follow-up Mandate 直接通过；
- inferred Mandate 需要 `auto` + 命中规则仍启用；
- admission cell 授予的 Mandate 需今天的表格至少给出原强度（把人移出名单会 revoke 通过
  listed-sender cell 授予的 Mandate）；
- bot Mandate 需 bot 仍在 list；
- 失败则 Ticket 保持 ended、不取等待消息、attach 被拒。

证据：§3 L60-61。

## 7. Management API 被非本机调用

**症状**：面板请求被 403。

**根因**：`sameOrigin()` 要求 `host` 是 `127.0.0.1:<port>` 或 `localhost:<port>`、带
`x-orchestrator-request: 1`、`Origin` 同源。

**修复**：确认面板与 host 同源；只接受 `/orchestrator/api/*`；请求体上限 128KB。

证据：§7 L200。

## 8. setup 探测泄露了敏感环境变量

**症状**：setup 把含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的环境变量带进了执行环境。

**根因**：setup 未剥离敏感环境变量。

**修复**：setup 用 DSH subprocess 服务跑 CLI 探测时，**移除名字含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN`
的环境变量**；Feishu 失败只禁用 Feishu Source。

证据：§8 L218。

## 9. 升级后旧版本打不开新库

**症状**：升级后回滚，报数据库打不开。

**根因**：**新库不能被旧版本打开**，回滚需要升级前备份。

**修复**：升级前**先备份 `<stateDir>/orchestrator.sqlite`**；升级 DSH 后重启实例以加载匹配 artifacts；
回滚用升级前的备份。

证据：§8 L216。

## 10. agent preset 缺失

**症状**：Executor Session 起不来，或工具集不符合预期。

**根因**：`cordis.patch.yml` 缺少 `dsh-superagent-worker` / `dsh-superagent-router` 两个 preset
（order 90/91）。

**修复**：补上两个 `@deepseek-ai/dsh-agent-preset` 定义；worker preset 含工作所需工具 +
前台 shell 5 秒转后台 job；router preset 工具集更小。

证据：§5 L96。

## 11. 失败时工具被锁死

**症状**：Ticket `blocked`/`failed` 后人无法在 Session 里接手。

**根因**：实现把 Executor 的工具锁死了。

**修复**：`blocked`/`failed` 时**工具保持可用**，人可以直接在 Session 里接手；只暂停自动输入。
launch 失败不再自动重试，等人的消息/后续 Report/显式 retry。

证据：§4 L80。

## 12. 定位纪律

- **先证据后结论**：每条结论引用 `§N Ln`（研究报告），不凭印象。
- **区分事实来源**：Superagent 事实与 dsh-anic 对照分开标注，不混用。
- **不降级**：不为让准入表通过而放宽「未点名格只在接收全部消息时可用」的约束。
- **不假绿**：退出码 2/3 必须如实上报，不得当作成功。
- **无证据 ≠ 通过**：研究报告未运行 build/test，结论需经实证验证。
