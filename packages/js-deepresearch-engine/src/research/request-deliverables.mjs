// Bounded syntax recognition of explicit deliverables. This parser never uses
// planner output; uncertain prose remains part of the original request.
export const REQUEST_CONTRACT_VERSION = 2;

export function explicitInputTasks(query) {
  const tasks = [];
  const occupied = [];
  function add(text, offset) {
    const leading = text.length - text.trimStart().length;
    const value = text.trim();
    const start = offset + leading, end = start + value.length;
    if (!value || occupied.some(([a, b]) => start >= a && end <= b)) return;
    occupied.push([start, end]);
    tasks.push({ id: `input-${start}`, question: value, answerSlot: value, requiredSlot: true, priority: 'critical',
      taskType: /比较|对比|区分|compare|distinguish/i.test(value) ? 'comparison' : /建议|适用场景|recommend/i.test(value) ? 'derived_judgment' : 'fact',
      basisRange: [start, end], basisRanges: [[start, end]], requiredHosts: [], requiredSourceTypes: [], evidenceCriteria: [] });
  }
  // Explicit list introducers retain existing behavior.
  for (const match of query.matchAll(/(?:系统调查|调查以下|调研以下|研究以下|请分别回答|请比较|包括以下)\s*[：:]\s*([^。；;\n]+)/g)) {
    const list = match[1], offset = match.index + match[0].lastIndexOf(list);
    for (const item of list.matchAll(/[^、，,]+/g)) add(item[0], offset + item.index);
  }
  for (const match of query.matchAll(/^\s*(?:\d+[.)、]|[-*])\s+?([^\n]+)/gm)) add(match[1], match.index + match[0].lastIndexOf(match[1]));
  for (const match of query.matchAll(/^\s*\d+[.)、]\s*([^\n]+)/gm)) add(match[1], match.index + match[0].lastIndexOf(match[1]));
  for (const match of query.matchAll(/最后给出\s*([^。；;\n]+)/g)) {
    for (const item of match[1].matchAll(/[^、，,]+/g)) {
      if (/待验证|调研限制|研究限制|不确定/.test(item[0])) continue;
      add(item[0], match.index + match[0].lastIndexOf(match[1]) + item.index);
    }
  }
  // A comma starts a new instruction only when followed by an explicit verb.
  // Commas within version/entity enumerations or a conditional clause stay put.
  const verbs = '分别列出|分别说明|列出|区分|解释|说明|比较|对比|回答|给出|explain|describe|list|compare|distinguish|identify';
  const instructions = new RegExp('(?:^|[。；;!?\\n]|[，,](?=\\s*(?:(?:and|以及|并)\\s*)?(?:' + verbs + ')))\\s*(?:(?:请|and|以及|并|please)\\s*)?((?:' + verbs + ')[^。；;!?\\n]*?)(?=[，,]\\s*(?:(?:and|以及|并)\\s*)?(?:' + verbs + ')|[。；;!?\\n]|$)', 'gim');
  for (const match of query.matchAll(instructions)) add(match[1], match.index + match[0].lastIndexOf(match[1]));
  // An explicit research noun-list requires several deliverables. Decimal
  // versions and mere entity lists are not independent answer obligations.
  for (const match of query.matchAll(/(?:^|[。；;\n])\s*(?:请)?调研([^。；;\n]+)/g)) {
    const list = match[1];
    const items = [...list.matchAll(/[^、，,]+/g)];
    if (items.length < 2 || items.some(item => /^\s*\d/.test(item[0]))) continue;
    if (!items.every(item => /限制|场景|影响|方式|机制|风险|办法|条件|选项|区别|成本|性能|许可证|部署|依赖|兼容|能力/.test(item[0]))) continue;
    const offset = match.index + match[0].lastIndexOf(list);
    for (const item of items) {
      const prefix = /^(?:\s*(?:以及|并且|及))\s*/.exec(item[0])?.[0] || '';
      add(item[0].slice(prefix.length), offset + item.index + prefix.length);
    }
  }
  tasks.sort((a, b) => a.basisRange[0] - b.basisRange[0]);
  const first = tasks[0]?.basisRange[0] ?? 0;
  const sharedContext = query.slice(0, first).trim();
  for (const task of tasks) {
    task.sharedContext = sharedContext;
    task.contextRanges = first ? [[0, first]] : [];
    task.basisRanges = [...task.contextRanges, task.basisRange];
  }
  return tasks;
}
