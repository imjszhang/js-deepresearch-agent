# AGENT.md — js-deepresearch-agent CLI 指南

本文档面向 **AI Agent**，说明如何在本地通过 CLI 运行深度调研、读写配置、查看历史，以及理解输出产物。Web UI 与 CLI 共用同一套设置与 SQLite 存储。

## 项目概览

| 项 | 说明 |
|---|---|
| 包名 | `js-deepresearch-agent` |
| CLI 入口 | `src/cli.mjs` |
| 可执行别名 | `js-deepresearch-agent`、`jdr` |
| Node 版本 | >= 20 |
| 本地数据 | `data/js-deepresearch.sqlite`（设置、历史、来源） |
| 调研产物 | `work_dir/<strategy>/<timestamp>/`（默认） |

核心调研逻辑在 workspace 包 `packages/js-deepresearch-engine`（`js-deepresearch-engine`）中；CLI 调用 `ResearchRunner` 执行调研，并将结果写入 SQLite 与 `work_dir`。

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
  serve [--port 3000]
```

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
| `--strategy` | `research.strategy` | `source-based` \| `rapid` \| `parallel` |
| `--iterations` | `research.iterations` | 迭代轮数 |
| `--questions` | `research.questionsPerIteration` | 每轮生成问题数 |
| `--concurrency` | `research.concurrency` | 并发搜索数 |
| `--work-dir` | `research.workDir` | 产物根目录（相对 cwd 或绝对路径） |
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
```

### 输出行为

| 通道 | 内容 |
|---|---|
| **stdout** | 默认：Markdown 报告；`--json`：完整结果 JSON |
| **stderr** | 进度日志 `[level] progress% message`；产物目录提示 |
| **`--output`** | 报告副本 |
| **`work_dir/`** | 会话目录（除非 `--no-work-dir`） |
| **SQLite** | 历史记录（除非 `--no-save`） |

`--json` 模式下进度只走 stderr，stdout 仅为 JSON，便于 Agent 解析。

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

仅 CLI `research` 且未加 `--no-save` 的记录会入库；Web UI 触发的任务由 job runner 单独管理，也可能出现在同一表中。

---

## `serve` — 启动 HTTP 服务

```bash
npm exec jdr -- serve
npm exec jdr -- serve --port 3000
```

默认端口：`3000`，或环境变量 `PORT`。启动后访问 `http://127.0.0.1:<port>`。

与 `npm run server` 类似，均提供 Express API + 已构建前端。开发前端时用 `npm run dev`（Vite 代理 `/api`）。

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

---

## 调研策略选择

| ID | 速度 | 深度 | 适用场景 |
|---|---|---|---|
| `rapid` | 快 | 浅 | 快速概览；不支持多轮 `iterations` |
| `source-based` | 均衡 | 深 | **默认**；基于来源迭代追问 |
| `parallel` | 快 | 广 | 大量并行子问题，覆盖面广 |

Agent 选型建议：

- 用户要**快速答案** → `--strategy rapid`
- 用户要**引用与深度** → `--strategy source-based`（默认）
- 用户要**广泛扫描** → `--strategy parallel`，可适当提高 `--concurrency`

---

## 外部依赖与前置条件

### LLM

- **openai-compatible**：需有效 `OPENAI_API_KEY` 与可达的 `OPENAI_BASE_URL`
- **ollama**：本地 Ollama（默认 `http://127.0.0.1:11434`），设置 `LLM_PROVIDER=ollama`

### 搜索：SearXNG（默认）

- 默认地址 `http://127.0.0.1:8080`
- 调研前确认 SearXNG 可访问，否则搜索阶段失败

### 搜索：JS Eyes（浏览器技能）

设置 `SEARCH_ENGINE=js-eyes`。本项目**不**安装 skill、不启 server、不管理登录；仅调用 `js-eyes` CLI。

前置检查清单：

1. 已安装 `js-eyes` CLI（Windows 可自动解析 `js-eyes.cmd`）
2. `js-eyes server start` 已运行
3. 浏览器扩展已连接（推荐 `ws://localhost:18080`）
4. 目标 skill 已 enable，站点已登录
5. 运行 `js-eyes doctor --json` 验证

多站点示例：

```bash
JS_EYES_SKILL=js-zhihu-ops-skill,js-xiaohongshu-ops-skill
```

各 skill 串行查询；单 skill 失败时仍返回其他 skill 结果；全部失败才报错。

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

### 4. 临时覆盖、不改持久配置

对所有 `research` 参数使用 flags，**不要**为一次性实验调用 `config set`。

### 5. 自动化脚本注意

- 使用 `--json` 解析结果；进度在 stderr，勿混读
- 长任务可能数分钟；JS Eyes 多 skill 时超时近似 `JS_EYES_TIMEOUT_MS × skill 数`
- 产物与 DB 在 `.gitignore`（`data/`、`work_dir/`），勿提交

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

CLI 顶层错误输出 `error.message` 到 stderr，退出码 `1`。

---

## 与代码的对应关系

| 文件 | 职责 |
|---|---|
| `src/cli.mjs` | CLI 入口、命令分发 |
| `src/cli-utils.mjs` | 参数解析、`config` 点分键读写 |
| `src/bootstrap.mjs` | SQLite 服务（settings / history / sources） |
| `src/config/settings-store.mjs` | 设置持久化 + `.env` 覆盖 |
| `src/config/env-overrides.mjs` | 环境变量映射 |
| `packages/js-deepresearch-engine` | `ResearchRunner`、策略、搜索、产物写入 |

修改 CLI 行为时以 `src/cli.mjs` 与 `tests/cli-utils.test.mjs` 为准；修改调研逻辑优先改 engine 包并跑 `npm test`。

---

## 安全与仓库规范

- 勿将 `.env`、`data/`、`work_dir/` 提交到 git
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

# 查/改配置
npm exec jdr -- config get
npm exec jdr -- config set llm.model "gpt-4o-mini"

# 历史
npm exec jdr -- history list
npm exec jdr -- history show <id>

# Web 服务
npm exec jdr -- serve --port 3000
```
