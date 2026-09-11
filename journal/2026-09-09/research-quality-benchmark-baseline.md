# Research quality benchmark: baseline-20260909-v2

Delivered 7/8; evaluated 2/8.

| Run | Research state | Coverage | Evidence coverage | Fact accuracy | Major errors | Floor | Confirmed tokens | Review |
|---|---|---:|---:|---:|---:|---|---:|---|
| sqlite-explicit-1 | research_complete | N/A | N/A | N/A | N/A | met | 1012668 | not_evaluated |
| redis-explicit-1 | research_complete | N/A | N/A | N/A | N/A | met | 690213 | not_evaluated |
| redis-open-1 | research_complete | N/A | N/A | N/A | N/A | met | 642666 | not_evaluated |
| sqlite-open-1 | research_complete | N/A | N/A | N/A | N/A | met | 657726 | not_evaluated |
| redis-open-2 | research_failed | N/A | N/A | N/A | N/A | met | 641307 | not_evaluated |
| sqlite-open-2 | research_complete | 0.0% | 0.0% | 0.0% | 0 | unmet | 111479 | pending_review |
| sqlite-explicit-2 | research_complete | N/A | N/A | N/A | N/A | unmet | 263573 | not_evaluated |
| redis-explicit-2 | research_complete | 0.0% | 0.0% | 0.0% | 0 | unmet | 80064 | pending_review |

Failures remain in the delivery denominator. Content scores only describe delivered reports. Machine judgments require the stated review; no human review is implied.

自动汇总：裁判 quality-judge-2 校准一致率 85%，未达到 90% 目标；所有评分仅供诊断并等待复核，没有人工确认。未完成的研究、评测和诊断保留原状态，不补预算、不删除失败样本。详细实现与已知限制见同目录 research-quality-benchmark-implementation.md。
