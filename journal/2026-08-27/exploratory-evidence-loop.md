# 重构探索模式：证据门槛驱动的 Search-Read-Reason 循环

> 日期：2026-08-27
> 项目：js-deepresearch-agent / js-deepresearch-engine
> 类型：架构设计 / 功能实现
> 来源：GitHub issue #19

---

## 1. 背景与动机

探索模式在 token 下限之后，只要全局存在一些正文，就可能以 `evidence_sufficient` 结束。智谱类尽调会在未读港交所/公司一手材料时提前停。目标是引入 Jina DeepResearch 的循环纪律，但保持长报告产品形态，不照搬短答案、百万 token 或 Beast Mode。

## 2. 方案设计

```text
Query -> research profile -> gap ledger
  -> search -> URL pool -> source policy -> gap rerank -> read
  -> validate bodies -> candidate/draft -> deterministic readiness gate
       pass -> finalize
       fail -> repair gaps
  -> budget/source hard stop -> report with unresolved gaps
```

确定性门槛是 `evidence_sufficient` 的唯一来源。LLM evaluator、rerank、embedding 都不能覆盖失败。

## 3. 实现要点

| 模块 | 职责 |
| ---- | ---- |
| `adaptive/research-profile.mjs` | 从 query 推断 freshness/completeness/plurality 等，不编码智谱/Apple slot catalog |
| `adaptive/readiness-gate.mjs` | 确定性证据门槛与 repair gaps |
| `adaptive/source-policy.mjs` | required → tier → diversity，再交给 rerank |
| `adaptive/body-quality.mjs` | WAF/空壳页判定，供 engine 与 benchmark 共用思路 |
| `adaptive/embedding-signals.mjs` | 查询去重、转载聚类、novelty；失败回退规则 |
| `strategies/adaptive-v2.mjs` | Search-Read-Reason 控制器 |

停止原因收敛为：`evidence_sufficient`、`budget_exhausted`、`source_blocked`、`safety_cap`、`user_cancelled`。旧名 `max_budget_exhausted` / `target_budget_reached` 读入时映射到 `budget_exhausted`。

## 4. 验证

- 新增 engine 测试覆盖 search 后不能直接 finalize、WAF 不推进 gap、required host 缺失、预算耗尽报告、LLM 不能翻门槛、rerank 使用当前 gap、同域转载不算独立来源、近重复搜索拒绝。
- 保持 `adaptive-v2.test.mjs` 与 `exploratory-budget.test.mjs` 绿色，并更新“有正文即可 sufficient”的旧假设。

## 5. 后续演化

- 可选：给 candidate evaluation / post-report entailment 增加更细的默认 token 上限。
- 可选：把 WAF helper 抽到 benchmark 脚本复用，而不是反向 import engine 测试。
