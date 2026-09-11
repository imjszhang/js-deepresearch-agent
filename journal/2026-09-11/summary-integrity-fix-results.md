# 评测汇总完整性误报修复与验收

日期：2026-09-11。修复上轮真实产物回归发现的唯一失败：报告引用无法解析、文件哈希仍合法时，summary 错误计入已验证产物。

## 修复

`scripts/benchmark/quality/compare.mjs` 的汇总现在按 campaign 固定的 pin 调用完整 `verifyArtifact()`，将当前结果分别记为 passed、failed、incomplete。只有 passed 计入 `artifactVerifiedRuns`，同时输出失败数、不完整数及逐行完整性状态。

成本读取状态与完整性校验分开。成本可以从合法 manifest 或历史评分读取，但不再授予验证通过；历史缓存里的 passed 也不能绕过当前校验。没有 pin 的记录保持 incomplete，不跟随会话当前指针推断版本。历史评分、计划分母、交付状态、未观察状态均保留。

新增 `tests/benchmark-summary-integrity.test.mjs` 的四项回归，纳入 V19 必跑场景：合法哈希下的坏引用、缓存通过后正文损坏及缓存误报、固定旧版本与无 pin、四个 CLI 入口的一致性。

## 验收结果

| 验证 | 结果 |
|---|---|
| 针对性测试 | 58/58 通过 |
| 完整 `verify:programmatic` | 1,238/1,238 通过：engine 704、wiki 20、应用及评测 514；无失败、取消或跳过 |
| 必跑场景 | 23 组、70 项全部通过 |
| lint / build / diff check | 全部通过 |
| 原 63 项真实产物回归 | 从 62/63 改为 63/63 通过；保留原检查与预期，仅更新新代码的验收记录路径 |
| 四个 CLI 追加复现 | 坏引用样本不再显示 artifact verified 1/1，模型仍为未观察；独立检查仍拒绝损坏产物 |
| 原始文件保护 | 原批次 16,310 个文件 SHA-256 前后一致；另核对历史保留清单 2,293 个文件，无变化 |

实际完整批次仍为 8 次计划、7 次交付、7 份通过完整性校验、1 份不完整、8 次模型未观察。注入坏引用的独立样本现在 `artifactVerifiedRuns=0`。缺正文、错误哈希、跨版本引用、错误 pin 的拒绝行为也全部通过。

主真实回归启动 35 次 CLI，追加复现启动 5 次 CLI。运行使用 macOS sandbox-exec 禁止外部网络、禁止写入原始批次，并用配置访问探针确认未读取模型设置。真实回归网络事件为 0；完整验收实际外部发送为 0、意外外部尝试为 0，8 次预期负向网络探针均被阻止。没有运行模型、搜索或重新调研。

`summary` 是展示命令，成功生成包含 failed/incomplete 状态的汇总仍返回退出码 0；需要作为门禁时使用 `verify-artifacts`，坏产物返回非零退出码。

## 记录与范围

新全量记录保存在本地忽略目录 `work_dir/programmatic-verification/summary-integrity-fix-1/`；真实回归保存在 `work_dir/programmatic-verification/real-artifact-regression-2/`。先前的全量记录和失败回归均原样保留。没有提交运行产物或原始正文。

实现身份：`d8d61df866d5f134e39d2b4f23f578dd476c9309760db73b161f2e7431961a21`。验收前后身份一致，新验收记录通过当前代码的 `requireProgramVerification()` 检查。

本次验证环境为 macOS arm64、Node v24.18.1；未运行远程 CI 或其他平台矩阵。这些结果证明所覆盖的程序合同及产物完整性行为，不代表原报告语义准确率。未提交、推送或合并分支。
