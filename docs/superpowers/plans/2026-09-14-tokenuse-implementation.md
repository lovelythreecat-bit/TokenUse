# TokenUse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 交付本地运行的 Windows Token 用量桌面应用，包括真实日志采集与各时段统计。

**Architecture:** Electron 主进程独占文件和 SQLite，React 通过受限 IPC 获取统计事件。纯函数适配器与分析层共享 TypeScript 事件类型，SQL.js 使用 SQLite WASM 避免 Windows 原生编译依赖，事务后原子落盘。

**Tech Stack:** Electron 44、React 19、TypeScript、Vite、SQL.js、Luxon、PapaParse、Vitest。

**Spec:** docs/superpowers/specs/2026-09-14-tokenuse-design.md

## Global Constraints

- 首版只面向 Windows；不读取 API Key、对话正文、登录态和账户接口。
- Cursor 只导入 CSV；OpenClaw 只读 JSONL；RAG 和 API 转发不在范围内。
- 事件 UTC 存储，按本地时区聚合；缺失值不补零；估算不是账单。
- 时间趋势一次最多生成 1,000 个桶，周一为一周开始。
- Windows 与 WSL 不同文件不能合并，同文件别名必须避免重复采集。

## 文件与契约

`src/shared/types.ts` 是所有接口的唯一来源。`src/core/parsers.ts` 输出 `parseLine(raw: unknown, context: ParseContext): ParseResult`；`src/core/analytics.ts` 输出 `analyze(events: UsageEvent[], query: Query, providers: Provider[], prices: PriceRule[]): Analytics` 与 `estimateCost(event, providers, prices, zone): CostEstimate | null`；`src/core/csv.ts` 输出 `previewCsv(text: string, path: string): CsvPreview`、`parseCsv(text, mapping, zone, source, allowExport): CsvResult`、`exportCsv(events): string`。Electron `Store` 保存 sources/providers/prices/events/cursors，`Collector` 只调用适配器，前端只调用 `window.tokenuse`。

### Task 1: 采集格式和统计纯函数

Files: `src/core/{parsers,analytics,csv}.ts`, `tests/{parsers,analytics,csv}.test.ts`, `tests/fixtures/*`.

- [x] 先为真实统计错误写失败测试，执行 `npm test -- tests/parsers.test.ts tests/analytics.test.ts tests/csv.test.ts`。
- [x] 实现互斥分项、Codex 累计快照去重、Claude 消息 ID、OpenClaw 格式。
- [x] 实现左闭右开查询、小时/日/周/月桶、24 小时分布、四时段、日期精度过滤和费用匹配。
- [x] 实现 CSV 映射、导出标识、错误行和幂等键；再次运行上述测试。

手工断言基准：
```ts
// Codex input=100, cached=20, output=30, reasoning=10 => input=80, output=20, total=130.
// 同一累计快照出现两次只计 130；next cumulative input=150/output=40 => 新增 60。
// 上海时间 05:59 和 06:00 的两条 10/20 Token 记录分别进入凌晨和上午。
// 单价 input=2/output=4，每种 1,000,000 => 费用 6；缺失已使用分量价格 => null。
// 最近两天 09:00 的 10/20 Token：趋势是两个桶，小时分布 09 时是 30。
```

### Task 2: 持久化与后台采集

Files: `electron/{store,collector,discovery}.ts`, `tests/{store,collector}.test.ts`.

- [x] 创建临时真实数据库/JSONL 测试：重复扫描不重复、半行后续补齐、截断重读、重新打开保存数据。
- [x] `Store.open(path, wasmPath)` 初始化数据库，`upsertEvents` 保留已有服务商归属；事务保存事件和游标。
- [x] `Collector.refresh()` 逐源读取 JSONL，限制单批读取，保存 parse state；失败更新来源状态。
- [x] WSL 只枚举运行发行版，UNC 路径规范化和可读性校验；本地 watcher 加轮询兜底。
- [x] 运行 `npm test -- tests/store.test.ts tests/collector.test.ts`。

```ts
// 写入一条 total=130 日志，刷新两次后库中仍只有一条；补入半行后才产生第二条。
// 关闭重开 SQLite，sources 与 events 数量和服务商归属保持一致。
```

### Task 3: 中文桌面界面

Files: `src/{App,main}.tsx`, `src/components/*`, `src/styles.css`.

- [x] 空状态显示真实来源配置入口，不生成演示事件。
- [x] 总览含筛选、时间范围/粒度、趋势图、小时分布、时段卡片和点击明细。
- [x] 明细支持时间与各维度筛选、分页、分项和费用、CSV 导出。
- [x] 设置支持发现/手动添加数据源、服务商 CRUD、价格、别名映射、CSV 预览映射及历史归属。
- [x] UI 验证用隔离的合成日志启动应用，验证筛选和表格，不读取个人正文。

### Task 4: Electron 集成与交付

Files: `electron/{main,preload}.ts`, `scripts/*`, `README.md`, `tests/electron-smoke.mjs`.

- [x] 为 IPC 参数和文件读取边界加入验证，仅接受明确文件选择后的 CSV。
- [x] 主窗口隔离、托盘菜单、退出持久化、单实例锁，禁止任意导航。
- [x] 执行 `npm test`、`npm run build`、Electron 启动检查与 `npm run package`。
- [x] 审查统计准确性、跨来源去重、权限和数据完整性，修复高影响问题并复测覆盖测试。
- [x] README 给出安装/开发步骤、首次添加数据源和已知数据限制；交付 Windows 应用包。

## 执行记录

- 初始目录只有设计文档，无 Git 仓库和已有应用；按用户指定目录原位创建，不移动 Cursor 的文档。
- 用户已明确“再检查一遍就可以开工”，无需再次询问执行方式。
- 规格复查修正推理包含关系、Codex 重复快照和峰谷价格说明。
