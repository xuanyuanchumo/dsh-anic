/**
 * import.meta.env 最小类型声明（cycle-45 T-4502b）。
 *
 * 本仓 client 不经 Vite 构建（tsdown CJS→wrap），tsconfig.client.json 没有
 * vite/client 类型；panelStore.ts 的 dev 双调自检用 `import.meta.env?.DEV`
 * （构建器把它编译为字面量 false 并死代码消除——生产零开销已实证）。这里
 * 只补类型形状，不引入 vite 依赖。tsdown 无 define 时 DEV 视为缺省（falsy
 * 分支），与宿主 web 端「发布即生产」语义一致。
 */
interface ImportMetaEnv {
  /** dev 构建标识（本仓构建链恒 falsy——声明形状供类型检查）。 */
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
