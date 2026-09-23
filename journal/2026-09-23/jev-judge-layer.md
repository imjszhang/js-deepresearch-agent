# 探索循环接入可选 Jev 判断层

> 日期：2026-09-23
> 项目：js-deepresearch-agent
> 类型：功能实现
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与范围](#1-背景与范围)
2. [四个映射](#2-四个映射)
3. [硬约束与保证方式](#3-硬约束与保证方式)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [未做与后续](#6-未做与后续)

---

## 1. 背景与范围

在 exploratory 循环中接入 TypeSafe Jev（`POST https://api.typesafe.ai/v1/systemone`，Bearer `TYPESAFE_API_KEY`，模型固定 `jev-1.13.0`）作为可选判断层。Jev 回答 `noul` / `choice`（≤255 选项）/ `score` 三类问题，返回 `answers` 与 `usage.input_tokens / output_tokens`；402/429/5xx 视为不可用。

范围：只实现 TypeSafe 方言；配置位于 `research.providers.judge`，与 `research.providers.rerank` 分开，不作为 rerank provider。默认 `provider=disabled` 且四个 feature 全关。

## 2. 四个映射

| feature | 作用点 | Jev 问题 | 结果如何使用 |
|---|---|---|---|
| `sourceAssessment` | full/extract 的结构化来源评估（需同时开 `research.read.sourceAssessment.enabled`） | `choice`：readability / contentKind / publisherType / evidenceTier（沿用现有枚举）；`noul`：firstParty | 所有答案置信达阈值才采用，产物标 `method: 'jev'`；不确定、降级或结果会声明一手/官方/主流身份时回退原 LLM 评估 |
| `readPriority` | 待读候选调度 | 每个缺失事实一个 `noul` + 每个候选 first_party | `readPriority = 0.8×事实均值 + 0.2×first_party`，只作为 ActionScheduler 排序键，不进 `actionKey` |
| `queryScreening` | Planner 输出查询 | `q{i}_target` 与 `q{i}_same_s{j}`（对比该 gap 最近 10 条已搜查询） | 同意图 ≥ 0.9 的查询以 `jev_intent` 丢弃；全部打分成功才按目标相关排序；不造词、不改写 |
| `passageOrder` | slot support 与主张校验已选片段 | 每段对焦点问题一个 `noul` | 只重排；确实发生重排时把顺序身份写入缓存键；报告阶段仅 exploratory 生效 |

## 3. 硬约束与保证方式

| 约束 | 保证方式 |
|---|---|
| Jev 不能让 gate / `evidence_sufficient` / slot verified / claim supported 从失败变通过 | Jev 只输出排序键、丢弃的重复查询和“是否回退 LLM”；判定仍由原确定性门槛和 LLM 校验给出。集成测试用“永远最正面”的脚本化 judge 证明失败 gate 与主张不翻转 |
| 关闭开关时行为与产物不变 | 未启用时不构造 judge；测试证明默认配置零 judge 调用、无 `calls/judge-*`；“永远不可用”judge 下报告、绑定、gate 与关闭时一致；原有测试全部保持通过 |
| 不计入探索下限、不空转 | BudgetManager 单独记 `judgeRequests / judgeTokens`（可选 `maxJudgeRequests / maxJudgeTokens`），不进入 LLM 或探索 token |
| 不新增规则造词、语言检测、静态路由或域名表 | 问题文本只来自已有 gap 事实、候选和查询；Jev 不能授予来源资质 |
| 不泄露密钥与本地正文 | 无 `--judge-api-key` flag；key 只从环境绑定，不进 executionConfig 与调用记录；`file://` 正文默认不发送（`allowLocalCorpus=false`） |
| 不可用时回退 | 402/429/5xx/超时记为 degraded，连续 3 次后本 run 挂起 judge；调用记录走 `calls/judge-N`，已落盘响应恢复时复用 |

## 4. 实现要点

### 关键模块

| 文件 | 职责 |
|---|---|
| `packages/js-deepresearch-engine/src/research/providers/jev-judge-provider.mjs` | TypeSafe 请求、响应结构校验、错误分类 |
| `packages/js-deepresearch-engine/src/research/judge-settings.mjs` | feature / 阈值归一化、`judgeActive`、本地正文发送判断 |
| `packages/js-deepresearch-engine/src/research/research-providers.mjs` | `wrapJudge`：缓存、恢复、挂起、预算、事件 |
| `judge-source-assessment.mjs` / `judge-read-priority.mjs` / `judge-query-screening.mjs` / `judge-passage-order.mjs` | 四个映射 |
| `src/cli-utils.mjs`、`src/config/env-overrides.mjs` | `--judge-*` flags、`JDR_JUDGE_PROVIDER` / `TYPESAFE_API_KEY` / `JDR_JUDGE_MODEL` |
| `scripts/benchmark/quality/verification-scenarios.mjs` | 注册 V26 离线验收场景 |

### 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| sourceAssessment 启用条件 | 需同时开原有 `sourceAssessment.enabled` | 只替换已存在的调用，不新增评估环节 |
| Jev 不确定时 | 回退原 LLM 评估，而非标 `assessmentStatus=unavailable` | 保持原有行为 |
| 来源资质 | Jev 结果声明一手/官方/主流时仍走 LLM | Jev 不能单独授予影响证据准入的身份 |
| 查询对比范围 | 该 gap 最近 10 条已搜查询 | 控制问题数量与 state 大小 |
| executionConfig | 冻结的配置中包含关闭状态的 judge 块（不含 key） | 恢复时能确认身份 |

## 5. 验证与测试

全部使用注入的假 fetch 与脚本化 fixture，未调用真实 Jev、未跑真实调研或 calibrate；fixture 不进入观察/曝光账本。

| 检查 | 结果 |
|---|---|
| `npm test` | engine 855/855（原 821），wiki 20/20，root 583/583（原 581） |
| `npm run lint` | 通过 |
| `npm run build` | 通过 |
| `npm run verify:programmatic -- --output-dir <tmp>` | passed；隔离方式 linux_network_namespace；26 个场景含 V26 15/15；外部访问尝试 0 |

Linux 云环境需在只有 `lo` 的网络命名空间中运行程序验收（`unshare -rn` 并启用 `lo`），否则记录为 incomplete。

## 6. 未做与后续

- 未实现 Vercel / Cloudflare 等其它方言。
- summary 模式的 `source_assessment` 仍是一次 LLM 调用，未拆分给 Jev。
- 真实效果评估（排序是否改善证据覆盖、成本对比）需用户授权真实 API 调用后再做。
