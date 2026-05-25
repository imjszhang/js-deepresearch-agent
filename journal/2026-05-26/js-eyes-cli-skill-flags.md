# JS Eyes CLI Skill 选择：不用改 `.env` 也能临时指定 skill

> 日期：2026-05-26
> 项目：js-deepresearch-agent
> 类型：功能实现
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)

---

## 1. 背景与动机

JS Eyes 解耦完成后，skill 已通过 `.env` 的 `JS_EYES_SKILL` 或 `config set search.jsEyesSkill` 配置。但用户在实际调研时经常只想**临时**换站点——例如这次搜 X、下次搜知乎——而不想改 `.env` 或污染 SQLite 持久配置。

`research` 命令已有 `--strategy`、`--search` 等一次性覆盖 flag，却缺少对 JS Eyes skill 的等价入口。这就是本次要补的缺口。

---

## 2. 分析过程

### 2.1 现有配置通道

| 通道 | 持久化 | 适用场景 |
| ---- | ------ | -------- |
| `.env` / `JS_EYES_SKILL` | 启动时覆盖 | 长期默认 skill |
| `config set search.jsEyesSkill` | 写入 SQLite | 持久偏好 |
| `js-eyes search --skills` | 无 | 只测搜索，不走 deepresearch |

`settingsFromFlags()` 原先只映射 LLM、搜索引擎类型、策略等，**没有** js-eyes skill 相关 flag。

### 2.2 底层已就绪

[`packages/js-deepresearch-engine/src/search/engines/js-eyes.mjs`](../../packages/js-deepresearch-engine/src/search/engines/js-eyes.mjs) 已通过 `resolveJsEyesSkills(config)` 读取 `jsEyesSkills` / `jsEyesSkill`，并传给 `js-eyes search --skills ...`。缺的只是 CLI 层把 flag 写进 settings。

---

## 3. 方案设计

为 `research` 增加一次性 flag，复用 `parseJsEyesSkills()` 与 `normalizeSearchConfig()`，行为与 `.env` 完全一致。

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| flag 名称 | `--js-eyes-skill`，别名 `--js-eyes-skills` | 与 env 命名一致，复数形式作别名 |
| 写入字段 | `search.jsEyesSkill` + `search.jsEyesSkills[]` | 兼容 legacy 与新 adapter |
| 逻辑位置 | [`src/cli-utils.mjs`](../../src/cli-utils.mjs) 的 `applyResearchFlags()` | 可单测，不跑完整 CLI 主流程 |
| 持久化 | 不写入 SQLite / `.env` | 与其他 research flag 行为一致 |
| 优先级 | CLI flag > `.env` > SQLite defaults | 临时实验覆盖长期配置 |
| 附加 flag | `--js-eyes-cli`、`--js-eyes-server-url`、`--js-eyes-max-pages`、`--js-eyes-timeout-ms` | 同一次运行可完整覆盖 JS Eyes 运行时参数 |

### 用法示例

```bash
npm exec jdr -- research "openclaw" \
  --search js-eyes \
  --js-eyes-skill js-x-ops-skill,js-zhihu-ops-skill \
  --js-eyes-server-url ws://localhost:18080 \
  --strategy rapid
```

---

## 4. 实现要点

| 文件 | 变更 |
| ---- | ---- |
| [`src/cli-utils.mjs`](../../src/cli-utils.mjs) | 新增 `applyResearchFlags()`：映射通用 flag + js-eyes skill/运行时参数；调用 `parseJsEyesSkills`、`normalizeSearchConfig` |
| [`src/cli.mjs`](../../src/cli.mjs) | `settingsFromFlags()` 委托给 `applyResearchFlags()`；更新 `printHelp()` |
| [`tests/cli-utils.test.mjs`](../../tests/cli-utils.test.mjs) | 3 个新测试：skill 映射、别名去重、运行时 flag |
| [`AGENT.md`](../../AGENT.md) | flags 表 + JS Eyes 多站点示例 |
| [`README.md`](../../README.md) | 单次运行覆盖 skill 示例 |

skill flag 处理逻辑（要点）：

```javascript
const jsEyesSkillValue = flags['js-eyes-skill'] ?? flags['js-eyes-skills'];
if (jsEyesSkillValue !== undefined) {
  const jsEyesSkills = parseJsEyesSkills(jsEyesSkillValue);
  settings.search.jsEyesSkills = jsEyesSkills;
  settings.search.jsEyesSkill = jsEyesSkills[0];
}
settings.search = normalizeSearchConfig(settings.search);
```

---

## 5. 验证与测试

### 单元测试

```bash
npm test
```

新增测试覆盖：

- `--js-eyes-skill "a,b"` → `jsEyesSkill === "a"`，`jsEyesSkills === ["a","b"]`，`options` 同步
- `--js-eyes-skills " a ; a b "` → 去重为 `["a","b"]`
- `--js-eyes-cli`、`--js-eyes-server-url` 等运行时 flag 正确映射

全量 **48/48** 通过（2026-05-26）。

### 端到端

```bash
npm exec jdr -- research "openclaw" \
  --search js-eyes \
  --js-eyes-skill js-x-ops-skill \
  --strategy rapid \
  --no-save \
  --no-work-dir
```

4 轮 rapid 搜索成功，约 76 秒完成报告；CLI flag 覆盖 `.env` 中默认 skill 生效。

---

## 6. 后续演化

| 方向 | 说明 |
| ---- | ---- |
| Web UI skill 选择 | API / 前端表单暴露 `jsEyesSkills`，与 CLI flag 对齐 |
| skill 预设 | `--js-eyes-preset x` 映射到常用 skill 组合 |
| `.env.example` | 可补充 CLI flag 对照说明（当前已在 AGENT/README 覆盖） |

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| ---- | ---- |
| 问题 | 除 `.env` 外，能否在 CLI 临时选择 js-eyes skill |
| 思考 | engine 已支持 `jsEyesSkills`；缺 research 命令的一次性 flag 入口 |
| 方案 | `applyResearchFlags()` + `--js-eyes-skill` / 别名 + 相关运行时 flag |
| 执行 | 代码、测试、文档更新；`npm test` 与 `openclaw` rapid 端到端验证通过 |
