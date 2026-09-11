# Open Science 真实探索调研验证

日期：2026-09-08。对象：AIPOCH Open Science（官网与官方仓库由 JS Eyes Google 搜索确认）。本次只运行调研、分析代码和记录问题，未修改运行中的引擎或 JS Eyes。

## 配置与探索结果

- 模型：`qwen3.8:27b-mlx`，沿用本地配置。
- 搜索：`js-eyes` / `js-google-ops-skill`；14 次实际搜索的响应引擎均为 `js-eyes:google`。
- 单次 flags 指定探索下限 600,000、上限 1,000,000 token，没有改持久设置。
- 实际探索：494,644 token，121 次 LLM 调用，14 次搜索，28 次阅读尝试。
- 停止：`safety_cap / consecutive_invalid_steps`，连续 6 次无有效动作。下限尚差 105,356 token，不能认定完成了“60 万打底”。
- 11 个 required slots 中 8 个 verified；许可证/商业定价部分支持，用户反馈/比较与采用建议仍 limited。
- 总耗时约 47 分 37 秒。最终总 LLM token 为 630,303：探索 494,644，报告生成 42,127，报告校验 93,532。总调用数 152。总 token 超过 60 万不代表探索达到下限。
- 最终质量：`completionStatus=incomplete`、`gate=fail`，仍有 3 个 required slots 未完成。`reportContractSatisfied=true` 表示符合“不完整报告”的输出合同，不表示研究充分。
- 报告已成功落盘，进程退出码 0。SQLite 状态 completed；来源总数和 distinct source_key 均为 28；数据库报告、已发布版本及 intel snapshot 的报告/来源逐项一致；delivery failures 为空。
- 离线 benchmark（`--no-llm`）未发额外 LLM 请求，产物 health flags 为空、引用解析率 100%。37 个被评估的关键主张中 34 supported、3 conflicting；这些是内部校验结果，不能作为外部事实准确率。冲突项仍出现在英文工作流结论中，需要复核原始证据、claim 切分与必需 slot 保留之间的交互。
- 最终报告为 136,140 字符 / 198,568 UTF-8 字节。Evidence 部分约 102,183 字符，Sources 部分约 21,180 字符，二者合计约占全文 90.6%。

| 探索用途 | 调用数 | token |
|---|---:|---:|
| 研究合同 | 1 | 4,711 |
| 动作决策 | 38 | 176,011 |
| 查询规划 | 37 | 146,829 |
| 来源评估 | 30 | 80,981 |
| 槽位证据支持 | 15 | 86,112 |

决策与查询规划合计 322,840 token，占探索消耗约 65.3%。下述问题互相放大，不能把本次结果解释成“资料本来就不足，所以应该提高预算”。

## 发现与修复方向

### P1：已读取的许可证证据在分块选择时丢失

完整官网正文在字符约 7,239 处明确包含 Apache License 2.0。`selectSlotPassages` 为许可证问题选中的官网片段却是 `[4800, 7200)`，尾部停在许可证回答开头，后续包含许可证名与外部服务费用的片段没有入选。另两个名额给了官方 GitHub 页头与 AIPOCH 主页。该问题可直接用现有正文和选择函数离线复现，不需要再次调用模型。

结果：许可证槽位持续 `partially_supported`，原因被误归为材料没有具体许可证，而完整正文已经有答案。关键代码：`passage-utils.mjs:splitContentForPassages` 固定长度无重叠切分；`gap-slot-support.mjs:selectSlotPassages` 字面排序并优先来源多样性；缓存对相同选择结果不会主动探测邻接段落。

修复方向：按句段边界切分并保留重叠/邻接上下文；跨语言相关性选择；针对 partially_supported 的明确缺失项，在同一已读正文重新检索；不要为了来源多样性丢弃同页的直接答案。回归测试应验证具体许可证事实能被选择且保持原文 offset/quote anchoring，避免只检查片段数量。

### P1：研究合同增加了用户未要求的硬性来源类别

原始调研要求“真实用户反馈、同类产品比较、独立评价”，并未要求主流媒体。生成的合同为这两个槽位加上 `mainstream_media`，采用建议槽位还同时要求 `first_party`。后续 readiness 持续缺少 `criterion:mainstream_media`，博客和社区讨论无法满足此条件。

`research-profile-prompt.mjs` 已要求每个 criterion 由查询蕴含，但运行时仍接受了该合同。只补一条 prompt 不足以保证修复。

修复方向：区分用户硬约束、来源偏好与模型推断；为硬性 criterion 保留来自问题的依据，验证后才进入合同。用户反馈应允许符合身份与质量要求的社区/用户证据；采用建议应基于已证实事实推导，而不是要求外部媒体替用户做建议。

### P1：中文槽位误拒合理英文检索，恢复反复消耗 token

累计记录 41 次查询拒绝，其中 29 次 `scope_mismatch`、12 次重复。被误拒的例子包括 `AIPOCH Open Science AI Research Workbench user reviews`、`Open Science AIPOCH reddit hacker news discussion`、`AIPOCH Open Science vs Elicit vs Consensus AI research tools comparison`。

`adaptive/source-policy.mjs:queryMatchesGapScope` 去掉实体名称后主要做字面匹配；中文问题与英文查询失配后，非 first_party 槽位直接返回 false。恢复阶段反复受同一准入条件阻拦；没有转向仍未解决的许可证证据遗漏，最终连续无效计数触发全局安全停止。

修复方向：实体身份约束与查询意图相关性分开；利用目标 gap、expectedEvidence 和跨语言语义信息验证范围，保留真正跨主体查询的拒绝能力。恢复应识别重复拒绝根因、切换缺口或已读正文再检索。保留安全阀，不应通过增大无效次数帽或把 safety_cap 改为 evidence_sufficient 来掩盖问题。

### P2：JS Eyes Google 摘要抽取过早停在标题节点

初始 smoke search 及真实搜索结果中，多条 snippet 只有标题、站点名和面包屑。外部 JS Eyes 的 `skills/js-google-ops-skill/lib/serp/parsers.js:nearbyText` 从标题父节点开始，只要 text 长度超过 20 就返回，往往没有抵达包含描述正文的结果卡片。

修复方向：在单个结果容器中独立提取描述，排除标题与站点导航；找不到描述时标记为空/缺失。不要拿邻近卡片文本补摘要。需真实 DOM fixture 回归。此文件位于兄弟仓库，本次未修改。

### P2：报告准备串行重复计算正文向量

28 个 URL 展开为 86 个 finding-source 关联，官网和主仓库分别参与 11 个问题。`evidence-chain.mjs:buildPassageArtifactsAsync` 对关联逐个 await `rankPassages`，后者把查询和正文分块一起送入 embedding；不同问题重复发送同一正文。该阶段出现多次超时后降级，延长报告准备时间。`strategy-complete` 至 `passages-extracted` 从 05:36:26 UTC 持续到 05:47:33 UTC，约 11 分 7 秒。

修复方向：按 provider/model/content hash/chunk 参数缓存正文向量，单独计算问题向量；有界并发与连续 provider 故障熔断；保留各问题独立排序与引用绑定。先避免重复正文计算，再考虑扩大并发。

### P2：报告绑定 claim 直接展示长英文引文，并放大重复引用

报告计划的关键结论直接使用 `slotSupport.quote`，出现很长的英文工作流与安装步骤，和中文输出要求不符。多条结论带有从 `1.1` 到 `21.1` 的 22 个引用编号，但这些编号大多指向反复关联的官网/仓库，不能当成 22 份独立证据。

最终渲染保留了这些问题，还把同一英文工作流/安装结论重复显示。`report-assembler.mjs:renderEvidenceSection` / `renderSourcesSection` 按 finding 展开来源，将大量重复网页证据和 GitHub 导航噪声放入主报告，导致全文膨胀至 13.6 万字符。应将正文证据详情留在可展开附录或独立产物，主报告使用去重的来源索引和必要的短证据摘录。

`report-plan.mjs:buildSlotBoundClaim` 把原文 quote 直接作为展示文本，并合并 `citationsFromSlotFindings` / `citationsContainingQuote` 找到的全部编号。必须保留每个 required slot 的语义和引用绑定，但无需把完整原文及所有重复编号展示给用户。

修复方向：证据层保留原文、offset、claim ID 和绑定关系；展示层使用经过 entailment 校验的中文措辞；同一支持来源/片段只选择稳定的代表引用，且不跨槽删除必需 claim。

## 验收建议

修复优先级：合同依据与跨语言查询准入、正文证据选择、恢复调度，然后摘要与 embedding 性能。用本次原始已读网页作离线回归，随后保持 Google 和 600,000 token 下限进行对照实跑。验收不仅看进程成功，还应检查许可证与收费边界是否正确、无凭空增加的硬约束、独立反馈是否诚实区分、有效证据增长、实际探索 token 与停止原因、最终报告合同和交付状态。
