/**
 * cycle-83 locale 合并（第三批：配置编辑补全的 29 条 `config.*` 键）。
 *
 * ## 为什么是往既有 `config` 对象里插，而不是新增命名空间
 *
 * 全部新键都在 cycle-82 已建立的 `config.` 前缀下（`cfgText()` 以
 * `t('config.' + suffix)` 形态消费，闭包扫描器的 `dynamicKeyPrefixes` 认得这个前缀）。
 * 另开命名空间会破坏 `contract`：`i18nDeadKeyContract` 的 RESERVED 棘轮与
 * `closureAuditContract` 的幽灵清单都按前缀族对账。
 *
 * ## 为什么用「行定位 + 文本插入」而不 JSON 往返
 *
 * `localeKeyAnchors` 按**行号**定位词表键，`closureEvidenceAnchorContract` 钉死了
 * `trace.statusDone === 101` / `gate.pending === 228` 这类真实行号。
 * JSON 往返会重排整个文件 ⇒ 这些断言全部漂移（红线）。
 * 本脚本只在 `config` 对象的闭合行之前插入，且 `config` 之后还有 `configFile` 等其他顶层键，
 * 所以必须**精确找 config 自己的闭合行**（缩进 2 的 `},`），而不是第一个 `},`。
 *
 * 幂等：`config.pathEdit` 已存在则跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** 29 条新键（zh, en）。顺序即写入顺序，与交付单 docs/anic/cycle-83-config-i18n.md 一致。 */
const KEYS = [
  ['pathEdit', ['编辑', 'Edit']],
  ['pathEditSave', ['保存', 'Save']],
  ['pathEditCancel', ['取消', 'Cancel']],
  ['pathEditReset', ['撤销自定义', 'Reset to default']],
  ['pathEditHint', ['相对工作区根（如 docs/evals）', 'Workspace-relative (e.g. docs/evals)']],
  ['pathEditInvalid', ['不能含 .. 段', 'must not contain .. segments']],
  ['pathEditOutside', ['必须是相对工作区根的路径', 'must be a workspace-relative path']],
  ['pathEditing', ['正在编辑路径', 'Editing path']],
  ['pathDefault', ['默认', 'default']],
  ['pathOverridden', ['自定义', 'custom']],
  ['pathNotEditable', ['该项不可编辑', 'not editable']],
  ['pathOverridesActive', ['已自定义路径', 'Custom paths']],
  ['pathOverridesNone', ['全部使用默认路径', 'All paths at defaults']],
  ['pathOverridesIgnored', ['覆盖表整份被忽略（解析已回落到默认）：', 'Override table ignored entirely (resolved back to defaults):']],
  ['conflictTitle', ['磁盘已改动，你的修改基于旧值', 'Disk changed since you started editing']],
  ['conflictLine', ['{field}：你改成 {draft}，磁盘已是 {server}', '{field}: you set {draft}, disk now has {server}']],
  ['conflictOriginal', ['原基线：', 'was:']],
  ['conflictAdopt', ['采用磁盘', 'Use disk value']],
  ['conflictKeep', ['保留我的', 'Keep mine']],
  ['conflictDismiss', ['全部忽略', 'Dismiss all']],
  ['backupTitle', ['备份与恢复', 'Backups & restore']],
  ['backupNone', ['暂无备份（首次保存后才会生成）', 'No backups yet (created on first save)']],
  ['backupRestore', ['恢复', 'Restore']],
  ['backupPreviewRestore', ['预览恢复', 'Preview restore']],
  ['backupRestoring', ['恢复中…', 'Restoring…']],
  ['backupRestored', ['已恢复，改动字段数', 'Restored, fields changed']],
  ['backupRestoreFailed', ['恢复失败：{error}', 'Restore failed: {error}']],
  ['backupSafety', ['回滚前状态已备份到：', 'Pre-rollback state backed up to:']],
  ['backupChanged', ['改动 {count} 个字段', '{count} field(s) changed']],
];

function merge(file, idx) {
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.config && parsed.config.pathEdit !== undefined) {
    console.log(`${file}: config.pathEdit already present, skip`);
    return;
  }
  const lines = raw.split('\n');
  const cfgIdx = lines.findIndex((l) => l.replace(/\r$/, '') === '  "config": {');
  if (cfgIdx < 0) throw new Error(`${file}: top-level "config": { not found`);
  /*
   * config 的闭合行 = cfgIdx 之后第一条**缩进恰为 2** 的 `}`（有逗号也认）。
   *
   * 为什么不能写死 `  },`：cycle-82 是把 `graph` / `config` **追加到文件末尾**的，
   * 所以 `config` 目前是最后一个顶层键 ⇒ 它的闭合行是 `  }`（**没有**逗号）。
   * 写死带逗号会在"最后一个键"上永远找不到——而报错信息是"close brace not found"，
   * 看起来像文件损坏，实际是形态假设错了。这条就是本脚本第一版的失败原因。
   */
  let closeIdx = -1;
  for (let i = cfgIdx + 1; i < lines.length; i += 1) {
    if (/^  \},?$/.test(lines[i].replace(/\r$/, ''))) { closeIdx = i; break; }
  }
  if (closeIdx < 0) throw new Error(`${file}: config close brace not found`);
  // config 内最后一条子键行（跳过空行），后面补逗号。
  let lastIdx = closeIdx - 1;
  while (lastIdx > cfgIdx && lines[lastIdx].trim() === '') lastIdx -= 1;
  const crlf = raw.includes('\r\n');
  const eol = crlf ? '\r' : '';
  const newLines = KEYS.map(([k, pair], i) => {
    const tail = i === KEYS.length - 1 ? '' : ',';
    return `    ${JSON.stringify(k)}: ${JSON.stringify(pair[idx])}${tail}`;
  });
  const inserted = [`${lines[lastIdx]},`, ...newLines].map((l) => l.replace(/\r$/, '') + eol);
  const out = [...lines.slice(0, lastIdx), ...inserted, ...lines.slice(closeIdx)].join('\n');
  writeFileSync(file, out);
  const check = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${file}: inserted ${KEYS.length} config keys; config.total=${Object.keys(check.config).length}; top=${Object.keys(check).length}`);
}

merge('locale/zh.json', 0);
merge('locale/en.json', 1);
