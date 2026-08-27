# 探索模式改为证据门槛驱动的 Search-Read-Reason 循环

> 日期：2026-08-27
> 项目：js-deepresearch-agent / js-deepresearch-engine
> 类型：架构设计 / 功能实现
> 来源：GitHub issue #19

## 1. 背景与动机

探索模式已经以 token 预算为主约束，但达到下限后只要全局看起来“有正文”，就可能以 `evidence_sufficient` 早停。智谱类尽调会因此在未读港交所/监管一手材料时结束。本次把 exploratory 留在长报告产品形态，只借用循环纪律，不引入短答案、百万 token 或 Beast Mode。

## 2. 方案设计

```
Query -> research profile -> gap ledger -> search -> URL pool
  -> source-policy tiering -> embedding cluster -> rerank current gap
  -> read 2-5 -> validate bodies -> candidate draft
  -> deterministic readiness gate
       pass -> final report
       fail -> repair gaps
  -> budget/source hard stop -> report with unresolved gaps
```

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 停点 | 确定性 gate，不是 token 下限 | 下限只保证继续探索 |
| 动作 | search/read/reflect/draft/finalize | answer/stop 仍作别名 |
| 选源 | 来源策略先于 rerank | 媒体转载不能验证 required host |
| Embedding | 去重/聚类/passage/新颖性 | 不用于真伪或 `evidence_sufficient` |
| Benchmark slots | 不导入 engine | 通用引擎不能写死智谱/Apple 题目 |

## 3. 实现要点

| 文件 | 职责 |
| ---- | ---- |
| `body-quality.mjs` | WAF/壳页判定，不引用 benchmark 脚本 |
| `research-profile.mjs` | 从 query 推断 freshness/primary_source 等 |
| `readiness-gate.mjs` | 唯一 `evidence_sufficient` 路径 |
| `source-policy.mjs` / `url-pool.mjs` | 主机名策略、持久候选池 |
| `adaptive-v2.mjs` | Search-Read-Reason 控制器 |
| `budget-manager.mjs` | 探索 / 候选评估 / 报告 / 报告后评估分桶 |

## 4. 验证

- `node --test`：`adaptive-v2`、`exploratory-budget`、以及 readiness/source-policy/body-quality 新测试
- `npm test`、`npm run lint`

## 5. 后续

- 若真实 run 的候选评估仍然偏贵，再收紧默认 evaluation token 上限
- benchmark 可选用 engine 的 WAF helper，但不要反向依赖
