# 探索循环改为额度用尽才放弃

> 日期：2026-08-28
> 项目：js-deepresearch-agent / js-deepresearch-engine
> 类型：架构设计 / 功能实现
> 来源：Cursor Agent 对话

## 1. 背景与动机

上一轮把 exploratory 改成证据门槛驱动的 Search-Read-Reason 后，智谱类尽调仍会在转载读完、官方站 WAF 或空 `site:` 之后以 `source_blocked` 收工。过了 6 万下限、20 万上限还没用完，控制器却认为「没事可做」。这次对齐 Jina DeepResearch 的 while 纪律：gate 没过且探索额度还在，就继续搜、读、换角度。不引入 Beast Mode，也不抬默认 6 万/20 万。

## 2. 方案设计

```
Search-Read-Reason
  -> readiness.pass 且已过下限 -> evidence_sufficient
  -> gate 失败且硬上限未到 -> 短词 site: / 换 URL 继续
  -> 额度或步数用尽 -> budget_exhausted / safety_cap
```

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 整轮停因 | 取消 `source_blocked` | WAF / 空 `site:` / 未读官方 host 不是停点 |
| 失败的 finalize | 再探索，并禁止紧接着再 finalize | 对齐「答砸后下一步关掉 answer」 |
| `primary_filing` | 转载不能 `verified` | 避免规则把媒体站标绿后误判活干完了 |
| 官方 PDF | 轻量主体词核对 | 思朗科技年报不能给智谱过关 |
| `site:` | preferred/required host 都插短词 | 不要整段 gap，空结果换词而不是封 gap |
| 循环文件 | `adaptive-v2.mjs` → `exploratory-loop.mjs` | 对外策略早已是 exploratory；历史 `work_dir/adaptive` 与 `loopVersion: v2` 只留读路径 |

## 3. 实现要点

| 文件 | 职责 |
| ---- | ---- |
| `agent-policy.mjs` | gate 失败且额度还在时兜底必须是 search/read；换角度短词 `site:` |
| `exploratory-loop.mjs` | 新循环入口 `runExploratoryLoop`；finalize 失败后 continue |
| `research-state.mjs` / `readiness-gate.mjs` | `primary_filing` 覆盖与新鲜度看正文日期 |
| `source-policy.mjs` / `research-profile.mjs` | 短词 `site:`；监管/招股/年报/投资进入 preferredHosts |
| `stop-reasons.mjs` | 新 run 把历史 `source_blocked` 收成 `budget_exhausted` / `safety_cap` |

允许的新停因只有 `evidence_sufficient`、`budget_exhausted`、`safety_cap`、`user_cancelled`。旧产物仍可显示 `source_blocked`。

## 4. 验证

- `node --test`：`exploratory-readiness-loop`、`adaptive-v2`、`source-policy`、`readiness-gate`、`body-quality`
- `npm test`、`npm run lint`
- 官方策略审计仍以 `--no-llm` 为准；支持率不作为通过条件
- 不在实现中擅自开智谱 live 调研

## 5. 后续

- 报告矛盾检测、空 bullet 大修、js-eyes 打 IR 仍单独立项
- 用户确认后再用同一道智谱题、同一 6 万/20 万跑一轮 exploratory
