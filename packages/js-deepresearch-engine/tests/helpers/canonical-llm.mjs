import { defaultSearchQueryPlan } from './search-query-planner-mock.mjs';
export const body = 'The Atlas tool processes local documents. The publisher states that Atlas is distributed under the MIT license. Users can run Atlas locally and inspect its source code.';
export function canonicalLlm({ onCall = () => {}, conflict = false } = {}) {
  return {
    async completeWithMetadata(args) {
      onCall(args);
      const { purpose, messages } = args;
      const user = messages.find((item) => item.role === 'user')?.content || '{}';
      let data;
      try { data = JSON.parse(user); } catch { data = {}; }
      let value;
      if (purpose === 'research_profile') value = { requiredAnswerSlots: [{ question: 'Atlas license', answerSlot: 'license', requiredSlot: true }], minIndependentSources: 7, requiredSourceTypes: ['mainstream_media'] };
      else if (purpose === 'search_query_planning') return { text: defaultSearchQueryPlan(messages), usage: { totalTokens: 100 } };
      else if (purpose === 'gap_support') {
        value = { judgments: [...user.matchAll(/gapId: ([^\n]+)/g)].map((match) => ({ gapId: match[1], verdict: 'supported', answer: 'Atlas 的发布方称，该工具可以在本地处理文档，并以 MIT 许可证分发。', quote: body, missingFacets: [] })) };
      } else if (purpose === 'claim_validation') value = { judgments: data.claims.map((claim) => ({ claimId: claim.claimId, verdict: conflict ? 'conflicting' : 'supported' })) };
      else if (purpose === 'report') value = { summary: '本次调研检查了 Atlas 的项目资料，围绕工具用途、运行方式和许可条件整理了证据。结论按实际获取的正文和已检查的片段组织，区分发布方的说明与独立测试。报告中的产品描述属于来源自述，不能据此推断所有使用环境下的实际表现。当前材料没有覆盖的问题会作为限制单独列出，读者可以使用报告引用回查对应的文档版本和证据片段。对于未检查的部署环境、性能指标、服务承诺及使用体验，本报告不作额外确认，也不据此推断产品不存在相关能力。', renderings: data.claims.map((claim) => ({ claimId: claim.claimId, text: 'Atlas 的发布方称，该工具可以在本地处理文档，并以 MIT 许可证分发。' })), limitations: data.limitations.map((item) => ({ taskId: item.taskId, text: '这个问题仍缺少足够证据，现有材料不能支持完整回答。' })) };
      else if (purpose === 'narrative_validation') value = { sameLanguage: true, summaryFaithful: true, limitationsFaithful: true, judgments: data.claims.map((claim) => ({ claimId: claim.claimId, faithful: true })) };
      else if (purpose === 'gap_decomposition') value = { subQuestions: [] };
      else if (purpose === 'source_assessment') value = { relevance: 'relevant', summary: body, contentKind: 'documentation', publisherType: 'first_party', keyFacts: [body] };
      else throw new Error(`Unexpected v2 purpose: ${purpose}`);
      return { text: JSON.stringify(value), usage: { totalTokens: 100 } };
    },
  };
}
