# AGENT.md — js-deepresearch-agent CLI 指南

本文档面向 **AI Agent**，说明如何在本地通过 CLI 运行深度调研、读写配置、查看历史、管理 **intel store** 归档、编译 **Obsidian Wiki**，以及理解输出产物。Web UI 与 CLI 共用同一套设置与 SQLite 存储。

## 项目概览

| 项 | 说明 |
|---|---|
| 包名 | `js-deepresearch-agent` |
| CLI 入口 | `src/cli.mjs` |
| 可执行别名 | `js-deepresearch-agent`、`jdr` |
| Node 版本 | >= 20 |
| 本地数据 | `data/js-deepresearch.sqlite`（设置、历史、来源） |
| Intel 归档 | `data/intel/`（`js-intel-store`；可用 `JDR_INTEL_STORE_DIR` 覆盖） |
| 调研产物 | `work_dir/<strategy>/<timestamp>/`（默认） |
| Wiki vault | `wiki/`（`js-wiki-engine` 编译输出；已 gitignore） |

核心调研逻辑在 workspace 包 `packages/js-deepresearch-engine`（`js-deepresearch-engine`）中；研究完成后可选归档到 `js-intel-store`（[`src/storage/intel-store.mjs`](src/storage/intel-store.mjs)），再经 `js-wiki-engine` 编译为 Obsidian 兼容 Markdown vault。

CLI 通过 [`src/cli.mjs`](src/cli.mjs) 分发命令；前台 `research` 由 [`src/cli-research-run.mjs`](src/cli-research-run.mjs) 管理生命周期（含 Ctrl+C 取消），调用 `ResearchRunner` 执行调研，并将结果写入 SQLite、`work_dir`，并尝试写入 intel store（失败仅 warning，不阻断调研）。

## 调用方式

在项目根目录执行：

```bash
# 推荐：通过 npm exec 调用本地 bin
npm exec jdr -- help
npm exec jdr -- research "你的调研问题"

# 等价别名
npm exec js-deepresearch-agent -- help
```

全局安装后也可直接使用 `jdr` 或 `js-deepresearch-agent`（需先 `npm install -g` 或 `npm link`）。

**Agent 注意**：在 npm script 或自动化脚本中，始终用 `npm exec jdr -- <command>`，避免依赖全局 PATH。

## 命令一览

```
js-deepresearch-agent

Commands:
  research "query" [flags]
  config get [key]
  config set <key> <value>
  history [list]
  history show <researchId>
  intel list | show | sources | findings | import [flags]
  wiki init | compile | lint | ask [flags]
  serve [--port 3000]
```

子命令详情见下文 **`intel`**、**`wiki`**；也可用等价 npm script：`intel:import`、`intel:inspect`、`wiki:compile`。

未知命令会抛出 `Unknown command: ...` 并以退出码 1 结束。

---

## `research` — 执行深度调研

### 基本用法

```bash
npm exec jdr -- research "Explain the current state of local-first AI research"
```

查询字符串为剩余 positional 参数拼接而成，必须非空。

### 常用 flags（单次运行覆盖，不持久写入 SQLite）

| Flag | 映射配置键 | 说明 |
|---|---|---|
| `--provider` | `llm.provider` | `openai-compatible` 或 `ollama` |
| `--model` | `llm.model` | 模型名 |
| `--base-url` | `llm.baseUrl` | LLM API 地址 |
| `--api-key` | `llm.apiKey` | API Key（优先用 `.env`，避免在 shell 历史中泄露） |
| `--search` | `search.engine` | `searxng` 或 `js-eyes` |
| `--search-base-url` | `search.baseUrl` | SearXNG 等服务地址 |
| `--searxng-url` | `search.baseUrl` | `--search-base-url` 别名 |
| `--search-api-key` | `search.apiKey` | 搜索 API Key |
| `--search-skills` | `search.provider.skills` | 推荐：单次运行指定 JS Eyes skill |
| `--js-eyes-skill` | `search.provider.skills` | 兼容别名 |
| `--js-eyes-skills` | `search.provider.skills` | 兼容别名 |
| `--search-cli` | `search.provider.cli` | JS Eyes CLI 路径或命令名 |
| `--js-eyes-cli` | `search.provider.cli` | 兼容别名 |
| `--search-server-url` | `search.provider.serverUrl` | JS Eyes WebSocket 地址 |
| `--js-eyes-server-url` | `search.provider.serverUrl` | 兼容别名 |
| `--search-max-pages` | `search.provider.maxPages` | JS Eyes 搜索页数 |
| `--js-eyes-max-pages` | `search.provider.maxPages` | 兼容别名 |
| `--search-timeout-ms` | `search.provider.timeoutMs` | JS Eyes 单次搜索超时（毫秒） |
| `--js-eyes-timeout-ms` | `search.provider.timeoutMs` | 兼容别名 |
| `--strategy` | `research.strategy` | `source-based` \| `rapid` \| `parallel` |
| `--iterations` | `research.iterations` | 迭代轮数 |
| `--questions` | `research.questionsPerIteration` | 每轮生成问题数 |
| `--concurrency` | `research.concurrency` | 并发搜索数 |
| `--work-dir` | `research.workDir` | 产物根目录（相对 cwd 或绝对路径） |
| `--source-fetch-mode` | `research.sourceBased.fetchMode` | `disabled`（默认）\| `full` \| `summary`；抓取 URL 正文或 LLM 摘要 |
| `--source-fetch-backend` | `research.sourceBased.fetchBackend` | `auto`（默认）\| `http` \| `js-eyes`；知乎来源优先走 js-eyes 浏览器读取 |
| `--source-max-urls` | `research.sourceBased.maxUrlsTotal` | 单次调研最多 enrich 的 URL 数 |
| `--source-enable-filter` | `research.sourceBased.enableRelevanceFilter` | 是否启用 LLM 来源相关性过滤 |
| `--source-max-sources` | `research.sourceBased.maxSourcesForReport` | 过滤后保留的最大来源数 |
| `--output <file>` | — | 额外将 report 写入指定文件 |
| `--json` | — | stdout 输出 JSON（含 `artifacts` 路径） |
| `--no-save` | — | 不写入 SQLite 历史 |
| `--no-work-dir` | — | 不写入 `work_dir` 会话目录 |

### 完整示例

```bash
npm exec jdr -- research "Compare SearXNG and Brave Search APIs" \
  --provider openai-compatible \
  --model gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --search-base-url http://127.0.0.1:8080 \
  --strategy source-based \
  --iterations 2 \
  --questions 3 \
  --concurrency 2 \
  --output report.md

# 单次运行临时指定 JS Eyes skill（不写入 .env / SQLite）
npm exec jdr -- research "openclaw" \
  --search js-eyes \
  --search-skills js-reddit-ops-skill \
  --search-server-url ws://localhost:18080 \
  --strategy rapid
```

### 输出行为

| 通道 | 内容 |
|---|---|
| **stdout** | 默认：Markdown 报告；`--json`：完整结果 JSON |
| **stderr** | 进度日志 `[level] progress% message`；产物目录提示 |
| **`--output`** | 报告副本 |
| **`work_dir/`** | 会话目录（除非 `--no-work-dir`） |
| **SQLite** | 历史记录（除非 `--no-save`） |
| **`data/intel/`** | 尝试归档到 intel store（失败仅 stderr warning，不阻断调研） |

`--json` 模式下进度只走 stderr，stdout 仅为 JSON，便于 Agent 解析。

### 取消调研（Ctrl+C）

前台 `research` 命令支持优雅取消。实现位于 [`src/cli-research-run.mjs`](src/cli-research-run.mjs)：`SIGINT` / `SIGTERM` → `AbortController` → `ResearchRunner.run({ signal })` → 搜索层 / js-eyes 子进程。

```bash
npm exec jdr -- research "deep research" --search js-eyes --search-skills js-reddit-ops-skill
# 按一次 Ctrl+C：停止后续 LLM / 搜索 / js-eyes 子进程，历史标记为 cancelled
# 再按一次 Ctrl+C：强制退出（exit code 130）
```

**Agent 注意**：在 Cursor 终端或自动化环境中「中断命令」不等于可靠取消——须依赖 CLI 自身的信号处理。若用户要求中止调研，应发送 Ctrl+C 到正在运行的 `jdr research` 进程，或等待其输出 `Research cancelled.`；不要假设 shell 会话断开已停掉底层 Node / js-eyes 子进程。

行为说明：

| 项 | 说明 |
|---|---|
| 信号 | 首次 `SIGINT` / `SIGTERM` 触发 `AbortController`，取消信号传递到 `ResearchRunner`、[`search-executor`](packages/js-deepresearch-engine/src/research/search-executor.mjs) 与 js-eyes CLI 子进程 |
| stderr 提示 | `[info] -% Cancellation requested. Stopping research...`，随后 `Research cancelled.` |
| 历史 | 默认写入 SQLite：创建时 `queued` → 立即 `running` → 成功 `completed` / 取消 `cancelled` / 失败 `failed` |
| 取消时产物 | 不写半成品 `report` / `work_dir` / `sources`；仅更新历史状态与 `error` 字段 |
| `--no-save` | 不写历史，仅 stderr 输出取消提示 |
| `--json` | 取消时不输出半截 JSON；错误/取消信息走 stderr，exit code **130** |
| js-eyes | Windows 上 [`cli-process.mjs`](src/search-providers/js-eyes/cli-process.mjs) 会 `child.kill()` 并 `taskkill /T /F` 清理进程树，避免 `.cmd` shim 留下孤儿 Node 进程 |
| 限制 | 不会自动停止常驻 `js-eyes server`；不会关闭已打开的浏览器标签页；进行中的 LLM HTTP 请求可能需等当前请求返回后才完全停止 |

CLI 与 Web UI 取消对比：

| 通道 | 触发方式 | 实现 |
|---|---|---|
| CLI 前台 | Ctrl+C / SIGTERM | [`runCliResearch()`](src/cli-research-run.mjs) + `AbortController` |
| Web UI | `POST /api/research/:id/cancel` | [`JobRunner.cancel()`](src/jobs/job-runner.mjs) + `AbortController` |

两者语义一致（均向 `ResearchRunner` 传 `signal`），CLI 无需 job id。

### 会话产物结构

默认路径：`work_dir/<strategy>/<YYYY-MM-DD_HHMMSS>/`

| 文件 | 内容 |
|---|---|
| `report.md` | 最终 Markdown 报告 |
| `findings.json` | 结构化发现 |
| `sources.json` | 引用来源列表 |
| `meta.json` | 查询、策略、时间戳、部分设置快照 |

Agent 应优先读取 `report.md` 给用户摘要；需要溯源或二次处理时用 `sources.json` / `findings.json`。

---

## `config` — 读写持久配置

配置保存在 `data/js-deepresearch.sqlite` 的 `settings` 表。启动时 `.env` 中的值会**覆盖**已存设置（见下文「配置优先级」）。

### 读取

```bash
# 全部设置（JSON）
npm exec jdr -- config get

# 点分键
npm exec jdr -- config get llm.model
npm exec jdr -- config get search.engine
npm exec jdr -- config get research.strategy
```

### 写入

```bash
npm exec jdr -- config set llm.apiKey "YOUR_API_KEY"
npm exec jdr -- config set search.baseUrl "http://127.0.0.1:8080"
npm exec jdr -- config set research.strategy "rapid"
npm exec jdr -- config set research.iterations 3
```

`config set` 会将字符串 `"true"` / `"false"` 转为布尔，`"123"` 转为数字。

### 常用配置键

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "gpt-4o-mini",
    "apiKey": "",
    "baseUrl": "https://api.openai.com/v1",
    "temperature": 0.2,
    "maxTokens": 4000
  },
  "search": {
    "engine": "searxng",
    "baseUrl": "http://127.0.0.1:8080",
    "maxResults": 8,
    "jsEyesCli": "js-eyes",
    "jsEyesSkill": "js-zhihu-ops-skill",
    "jsEyesSkills": ["js-zhihu-ops-skill"],
    "jsEyesServerUrl": "",
    "jsEyesTimeoutMs": 120000
  },
  "research": {
    "strategy": "source-based",
    "iterations": 2,
    "questionsPerIteration": 3,
    "concurrency": 2,
    "workDir": "work_dir"
  }
}
```

---

## `history` — 调研历史

```bash
# 列表（默认）
npm exec jdr -- history
npm exec jdr -- history list

# 查看某次报告
npm exec jdr -- history show <researchId>
```

列表格式：`id  status     createdAt  query`（制表对齐）。无历史时输出 `No research history.`。

### 状态说明

| status | 含义 | 典型来源 |
|---|---|---|
| `queued` | 记录已创建，尚未进入 runner | CLI / Web UI 创建瞬间 |
| `running` | 调研进行中 | CLI `runCliResearch()` 或 Web UI `JobRunner` |
| `completed` | 成功完成，含 `report` | 正常结束 |
| `cancelled` | 用户取消（Ctrl+C 或 API cancel） | `Research cancelled.` / AbortError |
| `failed` | 非取消类错误 | 搜索/LLM 等异常 |

CLI `research`（未加 `--no-save`）与 Web UI 任务共用 `research_history` 表。CLI 在**开始时**即写入记录（不再等完成后才入库），因此 `history list` 可看到进行中的 `running` 条目。

取消后查看：`history show <id>` 输出 `error` 字段（如 `Research cancelled.`），无 `report`。

**与 intel store 的关系**：`history` 读 SQLite 应用状态；`intel` 读 `data/intel` 结构化归档（runs / findings / sources / report 路径）。新 run 完成后会尝试 `archiveResearchResultSafe`；历史 `work_dir` 需 `intel import` 回填。两者 `researchId` 可能一致（有 `meta.researchId`）或为 `imported__<strategy>__<timestamp>`。

---

## `intel` — 研究产物归档（js-intel-store）

管理 [`data/intel`](data/intel) 中的归档 runs。默认目录：`data/intel`；环境变量 `JDR_INTEL_STORE_DIR` 可覆盖。

### 子命令

```bash
# 列出归档（默认最近 20 条）
npm exec jdr -- intel list
npm exec jdr -- intel list --limit 50 --json

# 查看单次 run 摘要
npm exec jdr -- intel show <researchId>

# 查看来源 / findings
npm exec jdr -- intel sources <researchId> --limit 10
npm exec jdr -- intel findings <researchId> --limit 10

# 从 work_dir 历史回填 intel store
npm exec jdr -- intel import --dry-run
npm exec jdr -- intel import --strategy source-based
npm exec jdr -- intel import --force --json
```

| 子命令 | 说明 |
|---|---|
| `list` | 归档 runs 列表（`researchId`、strategy、query、sources/findings 计数） |
| `show <researchId>` | 单次 run 元数据（`reportPath`、`sessionDir` 等） |
| `sources <researchId>` | 该 run 的来源列表 |
| `findings <researchId>` | 该 run 的 findings 列表 |
| `import` | 扫描 `work_dir` 下 `YYYY-MM-DD_HHMMSS` session，写入 intel store |

### 常用 flags

| Flag | 说明 |
|---|---|
| `--intel-dir <dir>` | Intel store 根目录（默认 `data/intel`） |
| `--limit <n>` | `list` / `sources` / `findings` 行数上限（默认 20） |
| `--root <dir>` | import 时 work_dir 根（默认 `work_dir`） |
| `--strategy <name>` | import 仅处理某一策略目录 |
| `--dry-run` | import 预览，不写盘 |
| `--force` | import 时覆盖已存在 run 元数据 |
| `--json` | JSON 输出 |

### researchId 规则

| 来源 | researchId |
|---|---|
| 新 research 且 `meta.json` 含 UUID | `meta.researchId` |
| 历史 import、无 UUID | `imported__<strategy>__<YYYY-MM-DD_HHMMSS>` |

**Agent 注意**：Windows 路径下 import ID **不能**含 `:`（已改为 `imported__` 前缀）。

等价 npm script：

```bash
npm run intel:import -- --dry-run --strategy source-based
npm run intel:inspect -- list
```

详见 journal：[`journal/2026-05-26/js-intel-store-integration.md`](journal/2026-05-26/js-intel-store-integration.md)

---

## `wiki` — LLM Wiki 编译（js-wiki-engine）

将 intel store 中的 research **确定性编译**为 Obsidian 兼容 vault（Wikilink、YAML frontmatter、`manifest.json` 增量）。默认输出目录 `wiki/`（本地生成，不入 git）。

### 子命令

```bash
# 初始化 vault 目录与模板
npm exec jdr -- wiki init
npm exec jdr -- wiki init --vault ./my-wiki --init-obsidian-config

# 编译（默认取 intel store 最近一条 run）
npm exec jdr -- wiki compile
npm exec jdr -- wiki compile --research-id 00176e84-2548-4160-add1-7df5a49f7e27 --vault wiki --lint

# 仅检查断链 / manifest
npm exec jdr -- wiki lint --vault wiki --json

# 确定性检索相关页面（无 LLM）
npm exec jdr -- wiki ask "What is LLM Wiki?" --vault wiki --limit 5
```

| 子命令 | 说明 |
|---|---|
| `init` | 创建 `Home.md`、`Map of Content.md`、`Templates/` 等 |
| `compile` | 从 intel store 读 sources + report，生成 `Sources/`、`Topics/`、`Claims/`、更新 MOC |
| `lint` | 断链、manifest 缺页、topic 无 sources；写入 `Lint/latest.md` |
| `ask` | 按关键词打分返回相关 wiki 页面（MVP 检索，非 RAG） |

### 常用 flags

| Flag | 说明 |
|---|---|
| `--research-id <id>` | 指定归档 run（默认：intel `list` 最近一条） |
| `--vault <dir>` | Vault 目录（默认 `wiki`） |
| `--force` / `--full` | 忽略 manifest hash，重编全部 source 页 |
| `--lint` | `compile` 结束后自动 `lint` |
| `--init-obsidian-config` | 写入最小 `.obsidian/app.json` |
| `--limit <n>` | `ask` 返回页面数（默认 5） |
| `--json` | JSON 输出 |

### Vault 结构（编译后）

```text
wiki/
├── Home.md
├── Map of Content.md
├── Sources/<researchId>/Source NNN - <title>.md
├── Topics/<Topic>.md
├── Claims/<Topic> Claims.md
├── Lint/latest.md
├── Templates/
└── manifest.json          # 仅 engine 增量用，非人类入口
```

**Agent 工作流**：`research` →（可选）`intel import` 补历史 → `intel list` 确认 `researchId` → `wiki compile --lint` → 用 Obsidian 打开 `wiki/`，或 `wiki ask` 查相关页。

等价 npm script：

```bash
npm run wiki:compile -- --research-id <id> --vault wiki --lint
```

包 API 在 `packages/js-wiki-engine`；详见 journal：[`journal/2026-05-26/js-wiki-engine.md`](journal/2026-05-26/js-wiki-engine.md)

---

## `serve` — 启动 HTTP 服务

```bash
npm exec jdr -- serve
npm exec jdr -- serve --port 3000
```

默认端口：`3000`，或环境变量 `PORT`。启动后访问 `http://127.0.0.1:<port>`。

与 `npm run server` 类似，均提供 Express API + 已构建前端。开发前端时用 `npm run dev`（Vite 代理 `/api`）。

### Web UI：Wiki 页

导航 **Research | History | Wiki**，页面 [`web/wiki.html`](web/wiki.html)（[`web/src/wiki.mjs`](web/src/wiki.mjs)）。

| 能力 | 说明 |
|---|---|
| 选择 run | 下拉列表来自 `GET /api/intel/runs` |
| 编译 | `POST /api/wiki/compile`（可选 lint / force） |
| 状态 | `GET /api/wiki/status`（manifest、lint 摘要、vault 路径） |
| 检索 | `POST /api/wiki/ask`（确定性页面检索） |
| 浏览 | `GET /api/wiki/pages`（分组列表）、`GET /api/wiki/page?path=`（正文 + wikilink 元数据）；页内渲染 Markdown，`[[wikilink]]` 站内跳转 |

History / Results 中 completed 调研可直达 `/wiki.html?researchId=<id>`；已编译页面可深链 `/wiki.html?page=Topics/Llm%20Wiki.md`。Vault 默认 `wiki/`，可通过设置 `research.wikiVault` 覆盖（API 读取 SQLite settings）。

开发：`npm run dev` 后打开 `http://127.0.0.1:5173/wiki.html`；生产需 `npm run build` 将 `wiki.html` 打进 `dist/`。

---

## `benchmark` — 评估报告与来源匹配

离线评估已保存调研产物，**不会**重新执行 `research` 或搜索。入口为独立脚本（**未**并入主 CLI `jdr`）。

```bash
# 从 work_dir 会话目录
node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125
node scripts/benchmark-research.mjs work_dir/source-based/2026-05-26_043125 --no-llm --json

# 从 intel store（需先 archive 或 intel import）
node scripts/benchmark-research.mjs --research-id 00176e84-2548-4160-add1-7df5a49f7e27 --no-llm
node scripts/benchmark-research.mjs --research-id imported__source-based__2026-05-26_065414 --strict-platform js-eyes:zhihu
```

| Flag | 说明 |
|---|---|
| `--research-id <id>` | 从 `data/intel` 加载四件套（与 `work_dir` 路径二选一） |
| `--json` | 输出机器可读 JSON |
| `--no-llm` | 仅规则层评分，不调用 LLM |
| `--strict-platform` | 要求引用来源的 `engine` 匹配指定值，如 `js-eyes:zhihu` |

输入需包含 `report.md`、`findings.json`、`sources.json`、`meta.json`（目录或 intel 归档均可）。脚本会：

1. 从 `findings.json` 建立 `[1.1]` 引用映射
2. 从 `Summary` / `Key Findings` / `Evidence` 提取 claim
3. 规则层检查引用是否存在、来源字段是否完整、平台是否匹配
4. 可选调用当前 LLM 配置，判定 `supported / partially_supported / unsupported / unverifiable`

典型用途：对比修复前后两次调研，例如 `sources.json` 为空但报告仍完整时，benchmark 会标记 `empty_sources` 与 `no_citation` 风险。

---

## 配置优先级

从高到低：

1. **CLI flags**（仅当次 `research`，不写入 SQLite）
2. **`.env` / 环境变量**（每次 `get()` 时覆盖 SQLite 中对应字段）
3. **SQLite 持久设置**（`config set` 写入）
4. **引擎默认值**（见 `packages/js-deepresearch-engine/src/config/defaults.mjs`）

复制 `.env.example` 为 `.env` 并填写密钥。`.env` 已在 `.gitignore` 中，**禁止提交**。

### 环境变量 ↔ 设置映射

| 环境变量 | 设置路径 |
|---|---|
| `PORT` | 服务端口（非 settings 对象） |
| `LLM_PROVIDER` | `llm.provider` |
| `LLM_MODEL` | `llm.model` |
| `OPENAI_API_KEY` | `llm.apiKey` |
| `OPENAI_BASE_URL` | `llm.baseUrl` |
| `OLLAMA_BASE_URL` | `llm.baseUrl`（provider 为 ollama 或未设 OpenAI URL 时） |
| `SEARCH_ENGINE` | `search.engine` |
| `SEARCH_BASE_URL` / `SEARXNG_URL` | `search.baseUrl` |
| `SEARCH_API_KEY` | `search.apiKey` |
| `JS_EYES_CLI` | `search.jsEyesCli` |
| `JS_EYES_SKILL` | `search.jsEyesSkills`（逗号分隔多 skill） |
| `JS_EYES_COMMAND` | `search.jsEyesCommand` |
| `JS_EYES_SERVER_URL` | `search.jsEyesServerUrl` |
| `JS_EYES_MAX_PAGES` | `search.jsEyesMaxPages` |
| `JS_EYES_TIMEOUT_MS` | `search.jsEyesTimeoutMs` |
| `WORK_DIR` | `research.workDir` |
| `JDR_INTEL_STORE_DIR` | intel store 根目录（非 settings 对象；默认 `data/intel`） |

---

## 调研策略选择

| ID | 速度 | 深度 | 适用场景 |
|---|---|---|---|
| `rapid` | 快 | 浅 | 快速概览；不支持多轮 `iterations` |
| `source-based` | 均衡 | 深 | **默认**；基于来源迭代追问；可选 URL 正文/摘要 enrichment |
| `parallel` | 快 | 广 | 大量并行子问题，覆盖面广 |

Agent 选型建议：

- 用户要**快速答案** → `--strategy rapid`
- 用户要**引用与深度** → `--strategy source-based`（默认）
- 用户要**广泛扫描** → `--strategy parallel`，可适当提高 `--concurrency`

### Source-Based 深度阅读（可选）

默认 `fetchMode: disabled`，行为与旧版一致（仅使用搜索 snippet）。开启后会在每轮搜索后按 URL 抓取正文或 LLM 摘要，并在报告阶段优先使用 `summary || content || snippet` 作为 Evidence。

| 配置键 / Flag | 默认 | 说明 |
|---|---|---|
| `research.sourceBased.fetchMode` / `--source-fetch-mode` | `disabled` | `full` 抓取正文；`summary` 抓取后 LLM 压缩 |
| `research.sourceBased.fetchBackend` / `--source-fetch-backend` | `auto` | `js-eyes` 强制浏览器读取；`http` 仅 HTTP fetch |
| `research.sourceBased.maxUrlsTotal` / `--source-max-urls` | `24` | 全局 enrich URL 上限 |
| `research.sourceBased.enableRelevanceFilter` / `--source-enable-filter` | `false` | LLM 相关性过滤 |
| `research.sourceBased.maxSourcesForReport` / `--source-max-sources` | `30` | 过滤后保留来源数 |

示例（知乎 + 摘要模式）：

```bash
npm exec jdr -- research "llm wiki" \
  --search js-eyes \
  --search-skills js-zhihu-ops-skill \
  --strategy source-based \
  --source-fetch-mode summary \
  --source-fetch-backend js-eyes \
  --source-max-urls 12
```

`parallel` / `rapid` 不受 `sourceBased` 配置影响。

---

## 外部依赖与前置条件

### LLM

- **openai-compatible**：需有效 `OPENAI_API_KEY` 与可达的 `OPENAI_BASE_URL`
- **ollama**：本地 Ollama（默认 `http://127.0.0.1:11434`），设置 `LLM_PROVIDER=ollama`

### 搜索：SearXNG（默认）

- 默认地址 `http://127.0.0.1:8080`
- 调研前确认 SearXNG 可访问，否则搜索阶段失败

### 搜索：JS Eyes（浏览器技能）

设置 `SEARCH_ENGINE=js-eyes`。本项目**不**安装 skill、不启 server、不管理登录；通过 **app 层本地 provider** 调用 `js-eyes` CLI。JS Eyes **不属于** `js-deepresearch-engine` npm 包，而是在 [`src/search-providers/register-local-search-engines.mjs`](src/search-providers/register-local-search-engines.mjs) 启动时注册。

配置归一化：`JS_EYES_*` / `--js-eyes-*` / `--search-*` 都会映射到 `search.provider`。Driver 选择规则：

| `provider.driver` | 行为 |
|---|---|
| `unified` | 强制 `js-eyes search ... --skills ... --json` |
| `skill-run` | 全部 skill 走 `js-eyes skill run <id> search ...` |
| `auto`（默认） | 若任一 skill 在本地 registry 标记为 `skill-run`，则走 skill-run；否则 unified |

本地 skill registry（[`src/search-providers/js-eyes/skill-registry.mjs`](src/search-providers/js-eyes/skill-registry.mjs)）用于处理 unified facade 不兼容的 skill，**无需修改 js-eyes 仓库**。新增特殊 skill fallback 时只改 app 层 registry，不改 npm 包。例如 Reddit：

```bash
js-eyes skill run js-reddit-ops-skill search "query" --limit 8 --ws-endpoint ws://localhost:18080 --read-mode api --json
```

默认 skill（X、知乎、小红书等）仍走 unified：

```bash
js-eyes search "query" --skills js-x-ops-skill --max-results 8 --max-pages 1 --server ws://localhost:18080 --json
```

统一输出为 `{ ok, items: [{ title, url, snippet, platform, engine }] }`（skill-run 时由 deepresearch 本地 normalizer 映射）。平台差异由 js-eyes skill 实现；argv 差异由 deepresearch registry 管理。

前置检查清单：

1. 已安装 `js-eyes` CLI（Windows 可自动解析 `js-eyes.cmd`）
2. `js-eyes server start` 已运行
3. 浏览器扩展已连接（推荐 `ws://localhost:18080`）
4. 目标 skill 已 enable，站点已登录
5. 运行 `js-eyes doctor --json` 验证

多站点示例：

```bash
# .env 持久配置
JS_EYES_SKILL=js-zhihu-ops-skill,js-xiaohongshu-ops-skill

# Reddit（自动走 skill-run fallback）
JS_EYES_SKILL=js-reddit-ops-skill

# 或单次 CLI 覆盖（推荐临时实验）
npm exec jdr -- research "query" --search js-eyes --search-skills js-reddit-ops-skill
```

**Reddit 排障**：若 unified `js-eyes search` 返回 0 条或参数报错，确认 deepresearch 侧已启用本地 registry（默认已包含 `js-reddit-ops-skill`）。可手动验证：

```bash
js-eyes skill run js-reddit-ops-skill search "openclaw" --limit 3 --read-mode api --json
```

各 skill 串行查询；单 skill 失败时仍返回其他 skill 结果（**AbortError 除外**，取消会立即停止后续 skill）；全部失败才报错。浏览器-backed skill 会自动将问题并发限制为 1。

**取消与 js-eyes**：每次搜索可能触发浏览器 `open_url`（如 Reddit）。`source-based` 默认约 2 轮 ×（原问题 + 3 子问题）≈ 7 次搜索；取消后不再调度新搜索，但已打开的标签页需手动关闭。

---

## Agent 推荐工作流

### 1. 首次使用前检查环境

```bash
npm install
npm exec jdr -- config get llm.provider
npm exec jdr -- config get search.baseUrl
# 若使用 js-eyes：js-eyes doctor --json
```

### 2. 执行调研并保存可解析结果

```bash
npm exec jdr -- research "用户的问题" \
  --strategy source-based \
  --json \
  --output tmp/report.md
```

解析 stdout JSON 获取 `report`、`sources`、`artifacts.sessionDir`。

### 3. 只读历史、不重复跑

```bash
npm exec jdr -- history list
npm exec jdr -- history show <id>
```

### 3b. 归档与 Wiki（LLM Wiki 管线）

```bash
# 历史 work_dir 回填 intel（首次或补数据）
npm exec jdr -- intel import --strategy source-based

# 确认 researchId
npm exec jdr -- intel list --limit 5

# 编译 Obsidian vault 并 lint
npm exec jdr -- wiki compile --research-id <id> --vault wiki --lint

# 在 vault 内检索相关页
npm exec jdr -- wiki ask "用户问题" --vault wiki
```

新完成的 `research` 会自动尝试写入 intel store；若只关心 SQLite 历史可跳过上述步骤。

### 4. 临时覆盖、不改持久配置

对所有 `research` 参数使用 flags，**不要**为一次性实验调用 `config set`。

### 5. 自动化脚本注意

- 使用 `--json` 解析结果；进度在 stderr，勿混读
- 长任务可能数分钟；JS Eyes 多 skill 时超时近似 `JS_EYES_TIMEOUT_MS × skill 数`
- 产物与 DB 在 `.gitignore`（`data/`、`work_dir/`、`wiki/`），勿提交
- **退出码**：成功 `0`；普通错误 `1`；用户取消 `130`（`Research cancelled.`）
- 自动化取消：向子进程发 `SIGINT`/`SIGTERM`，或在前台交互环境发送 Ctrl+C；勿仅 kill 父 shell 并假设调研已停

### 6. 中止进行中的调研

用户说「中止 / 停止调研」时：

1. 若 CLI 前台仍在跑：发送 Ctrl+C（或 `kill -INT <pid>`），等待 stderr 出现 `Research cancelled.`
2. 若通过 Web UI 启动：调用 `POST /api/research/:id/cancel`
3. 确认：`npm exec jdr -- history list` 中对应条目应为 `cancelled`
4. 若 js-eyes 仍偶发开页：检查是否有孤儿 `node ... js-eyes` 进程；Windows 可 `js-eyes server stop` 后重启 server（会切断所有浏览器自动化，慎用）

详见 journal：[`journal/2026-05-26/cli-research-cancel.md`](journal/2026-05-26/cli-research-cancel.md)

---

## 错误与排查

| 现象 | 可能原因 |
|---|---|
| `Usage: js-deepresearch-agent research "query"` | 未提供查询文本 |
| 搜索失败 | SearXNG 未启动或 URL 错误 |
| JS Eyes 失败 | CLI/skill/server/登录/风控；查 `js-eyes doctor --json` |
| LLM 401/403 | API Key 或 base URL 错误 |
| `Research not found` | `history show` 的 id 不存在 |
| `Unknown command` | 命令拼写错误 |
| `No archived research runs found` | `wiki compile` 前需先跑 research 或 `intel import` |
| `Archived research run not found` | `intel show` / `wiki compile` 的 researchId 不存在 |
| `wiki lint` 有 errors | 见 `wiki/Lint/latest.md`；常见为断链或 manifest 指向缺失文件 |
| 按 Ctrl+C 后 js-eyes 仍开页 | 取消只停**后续**搜索；队列中最后一两次可能仍在执行；已开标签不自动关。确认 CLI 已升级且 stderr 有 `Cancellation requested` |
| `Research cancelled.` | 用户主动取消；历史 `cancelled`，exit code 130 |
| 终端断开但调研仍完成 | 旧版或未走信号路径；升级后须用 Ctrl+C，不能仅靠关闭终端 |

CLI 顶层错误输出 `error.message` 到 stderr；普通错误退出码 `1`，取消退出码 `130`。

---

## 与代码的对应关系

| 文件 | 职责 |
|---|---|
| `src/cli.mjs` | CLI 入口；`research` / `config` / `history` / **`intel`** / **`wiki`** / `serve` |
| `src/cli-research-run.mjs` | 前台 research 生命周期、`createResearchAbortController()`、`runCliResearch()`、历史状态 `running`/`cancelled`/`failed` |
| `src/cli-utils.mjs` | 参数解析、`applyResearchFlags()`、`config` 点分键读写 |
| `src/storage/intel-store.mjs` | `archiveResearchResult`、`readArchivedResearch`、`createIntelStoreEngine` |
| `scripts/intel/import-work-dir-core.mjs` | `intel import` 扫描与回填逻辑 |
| `scripts/intel/inspect-core.mjs` | `intel list/show/sources/findings` 查询 |
| `scripts/wiki/compile.mjs` | npm `wiki:compile` 脚本入口（逻辑与 `jdr wiki compile` 等价） |
| `packages/js-wiki-engine` | `initWiki`、`compileWiki`、`lintWiki`、`askWiki`、`loadSourcesFromIntelStore` |
| `packages/js-intel-store` | npm 依赖；`StorageEngine` + data source registry |
| `src/api/wiki-routes.mjs` | Web API：`/api/intel/runs`、`/api/wiki/compile`、`/api/wiki/status`、`/api/wiki/ask`、`/api/wiki/pages`、`/api/wiki/page` |
| `src/api/wiki-path.mjs` | Vault 路径校验、页面读取、wikilink 解析 |
| `web/src/wiki.mjs` | Wiki 页：编译控制台 + ask + 侧栏浏览 |
| `web/src/wiki-markdown.mjs` | Markdown 渲染（marked + DOMPurify）与 wikilink 链接 |
| `src/jobs/job-runner.mjs` | Web UI 异步任务、`cancel()` + `AbortController` |
| `src/search-providers/js-eyes/cli-process.mjs` | js-eyes 子进程 spawn、abort 时 `killProcessTree()`（Windows `taskkill /T /F`） |
| `src/search-providers/js-eyes/index.mjs` | js-eyes 搜索 adapter；skill-run 时 AbortError 立即向上抛 |
| `src/bootstrap.mjs` | SQLite 服务（settings / history / sources） |
| `src/config/settings-store.mjs` | 设置持久化 + `.env` 覆盖 |
| `src/config/env-overrides.mjs` | 环境变量映射 |
| `src/storage/research-repository.mjs` | `research_history` CRUD 与 `updateStatus()` |
| `packages/js-deepresearch-engine` | `ResearchRunner`、策略、搜索、产物写入 |
| `packages/js-deepresearch-engine/src/research/search-executor.mjs` | 并发搜索；`AbortError` 不吞掉，取消后不再调度新问题 |

修改 CLI 行为时以 `src/cli.mjs`、`src/cli-research-run.mjs` 与 `tests/cli-research-cancel.test.mjs`、`tests/cli-intel-wiki.test.mjs` 为准；修改调研逻辑优先改 engine 包；intel/wiki 分别见 `js-intel-store` / `js-wiki-engine` 与对应 journal。跑 `npm test`。

---

## 安全与仓库规范

- 勿将 `.env`、`data/`、`work_dir/`、`wiki/` 提交到 git
- 勿在对话或日志中粘贴完整 API Key
- 跑测试：`npm test`；lint：`npm run lint`

---

## 快速参考卡片

```bash
# 帮助
npm exec jdr -- help

# 跑调研（默认策略 + 存库 + work_dir）
npm exec jdr -- research "问题"

# 机器可读输出
npm exec jdr -- research "问题" --json --no-save

# 取消：前台 Ctrl+C 一次（graceful），两次（force exit 130）

# 查/改配置
npm exec jdr -- config get
npm exec jdr -- config set llm.model "gpt-4o-mini"

# 历史
npm exec jdr -- history list
npm exec jdr -- history show <id>

# Intel 归档
npm exec jdr -- intel list
npm exec jdr -- intel import --dry-run
npm exec jdr -- intel show <researchId>

# Wiki
npm exec jdr -- wiki compile --research-id <id> --lint
npm exec jdr -- wiki ask "问题" --vault wiki

# Web 服务
npm exec jdr -- serve --port 3000
```
