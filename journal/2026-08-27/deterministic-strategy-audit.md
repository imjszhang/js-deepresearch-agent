# Deterministic strategy audit: official compare is a contract, not a grade

> 日期：2026-08-27
> 项目：js-deepresearch-agent
> 类型：架构设计 / 功能实现
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [官方审计是什么](#2-官方审计是什么)
3. [官方审计不是什么](#3-官方审计不是什么)
4. [实现要点](#4-实现要点)
5. [验证](#5-验证)

---

## 1. 背景与动机

原先 `scripts/benchmark/strategy-effectiveness.mjs` 把不可复现的判断写进了官方策略对比：

- 全局 `OFFICIAL_HOSTS` 只覆盖 Apple / llama.cpp 相关域名
- 主体 × 方面笛卡尔积把关键词共现当成覆盖
- `scoreNarrativeQuality` 优先采用 `claims.json` 的 stored verdict
- 规则层用文本重叠当 “supported”
- exploratory 合同过松（格子 >= 67%，任意 body/summary 即可）
- 效率指标把 exploration + report + evaluation tokens 混在一起除以 supported claims

产品决定：官方策略对比只回答 **“这次 run 是否满足已发布的、确定性的证据合同？”**

## 2. 官方审计是什么

`auditStrategyRun()` 对同一批产物 + 同一套 battery 必须产出 **字节级相同** 的 JSON。

- Battery 是 required-slot catalog（`query-battery.mjs`），每条 slot 有可程序检查的条件：patterns、minSources、sourcePolicy、requiresNumbers、minIndependentDomains、maxAgeDays
- Host 匹配解析 URL：hostname 精确比较（大小写不敏感）+ 可选 pathPrefix；拒绝 `github.com.evil.example` 这类仿冒
- Claim 层只记录机械布尔值 / 计数，从不写 `supported`
- `status` 只有 `ready` | `not_ready` | `invalid`，由硬检查推导，无权重

## 3. 官方审计不是什么

- 不是 LLM entailment / `judgeClaimWithLlm` / `claim_entailment`
- 不是关键词重叠支持率
- 不是 stored `evaluation.verdict` 的复述
- 不是主体 × 方面格子覆盖率
- 不是 0–100 分或字母评级
- 不改 live research 生成（`packages/js-deepresearch-engine` 的 claim_entailment / report assembler / quality.json writer）
- 不要求新的产物 schema；缺字段则为 `not_applicable`，除非 slot/policy 标为 required

`run-benchmark.mjs` 的 supported rate 与 `--llm` 仍可作为 **non-official analysis layer**，但不得喂给 `contract.pass`、`status` 或官方 delta。

## 4. 实现要点

| 文件 | 职责 |
| ---- | ---- |
| `scripts/benchmark/source-policy.mjs` | hostname / pathPrefix / registrable domain / WAF 壳页 |
| `scripts/benchmark/query-battery.mjs` | Apple / Zhipu / definitional slot catalogs |
| `scripts/benchmark/claim-audit.mjs` | `extractClaimNumbers`、`auditClaim`、`completeSlots` |
| `scripts/benchmark/strategy-effectiveness.mjs` | `auditStrategyRun`；`scoreStrategyEffectiveness` 仅为兼容包装 |
| `scripts/benchmark/compare-strategies.mjs` | 挂 `audit`（`effectiveness` 别名保留一版） |
| `scripts/benchmark/format-strategy-compare.mjs` | 五组 + status；语义表改标 non-official |
| `scripts/benchmark/extract-run-stats.mjs` | purpose token 拆分 |

## 5. 验证

```bash
node --test tests/strategy-effectiveness.test.mjs tests/benchmark-strategies.test.mjs
```

有意未做：引擎写出结构化事实（带单位的金额、as-of 日期字段）。审计只消费现有 `report.md` / `sources.json` / `claims.json` / `passages.json` / `quality.json` / `trace.json` / `meta.json`。
