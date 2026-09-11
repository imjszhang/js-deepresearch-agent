# 研究合同、证据与探索控制改造实施计划

状态：已实施并完成工程验收。制定日期：2026-09-08。下文保留原实施方案；实际改动、952 项回归、两次完整实跑及未通过的研究内容项目，见 [实施与验收记录](./research-evidence-redesign-implementation.md)。A 的研究完整性未通过，不因工程交付成功改写结论。

依据：[Open Science 真实探索调研诊断](./open-science-live-validation.md)。本次改造以当前工作区已经完成的结果事务、不可变版本产物、续跑交付、intel snapshot 和 Wiki 检索修复为基础，保留现有未提交工作。

## 1. 目标、范围和已确定的选择

目标是让原始请求、可调整的研究计划、不可变证据、可执行动作和报告表达各自有明确职责，修复这次实测暴露的错误约束、证据遗漏、规划空转、重复计算与报告膨胀。

- 主改动在 `packages/js-deepresearch-engine`；CLI、Web、intel、Wiki、benchmark 同步适配。保留 SQLite 与现有 workspace 架构，不引入图数据库、向量数据库或新 agent 框架。
- 新运行使用新流程；旧会话的合同、已完成结果、停止原因不可被新版规则静默改写。
- 统一证据层同时服务 focused/exploratory；动作队列优先用于 exploratory。quick 保持不读取网页正文、snippet-only 的策略合同，不因共用模块偷偷升级为正文调研。
- Google 摘要修复在兄弟仓库 `/Users/jszhang/github/my/js-eyes` 独立实施与验证，不能在本仓库归一化器中伪造摘要。
- 不提高默认模型规模，不依靠增加重试次数或降低证据标准解决问题；每条查询不新增一次 LLM 审核。
- 本轮保留 600,000 探索 token 下限的现有含义。下限不会替代真实性、取消和安全停止约束，不用报告/评估 token 或空转补足。
- 只用单次 flags 做实验，不写持久设置；不提交 `.env`、凭据或本地 `data/`、`work_dir/`、`wiki/` 产物。

原始用户请求是“调研 open-science 这个产品”。前次 CLI 中列出的详细调查提纲是代理扩写，不能继续把该提纲的全部内容标为人类用户硬要求。对照测试仍保留当时实际输入，原始意图验收另做。

## 2. 必须保持的不变量

1. LLM 不能通过输出 `origin=user`、`required=true` 或一段貌似相关的原文获得添加硬约束的权限。
2. 用户显式约束不能丢失；模型推断的来源偏好不能自动成为任务完成条件。证据有效性规则由版本化代码策略提供。
3. “还未检查到相关片段”“检查后不支持”“存在反证”是不同结果；任何否定判断只覆盖实际检查范围。
4. snippet、模型摘要、访问失败和登录壳页不得构造成功正文的片段位置或 direct evidence。
5. 每个必要问题独立保留主张绑定；来源或展示去重不得把一个问题的答案当成另一个问题的答案。
6. 文档版本、片段位置和主张 ID 在一次评估/渲染/恢复中稳定，不能通过 Markdown 文本相似度找回身份。
7. 单个问题或某种动作失败不直接阻断其他合法动作；搜索次数用尽不阻断不需搜索的已读材料检查。
8. 预算达到不等于证据充分；任务保存完成不等于研究充分。既有停止原因不得被续跑或重新渲染改写。
9. 结果核心提交、交付状态、session writer 锁、版本 manifest 校验、同 revision 幂等规则继续有效。

## 3. 数据模型与兼容边界

字段名作为实施合同；模块可拆分，但各字段的语义不可在实现时合并回单个布尔值。

### 3.1 请求、计划和约束

`ResearchRequest` 保存 `requestId / originalQuery / queryHash / planningContext / inputSource`。完整原始输入在入口单独保存；当前 `ResearchBrief.query` 的 1,000 字符规范化截断不能成为请求依据。发送给模型的上下文可有明确长度预算，但不能覆盖原文。

`Constraint` 包含 `id / kind / value / origin / strength / basisRef / validationStatus / revision`：

- `origin`：`explicit_input`、`system_policy`、`planner_suggestion`、`legacy_unknown`。
- `strength`：`required`、`preferred`。
- `basisRef` 指向入口输入的区间或代码策略 ID/版本。输入来源由程序入口赋值，不采信模型自报。
- 显式结构化约束和可确定识别的自然语言限制可以进入硬约束；模型抽取的条件要验证依据。原文跨度存在只是必要条件，不证明语义蕴含。
- 不确定的潜在用户约束保留为 `unresolved_request_constraint` 并说明解释限制，不静默删除，也不擅自升级。研究可继续，不能宣称请求已完整满足。
- profile 全局 `requiredHosts / requiredSourceTypes / minIndependentSources` 和各 slot 的 `evidenceCriteria` 一并治理，不能只限制其中一个入口。

`ResearchPlan` 包含版本、问题列表和规划变更记录。`AnswerTask` 区分 `fact / comparison / derived_judgment`，记录 `origin / required / subjectRefs / constraintIds / parentTaskId`。代理新增方向默认是计划项。

为开放式问题保留一个面向原始问题的回答义务及最低交付检查：确实回答研究对象、给出有证据的核心信息、披露关键未知。不能因为所有展开项都变为建议，就让空报告或零证据通过。具体调查维度由计划决定，不硬编码每个产品都必须有 11 个槽位。

入口兼容：引擎继续接受字符串与已有结构化 query；新增明确的 `planningContext` 通道。CLI 增加 `--planning-context <json-file>`，只提供派生问题/身份线索/阅读提示，不具有声明用户硬约束的能力。Web API 增加相同的可选字段；现有文本框无需增加复杂配置界面。面向用户的 query、历史标题始终使用原始问题。

### 3.2 文档、证据与检查覆盖

建立 run 内 `EvidenceStore`，使用内存 Map 和现有 recorder 的内容寻址 blob 持久化：

| 对象 | 关键字段与职责 |
|---|---|
| DocumentIdentity | `sourceId / canonicalUrl / redirectAliases`，表示来源身份 |
| DocumentVersion | `documentVersionId / sourceId / bodyHash / bodyRef / extractionVersion / retrievedAt / coverage / evidenceOrigin`，表示不可变正文版本 |
| Passage | `passageId / documentVersionId / startChar / endChar / textHash / section / neighborIds` |
| Association | `taskId / documentVersionId / passageIds / relevance / assessment`，表示某问题对文档的独立准入 |
| Inspection | `taskId / questionRevision / criterionRevision / documentVersionId / checkedRanges / verdict / missingFacets` |

位置采用 JavaScript UTF-16 区间 `[startChar,endChar)`，锚定该版本不可变的提取正文；不冒充原始 HTML 字节位置。分块、清洗算法改变要改变版本。相同 URL 的不同正文不可混合；相同文字位于不同位置时片段 ID 也不同。

成功正文按版本存储一次，问题只加关联。`findings` 不再是第二份证据事实源；旧调用方需要嵌套 sources 时在兼容出口物化。一个来源是否是“第一方”必须相对目标实体判断，不能因为 URL 在 github.com 就全局认定官方。

`bodyRef` 必须在所属结果版本中可独立解析。运行时可引用 recorder blob；提交结果时将引用到的正文版本纳入 revision 自有的内容寻址文件集合，manifest 记录并验证全部引用文件的 hash。Intel snapshot 同样复制完整引用集合，不依赖 session 的存续或绝对路径。缺失正文、越界路径和 hash 不匹配明确失败；新消费者不能回退到旧 `findings.sources.content` 充当证据真值。`--no-work-dir` 的内存/JSON 导出携带按 hash 去重的内联文档表，使引用无需本地文件也能解析。

检查覆盖状态为 `not_checked / checked_without_support / supported / contradicted`；正文未完整抓取、提取截断、仅 summary 另行标记。未命中检索片段不能被传播成“全文不存在”或“公开资料不存在”。

### 3.3 主张、推导和展示

`ClaimRecord` 保存稳定 `claimId / revision / kind / proposition / supportRefs / counterRefs / evaluation / conditions`。类型包括事实、来源自述、推导；由受控主张构建流程确定，模型不能在写报告时改角色绕过验证。

- 事实和来源自述绑定文档版本/片段；“官网声称支持”不能自动变成“已实测支持”。
- 推导增加 `premiseClaimIds / inference / assumptions / uncertainty`；前提需成立，验证推导是否过度外推，拒绝循环依赖。比较按各对象证据形成比较结论。
- `SlotBinding` 单独保存 `taskId → claimId / adequacy / missingFacets`，共享主张不删除问题绑定。
- `NarrativePlan` 只保存段落、`claimId`、`localizedText` 和展示位置。措辞改变不改变主张身份；改变主张含义必须新 revision 并重新验证。

### 3.4 动作与执行结果

`Action` 包含 `actionId / type / targetTaskIds / inputRefs / expectedEvidence / evidenceDependencies / constraintRevision / status / attemptCount / nextEligibleAt / receiptRef`。

首批动作类型：`inspect_document`、`read_candidate`、`search`、`check_conflict`。队列初始最多 8 个待执行动作；一次规划直接给出完整动作和查询。`finalize` 是程序基于状态作出的决策，不是模型自报的成功动作。

`ActionOutcome` 分开记录：

- 执行：`succeeded / failed / skipped / interrupted / outcome_unknown`。
- 检索覆盖：返回数量、新候选、新问题关联、新文档版本、新检查区间。
- 证据进展：新支持/反证、缺失事实减少、问题是否获得答案。
- 错误：结构化 `errorCode / retryable / failureClass`。

失败键由动作类型、标准化输入、目标问题、相关证据版本、约束版本组成，不含不断变化的全局 step/token/时间。相关新证据到达才解封对应动作；不相关网页变化不能重开所有失败。

## 4. 实施阶段与交付标准

每阶段形成可独立检查的变更，先通过定向回归再进入下一阶段。新流程默认切换放在最终集成之后；不要求在中间状态运行昂贵调研。

### 阶段 0：冻结基线与建立回归样例

- 记录当前工作区基线和已有修复范围，不覆盖未提交修改。
- 将本次已确认问题做成最小合成 fixture：许可证跨分块、中文问题/英文查询、多问题引用同文档、合同凭空加严、A 问题卡住而 B 可继续、原文长引文导致重复。
- 原始实测正文只用于本地诊断/对照；不把整个会话或第三方长文复制进测试仓库。
- 记录旧基线：494,644 探索 token、37 次查询规划、14 次搜索、28 次阅读尝试、41 次查询拒绝、11 分钟片段准备、136,140 字符报告。
- 先跑当前基线的现有测试、lint/build，记录已存在失败；新增缺陷 fixture 在对应阶段修复前应准确复现失败。

完成标准：测试能复现行为问题，不依赖 Google、真实 LLM、密钥、绝对时间或特定产品名称。

### 阶段 1：输入来源、合同强度与任务类型

改动：`research-brief.mjs`、`research-contract.mjs`、`adaptive/research-profile.mjs`、`research-profile-prompt.mjs`、`evidence-criteria.mjs`、`gap-state.mjs`、`adaptive/readiness-gate.mjs`；入口涉及 `ResearchRunner`、`src/cli.mjs`、`src/cli-utils.mjs`、`src/cli-research-run.mjs`、`src/api/app.mjs`、`src/jobs/job-runner.mjs`。

- 实现 3.1 数据模型和输入通道，先验证字段再调用外部服务。
- 合同冻结后，规划器只能调整计划项，不能修改硬约束；所有计划变化留记录。
- 将 `evidenceCriteria` 映射为有来源的约束/偏好；正式需求、期望证据和来源排名不再共用一组无来源字符串。
- 任务按事实/比较/推导分别判断，不再用整份 `brief.queryShape` 决定所有槽位的评价方式。
- 默认新合同不能凭模型推荐增加 `mainstream_media`。用户确实要求该类来源时必须保留。

完成标准：模型伪造来源、缺失/错误 basis、全局 profile 加严均被拦住；显式用户约束不被软化；开放式请求仍有最低回答义务；超过 1,000 字符的原始请求完整保留。

### 阶段 2：统一证据身份、正文版本和问题关联

改动：新增 `evidence-store.mjs` 与兼容适配模块；接入 `source-enricher.mjs`、`strategies/exploratory-read.mjs`、`slot-promotion.mjs`、`adaptive/research-state.mjs`、`gap-slot-support.mjs`、`evidence-chain.mjs`。

- 正文读取后先注册版本，再把引用关联到目标问题；其他问题复用时仍独立检查相关性和证据条件。
- 同一来源不能靠“正文更长”覆盖旧版本；支持结论绑定实际使用的版本。
- 统一 evidence/passage ID 分配，补齐同一片段被多个问题使用时的双向关联。
- 内部读取迁移到 EvidenceStore；旧 findings 只作为输入适配和输出投影，不在流程中反复复制全文。
- checkpoint 保存正文版本、覆盖和关联；`--no-work-dir` 使用相同内存结构，不依赖磁盘才能运行。

完成标准：同 URL 内容变化、重复文字不同位置、重定向、转载相同正文、summary-only 均不混淆；来源唯一数、正文版本数和问题关联数可分别统计。

### 阶段 3：定向补证、分块选择和向量复用

改动：`passage-utils.mjs`、`passage-selector.mjs`、`gap-slot-support.mjs`、`evidence-chain.mjs`、`research-providers.mjs`；新增文档检查器及 run 内向量缓存。

- 按段落/句子边界切分，超长段落采用有界重叠；保留邻接关系和准确位置。
- 选择优先覆盖缺失事实，来源多样性只在支持质量接近时作为次级排序；禁止同一页多个直接答案被固定 topK/每来源一块策略全部挤掉。
- `partially_supported` 输出结构化 missingFacets，并产生 `inspect_document` 动作：在已读版本检索尚未检查的段落、扩展断句邻接，再决定是否需要外部搜索。
- 每次检查记录范围和结果；相同问题/约束/正文版本/片段子集的评估复用缓存，不能对同一遗漏子集无限重判。
- 分开正文与问题向量。缓存键含 provider endpoint 标识、model、维度、文本 hash、提取/分块版本；不包含明文凭据。并发请求共用 in-flight Promise。
- 缓存 run 内隔离；保存成功向量作为可再生 blob 供续跑复用，缓存丢失允许重算，不能影响证据真实性。失败不永久缓存。
- 向量请求采用有界并发，默认 2；连续超时/暂时服务错误按 provider 冷却，当前排序降级为本地方法。取消和预算异常直接向上传播，不吞掉。

完成标准：跨块许可证 fixture 无新增搜索即可补齐；同文档跨多个问题的相同正文块向量最多计算一次；更换正文/模型会重算；跨语言检索失败只表示未选到，不能宣称证据不存在。

### 阶段 4：查询准入、局部失败与动作调度

改动：`search-query-planner.mjs`、`adaptive/source-policy.mjs`、`query-memory.mjs`、`adaptive/slot-repair-scheduler.mjs`、新增 `adaptive/action-scheduler.mjs` / `action-outcome.mjs`；复用 `exploratory-search.mjs`、`exploratory-read.mjs` 执行器。

- 硬准入仅处理空查询、内部标识泄漏、明确输入限制、local/site 策略冲突、已确认执行过的相同查询等确定条件。
- 词面或跨语言相关性不足标记 uncertain 并降序，每轮派发最多执行 1 个 uncertain 查询，收到执行反馈后进入下一轮；其他查询留队轮转。额度随派发轮次恢复，不要求再次规划，不允许同批剩余查询永久饥饿；仍受搜索总预算与局部失败上限约束，结果必须通过实体与正文核验。
- 搜索身份包含标准化查询、provider 和实际有效参数。相同搜索跨问题复用 SERP 后重新关联；相似查询不等于相同请求。被拒绝而未执行的查询不记作已搜索。
- 先用规则生成明确可执行动作；需要新角度时一次调用规划器填充队列。队列仍有合法工作时不逐步调用 decide 再 plan。
- 硬要求优先，同层优先已读材料补证、可用候选读取；使用成本和等待轮次避免饥饿。提供新证据只更新受影响动作，不清空整个队列。
- 确定性失败不在相同条件下重试；临时错误沿用 provider 的 retryable/退避；规划失败沿用每目标上限 3。只有一个问题全部当前路径耗尽才将其封存并转向其他问题。
- 将执行成功、新候选/检查覆盖、证据增量分开。重复 SERP 或重复正文不作为证据进展；排除了先前未检查的假设可算覆盖进展，但不记作支持证据。
- 按动作检查预算：搜索额度仅限制搜索；本地补证若不需要 LLM 则不消耗 LLM；需要评估时仍受 LLM 硬预算约束。

完成标准：中文问题的合理英文查询可执行，同名其他产品不能验证结论；A 失败后 B 继续；队列中已有 4 个动作时不额外进行 4 次 decide+plan；同一队列的 3 个 uncertain 查询可在无重新规划的情况下依次完成；状态不变时相同拒绝不会反复消费模型。

### 阶段 5：预算、检查点、取消与旧会话恢复

改动：`strategies/exploratory-loop.mjs`、`strategies/exploratory-finalization.mjs`、`budget-manager.mjs`、`adaptive/budget-view.mjs`、`adaptive/research-state.mjs`、`run-recorder.mjs`、`resume-plan.mjs`、`ResearchRunner.resume`、CLI resume 分支。

预算规则：

- 移除 token 下限对局部失败封存的干预；`readiness.pass && floor.met` 才允许正常 `evidence_sufficient` 收尾。
- 证据基本充分但未达下限且仍有有意义的动作时，开展反证、版本核对或独立验证；没有路径时不生成无意义问题或重复规划来凑 token。
- 保留顶层 stopReason 枚举，新增具体 stopDetail：`action_frontier_exhausted`、`no_state_change`。安全阀只在调度器盘点完整队列且无可继续进展时结束全局，不由单个问题连续失败直接决定。
- 增加独立 `floorStatus=met|unmet|unknown`、`floorShortfallTokens` 和必要的未知用量说明。报告与校验费用分列；provider usage 不可观测时不能宣称精确达标。
- 现有 6 次安全阀保留为无状态变化调度周期的上限；一次周期需要检查其他可执行动作，计数定义同步文档和测试。

动作恢复协议：

1. 派发前持久化 actionId、attemptId、依赖和 attempt 级预算预约；硬预算准入同时计入已确认消耗与未核销预约。
2. 外部调用完成后先保存结果/错误及 receipt；完整正文和大结果走 blob。
3. 应用结果后保存 `appliedReceiptIds`、队列、文档/证据变化和预算账目。
4. 恢复时已知 receipt 按 attemptId 核销预算并只应用一次，已完成动作不重新执行；最新动作边界必须参与 resume 选择，不能被旧 step 或旧最终结果盖掉。terminal stop 是所属执行段的持久状态，晚到 receipt 只能归并结果，不能重新开放派发；只有显式 `--continue-explore` 创建新执行段才能继续探索。
5. 请求已发出但无可恢复响应时标 `outcome_unknown`，未核销预约在恢复后继续占用预算；只读请求有界重试必须另行预约并保留尝试记录。费用无法合理界定时标记 budget unknown，阻止可能突破硬上限的重试。不能承诺网络侧 exactly-once，也不能释放旧预约来伪造完整剩余额度或精确用量。
6. Ctrl+C 停止派发并传递 signal；可保存已到达回执，不继续执行后续动作。原有 CLI 130 退出、Web cancel 与 js-eyes 子进程清理语义保留。

旧会话：

- 完成 checkpoint 的 `commit-result` 仍直接提交/交付原结果，零搜索、零 LLM，不按新语义重建。
- 旧 terminal step/loop 默认只进入报告流程；`--continue-explore` 仍需有界 extra steps。
- 旧未收尾 step 可以在内存加载时转为新 state；合同标 `legacy_unknown` 并冻结原强度，导入真实正文后生成队列，留下迁移记录。
- 旧 quote 只有在对应旧正文版本重新锚定成功时才导入为新直接证据；只有 summary 的来源保留 summary 身份。
- 旧最终结果/报告使用 v1 兼容路径，不根据新版偏好删除 mainstream_media 等历史条件。修订研究要求应启动新 run；本次不增加自动“重签旧合同”的功能。
- 续跑新增一个执行段并记录其结果，保留原 stop 历史，不把旧 safety_cap 改写成 evidence_sufficient。额外步数按实际动作执行尝试计，不把子调用数当步数；已有预算不归零。

完成标准：执行前、外部响应后、应用前、应用后、结果提交前后各崩溃窗口均可恢复；已应用结果和已知用量不重复入账；未知尝试的预算预约不丢失；terminal stop 后晚到回执不能让普通 resume 重启探索调用；全局终止不会跳过仍有预算的合法本地补证。

### 阶段 6：主张验证与报告单向生成

改动：`report-plan.mjs`、`report-contract.mjs`、`report-builder.mjs`、`report-narrative.mjs`、`report-evidence.mjs`、`report-preparation.mjs`、`report-finalizer.mjs`、`claim-quality.mjs`、`claim-entailment.mjs`、`citations.mjs`、`report-assembler.mjs`。

流程固定为：证据/问题绑定 → 主张与推导验证 → 冻结 ReportPlan → 模型提交 ID 对应的中文表达 → 表达一致性检查 → 确定性渲染。

- 模型只修改允许的表达与结构字段，不修改证据引用、claimId、任务强度或评价。
- 使用已验证 claim ID 进行修订，取消新流程中“从 Markdown 重新抽主张、按字面相似度补回绑定”的往返。Markdown 解析保留给历史输入和旧格式导入。
- 事实、来源自述、推导分别验证；推导的前提失效时沿依赖重新评价，不能继续沿用旧结论。中文措辞检查保留数字、否定、版本、时态和条件。
- 报告阶段发现原 verified 主张有冲突：将其绑定改为待复核/受限，同步重新计算受影响的问题状态、readiness、质量结果及推导依赖，生成同一结果 revision 下的新合同评价快照和限制，不为保留 slot 把矛盾原文强行塞回。原冻结快照保留，不允许模型直接修改；报告、质量状态和绑定不能分别保留互相冲突的结论。
- 每个必答问题都有答案或明确限制。多个问题可复用同一主张/来源，但所有绑定独立验证；文字去重不能消除某个必要绑定。
- 注册稳定 citation registry，继续采用 `[n.m]` 显示形式降低兼容成本，但编号由 registry 分配，不再代表 finding/source 数组坐标。结果修订中保留已有编号，新引用追加。
- 每条主张只引用实际支持的文档版本/片段，禁止因同 URL 或正文含 quote 自动收集所有引用别名。
- 主报告只展示摘要、结论、条件/限制和去重来源索引。完整证据放独立 `evidence.md` 和结构化产物；正文不重复打印 GitHub 导航等噪声。
- 保留 provider/parse/semantic-contract/render 的独立有限重试、安全错误元数据和失败落盘规则；已知结构错误本地修正，语义问题只重试受影响的表达或主张，不反复重写全文。

完成标准：中文请求的结论为中文；引用和片段锚点可解析；跨槽绑定不丢失；矛盾事实不被补回为 verified；相同来源不随问题数量线性重复展开。

### 阶段 7：产物、消费者、质量指标和 Google 摘要

产物与保存：

- 新版本新增 `evidence-index.json`、`citations.json`、`evidence.md` 及 revision 自有的证据正文 blobs，加入结果 manifest 完整性校验；按 3.2 验证全部引用文件，不能只保存索引。
- `result.json` / `report-plan.json` 携带新 schema 与必要引用。内部以 canonical evidence/claim 为准，CLI/API/旧工具在边界获得兼容投影；不得在计算流程中重新引入 findings 全文复制。
- 保留现有 `sources.json / findings.json / claims.json / passages.json` 出口，补充稳定 ID 和版本字段；旧字段仅为兼容视图，不能作为新引用身份来源。
- SQLite 历史仍按 URL source_key 保存来源快照；同 URL 的多个正文版本由 evidence index 保存，不通过取消数据库唯一约束解决。
- intel snapshot 归档新结构、证据索引和被引用的全部正文版本，移走原 session 后仍可核验片段锚点；Wiki 按主张角色区分事实与建议，使用显式引用注册表，不能把推导当成原文事实。
- 保留 `ResultCommitService` 同事务、`.writer.sqlite`、`completeResearch` 交付隔离、immutable revision 和 snapshot 发布顺序。

消费者：

- `src/storage/intel-store.mjs`、intel import/inspect、`packages/js-wiki-engine/src/source-adapters/intel-store.mjs`、Wiki 编译与引用处理。
- `web/src/results.mjs` 等结果页保留简洁展示：执行状态、研究完整性、探索 token/下限、停止原因、报告与证据入口分别显示；不把内部 schema、调度队列塞进普通用户流程。
- API 根据数据库已提交的 `resultRevision / resultManifestPath` 加载同版本的报告、引用注册表和证据。在数据库提交成功而 `result-current` 发布失败的窗口，不读 session 当前指针或根目录拼接引用；文件缺失明确返回交付/完整性状态，不能返回跨 revision 混合结果。旧记录走显式 legacy 分支。
- benchmark 的 `load-artifacts / citations / claims / aggregate / strategy-effectiveness / compare-strategies` 优先读取 typed claims 和 registry；legacy 文件才回退 Markdown/坐标解析。
- 新报告证据附录缺失或引用损坏属于完整性问题，不能退回根目录旧报告冒充成功。

指标统一：

| 类别 | 单独记录的指标 |
|---|---|
| 请求与合同 | 显式硬约束数、计划项数、未确认请求约束、各问题完成状态 |
| 文档与证据 | 唯一来源、正文版本、片段、问题关联、未检查范围、新支持/反证 |
| 调度 | 规划调用、执行动作、确定拒绝、暂时错误、队列复用、局部封存、无进展周期 |
| 性能 | 正文/问题 embedding 输入数、缓存命中、各阶段耗时和实际 provider 调用 |
| 预算 | 探索/报告/评估 token、floorStatus、剩余额度、未知用量 |
| 报告 | 主报告/证据附录字符数、唯一引用、绑定覆盖、冲突/未验证主张 |

不再把 86 个来源关联称为 86 个唯一来源。升级指标版本；只有相同指标定义可以比较。官方确定性审计继续与 LLM supported rate 分开，不能用内部语义评分代替事实正确率或成本效率分母。

Google 独立改动：读取兄弟仓库适用 AGENTS/skill；修复 `skills/js-google-ops-skill/lib/serp/parsers.js`，在单个结果卡片中提取标题和描述，缺失描述就明确为空。测试标题超过 20 字符、无摘要、多个相邻卡片、重复链接、不同布局，以及 consent/CAPTCHA 的既有停止行为。不得跨卡片补正文、不得绕过验证。该变更单独记录版本，与本仓库主流程改造分别比较。

完成标准：CLI JSON、Web、history、intel、Wiki、benchmark 均可读取新旧结果；新来源和引用不重复；Google 返回摘要时内容来自正确卡片，无摘要时不伪装成功。

### 阶段 8：集成验证、真实运行与默认切换

- 各模块通过定向测试后跑完整 `npm test`、`npm run lint`、`npm run build`、`git diff --check`。
- 先做受限真实冒烟验证 provider 参数、Google、正文、报告与保存链路。冒烟使用较小单次预算，明确不能充当 60 万验收。
- 完整实跑 A 使用前次实际扩写查询、相同模型/provider/搜索 skill 配置，新 run 从头运行；不续跑旧状态，不悄悄减少输入要求。
- 完整实跑 B 使用用户原始短问题，身份线索和代理提纲通过 planningContext 传递，验证派生方向不会升级成用户硬约束。
- A/B 每次明确探索下限 600,000、上限 1,000,000，仅 flags 覆盖；报告/评估独立统计，不替换模型来掩盖工程改进。
- 公网搜索随时间变化，因此在线结果为两次实测记录，不能当作严格因果 A/B。确定的性能/质量回归首先由冻结输入与合成 fixture 验证。
- 验收失败先定位根因，保留失败产物和差异记录；不自动扩大次数帽、修改旧合同或连续无界重跑。
- 默认新 run 切到新流程前，完成以下验收矩阵、消费者检查和文档更新。旧数据解析/交付兼容路径保留，不强制重写历史。

完成标准：新流程正确使用已有证据、执行有意义动作、保持来源与主张完整性，并按真实情况报告预算是否满足。任一次完整运行探索未达 600,000 都标记预算验收未通过，即便报告已成功保存。

## 5. 版本迁移、发布与回退

| 数据 | 迁移决定 |
|---|---|
| ResearchBrief | v2 → v3，新增请求引用、来源和计划关系；旧值只读适配 |
| Gap | v5 → v6，区分任务类型、关联证据与运行阻塞 |
| ResearchState checkpoint | v1 → v2，加入证据引用、覆盖、队列、回执游标和冻结策略版本 |
| EvidenceStore / Scheduler | 首版独立 schema v1；各自序列化/校验，不依赖对象原型落盘 |
| ReportPlan / ReportContract | v1 → v2，采用 claim ID、独立绑定、表达字段与评价修订 |
| Citation registry | 新 schema v1；旧 `[finding.source]` 只在 legacy adapter 解释 |
| Artifact manifest | v1 原 12 文件规则保留；新 v2 明确所需/可选文件、动态证据 blob 清单及 hashes |
| Quality metrics | v4 → v5，显式区分唯一实体与关联数、预算下限与研究充分性 |

当前 `result-artifacts.mjs` 读取 manifest 会遍历代码中的固定 FILES 列表。必须先实现按 manifest schema 分派再新增文件，否则会破坏所有旧 manifest v1。

- 旧 manifest、result revision、intel snapshot 只读不改；迁移发生在内存或新的 checkpoint/result revision。
- v1 按原文件集合验证，v2 按其固定 schema 验证全部必需文件并检查附加证据引用；未知版本、hash 错误、越界路径明确失败，不静默回退。
- 新引用注册表在 CLI/API 返回与产物中均明确提供；消费者不能仅凭沿用 `[n.m]` 显示语法继续猜坐标。
- 新流程使用一个内部 `executionVersion` 记录在 run/checkpoint；避免大量相互组合的永久 feature flags。中间版本仅测试；最终新 run 默认新版。
- 回退通过停止新运行、切回已有实现启动新 run；已开始的新版 run 由支持其 schema 的版本恢复。旧二进制遇新版状态应拒绝，不能尝试降级读取。
- 不增加后台批量迁移、自动清理旧版本或跨 run 公共向量缓存。本期只保证可恢复和可验证，磁盘 GC 另行设计。

## 6. 测试与验收矩阵

| 范围 | 必须覆盖的行为 |
|---|---|
| 请求来源 | 长输入完整、代理提纲不变硬需求、模型伪造来源/required、无效 basis、profile 全局加严、显式用户限制保持 |
| 最低交付 | 开放问题不能空集通过；事实不足如实说明；建议不要求媒体原文，但前提不足不能强推结论 |
| 文档身份 | 同 URL 新旧正文、同文本不同位置、重定向、转载、局部提取、summary-only、无 work-dir 内联导出独立解析 |
| 定向补证 | 答案跨分块、中英跨语言、同页多个事实、邻接扩展、检查范围可恢复、无新增搜索补齐许可证 |
| 向量缓存 | 多问题同正文一次计算、并发去重、模型/内容变化失效、失败可恢复、超时降级、取消/预算不中途吞掉 |
| 查询准入 | 合理英文查询、未执行拒绝不污染搜索记忆、完全重复跨问题复用、语义相似保留、显式限制和 local/site 不被绕过 |
| 调度 | A 卡住 B 继续、相关版本变化局部解封、重复 SERP 不算证据、未检查范围排除可算覆盖、队列已有动作不重复规划、同队列 3 个 uncertain 可逐轮完成 |
| 预算 | 不足下限可局部封存、有其他动作不全局停、搜索额度尽仍可本地检查、达到下限但证据不足不称充分、用量 unknown 不假报 met、未知尝试预约保留且重试另行预约 |
| 恢复 | 动作/网络/回执/应用各崩溃点、取消、最新动作覆盖旧 step、commit-only 零外部调用、terminal 后晚到 receipt 不重新开放探索 |
| 主张与报告 | 事实/自述/推导差异、否定数字版本翻译不变、前提失效传播、无循环依赖、必需绑定保留、冲突不强行补回 |
| 引用 | 多问题共用文档不膨胀、同来源不同版本不误合并、registry 稳定、旧坐标引用可读、附录/正文引用全部解析 |
| 保存与消费 | v1/v2 manifest、正文引用集合完整性、移走 session 后归档可独立验证、损坏拒绝、未提交版本不发布、DB报告/来源同事务、发布失败窗口 API 报告/引用/证据同 revision、重复交付幂等、archive/output异常独立、Wiki/benchmark兼容 |
| Google | 卡片范围内摘要、长标题不替代描述、空摘要、布局差异、相邻卡片隔离、挑战页不绕过 |

优先扩展已有测试：`research-profile.test.mjs`、`gap-slot-support.test.mjs`、`passage-utils.test.mjs`、`passage-selector.test.mjs`、`search-query-planner.test.mjs`、`slot-repair-scheduler.test.mjs`、`exploratory-budget.test.mjs`、`exploratory-readiness-loop.test.mjs`、`exploratory-resume.test.mjs`、`resume-plan.test.mjs`、`report-pipeline.test.mjs`、`report-contract.test.mjs`、`report-premise.test.mjs`、`claim-quality.test.mjs`、`result-artifacts.test.mjs`，以及应用层 commit/delivery/CLI/intel/Wiki 测试。新增 EvidenceStore、scheduler receipt、版本适配的行为测试。

确定性硬门槛：

1. 无模型擅自增加的用户硬条件，明确用户条件不丢失。
2. 实际可得的跨块事实可被选中、锚定；没有证据时不伪造答案。
3. 必需绑定和实际引用解析率 100%，无摘要充当正文，无冲突事实被补回 verified。
4. 同正文块跨问题最多一次成功 embedding；已填充动作队列无需每动作再次规划。
5. 保存/恢复/取消和新旧产物兼容全部通过；同 revision 再交付零 provider 调用。
6. 成本和唯一来源等计数按新口径自洽；预算未满足如实显示。
7. 报告正文不打印逐 finding 的证据 dump，同一来源不因问题增多而重复列出。

性能改进验收以调用/重复输入计数为主。规划 token 占比、47 分钟总耗时、11 分钟片段准备、13.6 万字符报告作为观察基线，不给易变公网延迟设置脆弱的绝对通过阈值。减少篇幅不能以删除必要答案或证据绑定实现。

实测内容复核至少包含：产品身份无混淆；许可证与软件费用/外部服务费用区分；官方宣称不等于实测；反馈不足如实说明；采用建议有前提和条件。不得硬编码 Open Science、AIPOCH 或 Apache 来让样例通过。

## 7. 依赖、并行与交付物

依赖顺序：`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`。其中阶段 4 的查询准入、阶段 5 的预算局部失败修复可在阶段 1 的类型定义完成后先做，但新队列上线必须等证据补查及恢复协议齐备。

可并行的边界：

- 请求/合同与 Google DOM 摘要修复独立。
- EvidenceStore 类型确定后，分块/补证和向量缓存可并行，统一由证据层集成。
- ClaimRecord/registry 类型冻结后，报告生成与 CLI/Web/Wiki/benchmark 读取适配可并行。
- scheduler 状态定义后，执行器改造与崩溃恢复测试可并行；共用 `ResearchRunner / ResearchState` 的改动安排单一集成负责人，避免共享文件冲突。

每阶段交付：代码及行为测试、schema/兼容说明、已完成检查结果、未解决风险。最终交付：更新 README/AGENTS/CLI help、设计 journal、离线对照、两次完整实跑审计与交付一致性结果。

## 8. 主要风险与处理决定

| 风险 | 处理 |
|---|---|
| 来源规则变软后错误产品进入候选 | 查询阶段只允许尝试；实体、正文和最终主张仍严格核验，记录不确定相关性额度 |
| 计划项全变可选导致过早收尾 | 保留原始问题回答义务、明确用户条件和最低交付检查；计划完成不等于请求完成 |
| 推导类型被用来规避证据 | 类型由主张构建流程控制，前提引用和推导一致性必须验证，前提失效传播 |
| 新证据身份破坏旧引用/续跑 | 多版本 reader、legacy adapter、manifest 分派，旧合同/已发布结果不变 |
| 缓存错误影响结论 | 完整键、文档版本锚定、维度验证、失败不永久缓存；缓存可丢但真值不可丢 |
| 动作回执后崩溃重复计费/应用 | 稳定 action/attempt/receipt 和应用游标；已知结果幂等，网络未知明确标记 |
| 为达到 60 万继续空转 | 下限只控制正常收尾；有效路径耗尽保留失败，预算验收不通过并诊断 |
| 用换题或换模型掩盖改进效果 | 冻结输入离线对照、原扩写实跑、原始意图实跑分别报告，记录代码/provider版本 |
| 改造范围过大 | 各阶段可验收，复用执行器/SQLite/recorder/交付链路；不引入新存储系统或多套长期配置组合 |

阶段 0–8 已执行；真实运行、恢复补丁与最终交付边界以实施与验收记录为准。
