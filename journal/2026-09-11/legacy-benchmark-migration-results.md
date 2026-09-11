# 旧评测入口迁移与验收记录

2026-09-11：已完成旧入口迁移，本地统一程序化验收通过。未执行真实模型、搜索、调研或校准；未提交、推送或合并。

## 用户可见变化

`benchmark`、`benchmark:strategies`、`benchmark:extract` 三个命令名继续保留，其质量子命令统一调用 `benchmark-quality.mjs`，复用同一套评分、固定版本、预算、来源和执行门槛，不再维护另一套旧 Judge。

```bash
npm run benchmark -- <session-dir> --json
npm run benchmark -- --research-id <research-id> --json
npm run benchmark:strategies -- --sessions focused=<dir1>,exploratory=<dir2> --json
npm run benchmark -- score --mode model-observation --program-verification <record> --campaign <file> --gold-dir <dir>
npm run benchmark:strategies -- compare --baseline <campaign> --candidate <campaign>
```

已有结果的默认检查现在完全离线，不加载模型设置。`--no-llm` 是兼容别名。没有明确的题目和标准答案时，仅报告产物完整性及已记录的诊断计数，不能用关键词重合或历史 `supported` 裁决生成新语义分数。

输出升级为 schemaVersion 2：

- `artifactVerification`：固定 manifest、正文、引用注册表和已声明绑定的程序检查。
- `modelAssessment`：默认 `observed=false`、`modelThresholdsMet=null`。
- `metrics`：来源、正文版本、引用解析及原文长度等可观测计数。
- 原 `supportedRate`、有效主张裁决等语义字段不再输出；依赖旧 JSON 字段的调用者需要改读上述字段。质量评分通过显式 `score` 获取。

旧四件套、裸 JSON 或无法确认版本证据的归档标记为 incomplete，不伪造成新版有效证据。损坏的 v2 产物明确失败。命令成功返回诊断结果，不等于其中产物状态通过。

## 修复内容

1. 默认路径移除旧模型调用、已保存裁决复用和关键词支持率。三个兼容入口按解析后的首个位置参数路由新版命令，错误输出保持新版安全边界。
2. 同一次策略比较使用同一份已加载产物；归档使用已提交 manifest/revision，并核对快照证据及实际统计字段，避免混入更新的磁盘指针或同 revision 的不同内容。
3. 旧 query battery 的正则槽位及 ready/not_ready 状态仅保留为 `legacy_heuristic_diagnostics`，设置 `authoritative=false`，不作为新版工程验收或质量评分。
4. Extract 比较按 JSON 内容读取，修复文件路径被误当会话目录的问题；删除硬编码问题、时间、节省比例预测和固定结论。缺失字段在所有输出层保持 null，明确空数组和零值保留。
5. 缺失成本不当作零；未知用量显示确认下限，不能计算精确差额。主张和叙事校验归入 evaluation，不计入探索；尾段统计仅比较同阶段探索用量。
6. 比较输出不能覆盖输入，包含父目录为符号链接、目标文件尚不存在的情况。旧多策略 `--run` 在读取配置前要求当前程序验收文件，拒绝裸 flag 和已有结果目标混用。该采样模式不自动评分；冻结质量实验使用共享 plan/run/score。
7. 新增 V23 兼容入口场景，实际启动三个 CLI 验证转发、默认离线行为、未加载配置、语义来源不升级和新执行条件；同步更新帮助及项目文档。

## 实际验收

```bash
npm run verify:programmatic -- --output-dir work_dir/programmatic-verification/legacy-migration-1
```

运行时间：2026-09-11 19:49:41–19:51:04（Asia/Shanghai），约 83 秒。

| 检查 | 结果 |
|---|---|
| 引擎测试 | 704 / 704 |
| Wiki 测试 | 20 / 20 |
| 应用与 benchmark 测试 | 510 / 510 |
| 合计 | 1,234 / 1,234；无失败、取消、跳过或 todo |
| 必需场景 | 23 组，66 / 66 个固定必需案例通过 |
| 固定故障序列 | 64 个种子 × 40 步通过 |
| lint / build / diff check | 全部通过，退出码 0 |
| 验收记录消费校验 | `requireProgramVerification()` 通过 |
| 实际外部派发 / 意外调用 | 0 / 0 |
| 预注册阻断探测 | 8 次，均被阻断 |
| 测试回环连接 / 监听器 | 75 / 13 |
| 历史产物 | 登记的 2,293 个文件 SHA-256 全部未变 |

验收状态 passed，运行前后实现身份不变。当前实现身份：

```text
badeeb5e523df65780f725b7785b3dca0365740e0ff59b7885318bba429cd510
```

本轮生成新验收记录，旧记录原样保留且不会继续为修改后的实现授予资格。结果和日志位于本地忽略目录，不进入源码提交。

验证环境为 macOS arm64 / Node v24.18.1，使用 OS 外网隔离及继承的工具守卫。Node 20/22 的远端 CI 本轮没有执行。程序验收不代表真实模型准确率或调研质量已经改善。
