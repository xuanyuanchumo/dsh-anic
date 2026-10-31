/**
 * 原语调色板（第一层）——所有十六进制字面量的唯一归宿。
 *
 * ## 为什么不是"亮度阶梯"
 *
 * 改造前这里叫 `PALETTE.green500 / green600 / green700`，名字暗示亮度分档，
 * 但同一个"PASS 绿"在 gate / status / text 三个角色里各取一档，档位与实际
 * 可读性毫无关系：`green600` 在浅色面上只有 3.15:1，`green500` 只有 2.18:1。
 * 档位名于是成了"看起来有依据"的假依据。本文件改为**按角色命名**：
 * 一个原语 = 一个用途，值本身由 WCAG 对比度反解得到（见下）。
 *
 * ## 校准方法（可复现）
 *
 * 对每个色相，在 HSL 空间二分亮度，取"恰好越过阈值的最小改动"值，
 * 再留 ~0.1 余量，避免刚好卡在 4.50 那种一改字体就掉下去的位置。
 * 阈值分两档（WCAG 2.x）：
 *   - 文本（≤18px 常规字重）：≥4.5:1
 *   - 图形/填充/圆点（非文本）：≥3.0:1；本文件统一按 ≥3.3 校准留余量
 * 表面只有两个：浅色 `#f8fafc`（--anic-surface）与暗色 `#0f172a`。
 *
 * ## L / D 后缀的含义（重要）
 *
 * `*L` = 浅色表面上的取值，`*D` = 暗色表面上的取值。**两者不可互换**：
 * 一个色值在浅色面上过 4.5 不代表在暗色面上也过（实测 `#2b823b`：
 * 浅色面 4.60、暗色面仅 3.2）。所以「文本级」令牌在 SEMANTIC 里取 L 值，
 * 在 SEMANTIC_DARK 里取 D 值；两者都由 `tests/contract/contrastContract.test.ts`
 * 逐项测量，任一项越界即红。
 *
 * ## 与语义层的关系
 *
 * 组件**禁止**直接引用本文件（`clientRenderContract.test.ts` 会拒绝任何
 * 绕过 `token()` 的颜色字面量）。本文件只被 `tokens.ts` 消费。
 */

export const PALETTE = {
  // ── 图形级填充：同一个值要同时成立在浅色与暗色两个表面上（≥3.3）──
  // 所以这一组**没有** L/D 之分，也不该被暗色块覆盖：覆盖只会让两套门禁色
  // 各自漂移，而它们本来就都成立。
  gatePass: '#0a9f41',
  gateFail: '#fc4545',
  gateDoubt: '#e36200',
  gatePending: '#758ba8',
  gateSkip: '#7a8ba4',
  // 节点类型色（SVG circle fill）
  //
  // ## cycle-94 重校准：9 色在可行亮度带内**联合**求解（不是逐个调）
  //
  // 旧值实测有 **8 对 ΔE < 15**（正常视觉）且同样 8 对在 deuteranopia 下塌缩，
  // 其中 `typePhase #398ce3` vs `typeMicroStep #328ce8` 的 ΔE 只有 **0.8** ——
  // 色相差 6°，等于两个不同的类型画成了同一个颜色；`typeHumanGate` vs
  // `typeIncident` 是 1.1（色盲下 0.4，几乎完全同色）。
  //
  // **根因（可复算，见 `src/shared/colorMath.ts` 的 `feasibleLuminanceBand`）**：
  // 每个类型色必须在浅底 `#f8fafc` 与暗底 `#0f172a` 上**同时** ≥3.3，这两条约束
  // 把可用相对亮度锁进 `[0.1441, 0.2541]` 这一极窄带（宽仅 1.76 倍）。9 个色被挤在
  // 这么窄的亮度维度里，只能靠**色相**区分 —— 而色相维度本身在 sRGB 里能塞下的
  // 「ΔE ≥ 15 的不同色」数量，在这个亮度带内**不足 9 个**。
  //
  // **⇒ ΔE ≥ 15 对 9 色是数学上不可达的，不是没调好。** 求解时必须**三项一起看**：
  // `min(正常ΔE, deuterΔE, protanΔE)`。只优化正常视觉 ΔE 能得到 9.1，但那时
  // `typeGate` vs `typeCycle` 在 deuteranopia 下只剩 **2.23**（红绿盲用户眼里
  // 门禁和循环同色 —— 比原来更糟）。本轮的取值是三项**同时**最优的解：
  //
  // | 口径 | 实测最小值 |
  // |---|---|
  // | 正常视觉 OKLab ΔE | **6.92** |
  // | deuteranopia ΔE | **5.39** |
  // | protanopia ΔE | **5.45** |
  // | 两表面最小对比度 | **3.35** |
  //
  // （方法：语义色相锚定 + 在可行亮度带内网格化候选 + 贪心+局部搜索，目标函数
  // 直接取三项最小值。求解脚本留在 `.cycles/cycle-95-evidence/solve-palette.mjs`，
  // 可复算 —— 调色板这种"看着差不多"的改动必须留下算法痕迹。）
  //
  // **为什么保留每个类型的色彩身份**：不锚定色相的全局最优能把正常 ΔE 推到 10，
  // 但它把蓝（phase）挪成橙、把门禁挪成绿 —— 颜色的**语义联想**被破坏（阶段一直
  // 是蓝、门禁一直是琥珀橙）。色彩身份本身是可读性的一部分，所以在各自色相区间
  // 内取最优，代价是正常 ΔE 从 10 降到 6.92，换来三项均衡。
  //
  // **颜色不是唯一通道**（这是本轮的诚实结论）：WCAG 1.4.1 要求分类信息另有
  // 形状/文字通道 —— 而且对 9 类**必须**有第二通道，因为色相维度在这个亮度带里
  // 装不下 9 个可分色。这就是 `graphTypeShape.ts`（类型专属形状）与卡片 meta 行
  // 文字存在的原因。改这里的值时**不要**把形状通道拆掉。
  typePhase: '#4292ad',      // 蓝（保留）：阶段一直是蓝
  typeMicroStep: '#8b7cd9',  // 紫：与 phase 蓝拉开（原 #328ce8 与 phase 仅差 0.8）
  typeGate: '#d46d05',       // 琥珀（保留）：门禁的语义色
  typeHumanGate: '#f04886',  // 玫红：人工门（原 #e65d59 与 incident 仅差 1.1）
  typeCycle: '#0d9e1b',      // 绿（保留）：循环
  typeGateEvent: '#ee31cf',  // 品红：门禁事件
  typeIncident: '#dc6359',   // 砖红：事故（与 human-gate 玫红拉开）
  typeAutonomy: '#399785',   // 青绿（保留）：自主级
  typeUnknown: '#5083fb',    // 蓝紫：兜底（与 phase 蓝拉开）
  // 步骤状态点（10px 圆点 fill）。与 gate 同值时仍独立登记：
  // 「一个值服务两个角色」正是本次缺陷的成因，独立登记才能各自被重校准。
  statusDone: '#0a9f41',
  statusActive: '#4f85fb',
  statusFailed: '#ef5454',
  statusSkipped: '#808a9c',
  statusPending: '#768ba9',

  // ── 文本级：浅色表面 (#f8fafc) 上 ≥4.6 ──
  textPassL: '#2b823b',
  textFailL: '#cf3d2e',
  textDoubtL: '#946b00',
  textOkL: '#12833c',
  textBadL: '#dc2727',
  textWarnL: '#b85509',
  textLedgerL: '#884cef',
  bandNormalL: '#17833f',
  bandWarnL: '#9e6606',
  bandAlarmL: '#e21313',
  textL: '#334155',
  textStrongL: '#475569',
  textDimL: '#475569',
  /**
   * 浅色面的"最弱文本"。#64748b（slate500）实测 4.548:1 —— 只比 WCAG 的 4.5
   * 高 1%，也就比"刚好达标"多一点点。这种值的问题是它**扛不住**任何扰动：
   * 字体换成字面稍细的一款、或做子像素抗锯齿，实际可读性就掉到线下，而对比度
   * 契约仍显示"通过"。故下沉到 4.93:1（色相不变，只压暗一档）。
   */
  textFaintL: '#616e84',

  // ── 文本级：暗色表面 (#0f172a) 上 ≥4.6 ──
  textPassD: '#309442',
  textFailD: '#d7594b',
  textDoubtD: '#a87a00',
  textOkD: '#149544',
  textBadD: '#e24e4e',
  textWarnD: '#d1610a',
  textLedgerD: '#9864f1',
  bandNormalD: '#1a9547',
  bandWarnD: '#b47407',
  bandAlarmD: '#ef3e3e',
  textD: '#e2e8f0',
  textStrongD: '#cbd5e1',
  textDimD: '#94a3b8',
  // 暗色下的"最弱文本"。注意它与浅色档是不同的值：
  // 浅色档在暗底上只有 3.79:1，是本次实测出的真实缺陷之一。
  textFaintD: '#74849c',

  // ── 交互态面（P1-1）──
  // 内联 style 对象**无法表达** :hover/:active/:focus-visible，所以这三个角色
  // 在过去根本不存在——按钮没有任何按下/悬停反馈。它们是**面**（背景色），
  // 不承载信息，故在对比度契约里归 DECORATIVE；但压在它们上面的文字仍按
  // 表面阈值衡量：浅色 #eef2f7 上 --anic-text 9.21、--anic-text-strong 6.74、
  // --anic-text-faint 4.587 全部 ≥4.55（实测，见 panelCss.test.ts）。
  surfaceHover: '#eef2f7',
  surfaceHoverD: '#1e293b',
  surfaceActive: '#e2e8f0',
  surfaceActiveD: '#243044',
  /**
   * 焦点环色（P1-1）。角色是**非文本图形**（outline 2px），按"两个表面同时
   * ≥3.3"校准：浅色面 4.94、暗色面 3.454。它必须是一个定值而不是 L/D 两档——
   * 焦点环画在**哪个**表面上取决于控件自身底色，而控件底色在两种主题下都会
   * 出现，所以只能取同时成立的那个交集（这是它不同于文本令牌的根因）。
   */
  focusRing: '#2563eb',

  // ── 面 / 边 / 墨 ──
  surface: '#f8fafc',
  surfaceD: '#0f172a',
  border: '#e2e8f0',
  borderD: '#1e293b',
  borderStrong: '#cbd5e1',
  borderStrongD: '#334155',
  rowBorder: '#f1f5f9',
  rowBorderD: '#1e293b',
  /**
   * 画在**门禁填充**上的字形墨色（P1-A11Y-CONTRAST 的第三个实测缺陷）。
   *
   * 改造前字形固定用白色（`anic-on-accent`），而白在亮绿填充上只有 2.28:1、
   * 在亮黄上 2.15:1 —— 字形本是为色盲/灰度打印准备的**第二通道**，结果它在
   * 五个裁决里有四个不可读。深墨 `#0f172a` 在改造后的五种填充上分别为
   * 5.14 / 5.17 / 5.11 / 5.11 / 5.15，全部 ≥4.5，于是墨色可以是一个定值。
   *
   * 刻意**不等于** `surfaceD`：两者数值恰好相同，但一个是"暗色面板底色"、
   * 一个是"亮填充上的墨"，未来任一方变化都不该拖走另一方。
   */
  glyphInk: '#0f172a',
  onAccent: '#ffffff',
  /** 节点详情抽屉压在图上，不能全遮。 */
  detailSurface: 'rgba(248, 250, 252, 0.95)',
  detailSurfaceD: 'rgba(15, 23, 42, 0.95)',
} as const;
