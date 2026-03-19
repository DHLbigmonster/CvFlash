/**
 * CVflash Background Service Worker
 * 负责 AI API 调用（避免 CSP 限制）、消息路由、截图捕获
 */

import './lib/model-config.js';

const API_BASES = {
  cn: 'https://open.bigmodel.cn/api/paas/v4',
  global: 'https://api.z.ai/api/paas/v4',
  deepseek: 'https://api.deepseek.com/v1'
};

const modelConfig = globalThis.CVFLASH_MODEL_CONFIG;

// ─── 消息路由 ─────────────────────────────────────────────────────────────────

// 填充状态管理（不依赖 popup 存活）
let fillStatus = { state: 'idle', message: '', progress: 0 };

function updateFillStatus(state, message, progress) {
  fillStatus = { state, message, progress: progress || 0, timestamp: Date.now() };
  // 广播状态给 popup（如果还开着的话）
  chrome.runtime.sendMessage({ action: 'FILL_STATUS_UPDATE', ...fillStatus }).catch(() => {});
}

function shouldReinjectContentScript(error) {
  const message = error?.message || '';
  return message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('Extension context invalidated');
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
  } catch (error) {
    throw new Error('当前页面无法注入扩展脚本，请刷新页面后重试');
  }
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!shouldReinjectContentScript(error)) throw error;
    await ensureContentScriptInjected(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function resolveProvider(providerId, apiBase) {
  if (providerId) {
    const provider = modelConfig.providers.find((item) => item.id === providerId);
    if (provider) return provider;
  }
  return modelConfig.resolveProviderByBase(apiBase || API_BASES.cn);
}

function resolveDefaultModel(providerId, apiBase) {
  return modelConfig.pickDefaultTextModel(providerId || apiBase || API_BASES.cn);
}

function normalizeAuthToken(apiKey, provider) {
  if (apiKey) return apiKey;
  return provider.requiresKey ? '' : 'local-token';
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'AI_MATCH_FIELDS':
      handleAIMatch(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'START_FILL': {
      handleFullFill(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'PRE_ANALYZE': {
      handlePreAnalysis(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_FILL_STATUS':
      sendResponse(fillStatus);
      break;

    case 'AI_CHAT':
      handleAIChat(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'TEST_API':
      testAPIConnection(msg.apiKey, msg.apiBase, msg.providerId).then(sendResponse).catch(e => sendResponse({ success: false, message: e.message }));
      return true;

    case 'PARSE_PDF_RESUME':
      handleParsePDF(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      break;
  }
});

// ─── 完整填充流程（在 background 中运行，不受 popup 关闭影响）────────────────

async function handleFullFill({ tabId, resume, apiKey, apiBase, providerId, model }) {
  try {
    // 1. 检测字段
    updateFillStatus('detecting', '正在检测表单字段...', 10);
    const detectResp = await sendToTab(tabId, { action: 'DETECT_FIELDS' });
    if (!detectResp?.fields?.length) {
      updateFillStatus('error', '未找到可填写的表单字段');
      return { error: '未找到可填写的表单字段' };
    }

    const fields = detectResp.fields;
    console.log(`=== 检测到 ${fields.length} 个字段 ===`);

    // 2. 按分区分组字段
    const sectionGroups = groupFieldsBySection(fields);
    console.log('=== 表单分区信息 ===', Object.keys(sectionGroups).map(s => `${s}: ${sectionGroups[s].length}个字段`));

    // 问题1提示：检测简历有多少条目 vs 表单有多少对应字段，提示用户是否需要手动添加更多条目
    const missingHints = detectMissingEntries(fields, resume, sectionGroups);
    if (missingHints.length > 0) {
      console.warn('⚠️ 以下简历数据可能没有对应的表单字段（建议先手动添加更多条目）:');
      missingHints.forEach(h => console.warn(`  - ${h}`));
      // 通知 popup 显示提示（非阻塞）
      chrome.runtime.sendMessage({ action: 'FILL_MISSING_HINT', hints: missingHints }).catch(() => {});
    }

    // 3. 分区块依次处理
    const totalSections = Object.keys(sectionGroups).length;
    let currentSection = 0;
    const allFieldMap = {};
    let totalAiMatched = 0;

    for (const [sectionName, sectionFields] of Object.entries(sectionGroups)) {
      currentSection++;
      const progress = 20 + Math.floor((currentSection / totalSections) * 50);

      updateFillStatus('matching', `[${currentSection}/${totalSections}] 正在处理 ${sectionName}...`, progress);
      console.log(`\n=== 处理分区: ${sectionName} (${sectionFields.length} 个字段) ===`);

      // AI 完全自主决策
      const aiResult = await handleAIMatch({
        fields: sectionFields, resume, apiKey, apiBase, providerId, model,
        sectionContext: sectionName
      });

      if (aiResult.error) {
        console.warn(`分区 ${sectionName} AI 匹配失败:`, aiResult.error);
        continue; // 分区失败不影响其他分区
      }

      Object.assign(allFieldMap, aiResult.fieldMap);
      totalAiMatched += Object.keys(aiResult.fieldMap || {}).length;
      console.log(`✓ ${sectionName}: AI匹配 ${Object.keys(aiResult.fieldMap || {}).length} 个`);
    }

    const matchedCount = Object.keys(allFieldMap).length;
    if (matchedCount === 0) {
      updateFillStatus('error', 'AI 未能匹配任何字段');
      return { error: 'AI 未能匹配任何字段' };
    }

    // 4. 执行填充
    updateFillStatus('filling', `正在填充 ${matchedCount} 个字段...`, 75);
    console.log(`\n=== 开始填充 ${matchedCount} 个字段 ===`);

    const fillResp = await sendToTab(tabId, { action: 'AUTOFILL', fieldMap: allFieldMap });
    if (fillResp?.error) {
      updateFillStatus('error', '填充失败: ' + fillResp.error);
      return fillResp;
    }

    // 5. 记录历史（并行读取 tab 信息和历史记录）
    const [tab, histData] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.storage.local.get('cvflash_history')
    ]);
    const history = histData.cvflash_history || [];
    history.unshift({
      url: tab.url,
      title: tab.title,
      resumeName: resume.name || '未命名',
      filledCount: fillResp.filledCount,
      timestamp: new Date().toISOString()
    });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ cvflash_history: history });

    updateFillStatus('done', `已填充 ${fillResp.filledCount} 个字段（AI 匹配 ${totalAiMatched}）`, 100);
    console.log(`=== 填充完成: ${fillResp.filledCount}/${fields.length} 个字段 ===`);

    return { fieldMap: allFieldMap, filledCount: fillResp.filledCount, totalFields: fields.length };

  } catch (e) {
    updateFillStatus('error', '填充失败: ' + e.message);
    console.error('=== 填充流程异常 ===', e);
    return { error: e.message };
  }
}

// ─── 预分析：AI 对比表单 vs 简历，提示用户添加条目 ──────────────────────────

async function handlePreAnalysis({ tabId, resume, apiKey, apiBase, providerId, model }) {
  // 1. 检测字段
  const detectResp = await sendToTab(tabId, { action: 'DETECT_FIELDS' });
  if (!detectResp?.fields?.length) return { error: '未找到表单字段', sections: [] };

  const fields = detectResp.fields;
  const sectionGroups = groupFieldsBySection(fields);

  // 2. 构建表单结构摘要
  const formSummary = [];
  for (const [sectionName, sectionFields] of Object.entries(sectionGroups)) {
    const groupIds = new Set(sectionFields.map(f => f.group?.id || `single_${f._domIndex}`));
    const groupCount = groupIds.size > 1 ? groupIds.size : Math.max(1, Math.ceil(sectionFields.length / 3));
    const fieldLabels = sectionFields.map(f => f.label || f.name || f.placeholder || '?').slice(0, 8);
    formSummary.push({ name: sectionName, fieldCount: sectionFields.length, groupCount, fieldLabels });
  }

  // 3. 构建简历摘要（兼容嵌套结构 resume.resume.xxx 或 resume.xxx）
  const r = resume.resume || resume;
  // 计算各类别的数据量（personal 按非空字段数统计，其他按数组长度）
  const personalFields = r.personal ? Object.values(r.personal).filter(v => v && String(v).trim()).length : 0;
  const resumeCounts = {
    personal: personalFields,
    education: r.education?.length || 0,
    experience: r.experience?.length || 0,
    projects: r.projects?.length || 0,
    skills: r.skills?.length || 0,
    activities: r.activities?.length || 0,
    research: r.research?.length || 0,
    summary: r.summary ? 1 : 0
  };
  console.log('[预分析] 简历数据量:', resumeCounts);

  // 4. AI 分析
  const base = apiBase || API_BASES.cn;
  const provider = resolveProvider(providerId, base);
  const authToken = normalizeAuthToken(apiKey, provider);

  if (!authToken) {
    // 无 API Key 时用本地对比
    return { sections: localCompareFormResume(formSummary, resumeCounts), fieldCount: fields.length };
  }

  const defaultModel = resolveDefaultModel(provider.id, base);
  const resolvedModel = resolveFieldMatchModel(provider, model || defaultModel);

  const prompt = `你是招聘表单分析助手。请对比表单结构和简历数据，判断用户需要手动添加多少条目。

【表单结构】
${formSummary.map(s => `- "${s.name}": ${s.fieldCount}个字段, 约${s.groupCount}组条目, 字段包含: ${s.fieldLabels.join(', ')}`).join('\n')}

【简历数据量】
- 基本信息(personal): ${resumeCounts.personal} 个字段有值
- 个人简介/求职意向(summary): ${resumeCounts.summary ? '有' : '无'}
- 教育经历: ${resumeCounts.education} 条
- 工作/实习经历: ${resumeCounts.experience} 条
- 项目经历: ${resumeCounts.projects} 条
- 技能(skills): ${resumeCounts.skills} 条
- 校园/社团经历: ${resumeCounts.activities} 条
- 科研经历: ${resumeCounts.research} 条

【任务】
对每个表单分区，判断：
1. 该分区对应简历的哪个类别？
2. 表单有几组条目位？简历有几条数据？
3. 用户是否需要手动在网页上添加更多条目？

返回纯JSON数组（不要解释），每项格式：
{"section":"分区名","category":"personal|summary|education|experience|projects|skills|activities|research|other","formSlots":数字,"resumeEntries":数字,"gap":数字,"action":"ok|need_add|no_data","hint":"提示文字"}

gap = max(0, resumeEntries - formSlots)
action: "ok"=够用, "need_add"=需要手动添加, "no_data"=简历无此类数据`;

  try {
    const response = await callChatAPI(base, authToken, provider, resolvedModel, [
      { role: 'user', content: prompt }
    ], { temperature: 0.1, max_tokens: 2048, timeout: 30000 });

    const jsonStr = extractJsonCandidate(response);
    const analysis = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    return { sections: Array.isArray(analysis) ? analysis : [], fieldCount: fields.length };
  } catch (e) {
    console.warn('AI 预分析失败，使用本地对比:', e.message);
    return { sections: localCompareFormResume(formSummary, resumeCounts), fieldCount: fields.length };
  }
}

function localCompareFormResume(formSummary, resumeCounts) {
  const results = [];
  const categoryMap = {
    '基本': 'personal', '个人信息': 'personal', 'Basic': 'personal', 'Personal': 'personal',
    '求职意向': 'summary', '自我评价': 'summary', '个人简介': 'summary', 'Summary': 'summary', 'Profile': 'summary',
    '教育': 'education', 'Education': 'education',
    '实习': 'experience', '工作': 'experience', 'Employment': 'experience', 'Work': 'experience',
    '项目': 'projects', 'Project': 'projects',
    '技能': 'skills', 'Skill': 'skills',
    '校园': 'activities', '社团': 'activities', '活动': 'activities',
    '科研': 'research', 'Research': 'research',
    '创业': 'experience', '获奖': 'other', '作品': 'other'
  };

  for (const section of formSummary) {
    let category = 'other';
    for (const [keyword, cat] of Object.entries(categoryMap)) {
      if (section.name.includes(keyword)) { category = cat; break; }
    }

    const resumeEntries = resumeCounts[category] || 0;
    const formSlots = section.groupCount;

    // personal/summary 类型不按条目数对比，只看有无数据
    if (category === 'personal' || category === 'summary') {
      results.push({
        section: section.name, category, formSlots: section.fieldCount, resumeEntries,
        gap: 0,
        action: resumeEntries > 0 ? 'ok' : 'no_data',
        hint: resumeEntries > 0 ? `简历有${resumeEntries}项数据` : '简历无此类数据'
      });
    } else {
      const gap = Math.max(0, resumeEntries - formSlots);
      results.push({
        section: section.name, category, formSlots, resumeEntries, gap,
        action: gap > 0 ? 'need_add' : (resumeEntries === 0 ? 'no_data' : 'ok'),
        hint: gap > 0 ? `需要手动添加 ${gap} 条` : (resumeEntries === 0 ? '简历无此类数据' : '数量匹配')
      });
    }
  }
  return results;
}

// ─── 表单分区分组 ─────────────────────────────────────────────────────────────

function groupFieldsBySection(fields) {
  const groups = {};

  for (const field of fields) {
    const section = field.section || '（无分区）';
    if (!groups[section]) groups[section] = [];
    groups[section].push(field);
  }

  // 对分区进行排序：基础信息优先，然后是教育、工作、项目等
  const sectionOrder = {
    '基本信息': 1,
    '个人信息': 1,
    '个人资料': 1,
    'Basic Information': 1,
    '教育经历': 2,
    '教育背景': 2,
    'Education': 2,
    '实习经历': 3,
    '工作经历': 4,
    'Employment': 4,
    'Work Experience': 4,
    '项目经历': 5,
    '项目经验': 5,
    'Projects': 5,
    '技能': 6,
    'Skills': 6,
  };

  const sortedSections = Object.keys(groups).sort((a, b) => {
    const orderA = sectionOrder[a] ?? 999;
    const orderB = sectionOrder[b] ?? 999;
    return orderA - orderB;
  });

  const result = {};
  for (const section of sortedSections) {
    result[section] = groups[section];
  }

  return result;
}

// ─── 检测简历条目 vs 表单字段的缺口 ──────────────────────────────────────────

/**
 * 检测简历中有多少条目，而表单中对应分区可能字段不够
 * 返回提示信息列表，让用户知道需要手动添加更多条目
 */
function detectMissingEntries(fields, resume, sectionGroups) {
  const hints = [];

  // 计算表单中各类分区的字段组数（每组代表一个条目）
  const countGroups = (sectionKeywords) => {
    let maxGroups = 0;
    for (const [sectionName, sectionFields] of Object.entries(sectionGroups)) {
      if (sectionKeywords.some(kw => sectionName.includes(kw))) {
        // 计算该分区有多少独立的 group
        const groupIds = new Set(sectionFields.map(f => f.group?.id || `single_${f._domIndex}`));
        maxGroups = Math.max(maxGroups, groupIds.size > 1 ? groupIds.size : Math.ceil(sectionFields.length / 3));
      }
    }
    return maxGroups;
  };

  const eduCount = resume.education?.length || 0;
  const expCount = resume.experience?.length || 0;
  const projCount = resume.projects?.length || 0;
  const actCount = resume.activities?.length || 0;

  const formEduGroups = countGroups(['教育', 'Education']);
  const formExpGroups = countGroups(['工作', '实习', 'Employment', 'Work', 'Experience']);
  const formProjGroups = countGroups(['项目', 'Project']);
  const formActGroups = countGroups(['校园', '社团', '活动', '创业', 'Activity']);

  if (eduCount > formEduGroups && formEduGroups > 0) {
    hints.push(`教育经历：简历有 ${eduCount} 条，表单约 ${formEduGroups} 组字段，可能需要手动添加 ${eduCount - formEduGroups} 条`);
  }
  if (expCount > formExpGroups && formExpGroups > 0) {
    hints.push(`工作/实习经历：简历有 ${expCount} 条，表单约 ${formExpGroups} 组字段，可能需要手动添加 ${expCount - formExpGroups} 条`);
  }
  if (projCount > formProjGroups && formProjGroups > 0) {
    hints.push(`项目经历：简历有 ${projCount} 条，表单约 ${formProjGroups} 组字段，可能需要手动添加 ${projCount - formProjGroups} 条`);
  }
  if (actCount > 0 && formActGroups === 0) {
    hints.push(`校园/社团/创业经历：简历有 ${actCount} 条，但表单中未找到对应分区字段`);
  }

  return hints;
}

// （本地规则已移除 - AI 完全自主决策）

// ─── AI 字段匹配（纯文本模式）────────────────────────────────────────────────

async function handleAIMatch({ fields, resume, apiKey, apiBase, providerId, model, sectionContext = '' }) {
  const base = apiBase || API_BASES.cn;
  const provider = resolveProvider(providerId, base);
  const authToken = normalizeAuthToken(apiKey, provider);
  if (!authToken) throw new Error('未配置 API Key，请先前往设置页面填写');
  const resumeSummary = buildResumeSummary(resume);

  console.log('=== 开始 AI 字段匹配 ===');
  console.log(`分区: ${sectionContext || '全表单'}`);
  console.log(`字段数量: ${fields.length}`);
  console.log(`API 端点: ${base}`);
  console.log(`供应商: ${provider.label}`);
  console.log(`使用模型: ${model || 'default'}`);

  const structuredPrompt = buildStructuredFieldPrompt(fields);

  // 纯文本模式：仅发送结构化字段数据（AI 完全自主决策，不受本地规则干扰）
  const messages = [{
    role: 'user',
    content: buildTextFillPrompt(structuredPrompt, resumeSummary, fields, sectionContext)
  }];

  console.log('准备调用 API...');
  const defaultModel = resolveDefaultModel(provider.id, base);
  const resolvedModel = resolveFieldMatchModel(provider, model || defaultModel);
  const requestOpts = {
    temperature: 0.25,
    max_tokens: 4096,
    timeout: 90000,
    response_format: buildJsonResponseFormat(provider, base)
  };

  // 智能降级：先尝试完整 prompt，超时后降级到简化 prompt
  let response;
  try {
    response = await callChatAPI(base, authToken, provider, resolvedModel, messages, requestOpts);
  } catch (error) {
    // 检查是否是超时错误
    if (error.message.includes('超时') || error.message.includes('timeout')) {
      console.warn('⚠️ API 超时，降级到简化 prompt...');
      updateFillStatus('matching', '响应较慢，正在重试简化模式...', 50);

      // 降级：使用简化 prompt（完全依赖 AI，不传递本地规则）
      const simplifiedPrompt = buildSimplifiedPrompt(fields, resumeSummary);
      const simplifiedMessages = [{
        role: 'user',
        content: simplifiedPrompt
      }];

      response = await callChatAPI(base, authToken, provider, resolvedModel, simplifiedMessages, {
        ...requestOpts,
        timeout: 60000
      });
    } else {
      throw error; // 非超时错误直接抛出
    }
  }

  console.log('API 响应收到，长度:', response?.length);
  let fieldMap = parseFillResponse(response, fields);
  if (!Object.keys(fieldMap).length && typeof response === 'string' && response.trim()) {
    updateFillStatus('matching', '正在修正 AI 返回格式...', 55);
    const repairedResponse = await repairFillResponse(base, authToken, provider, resolvedModel, response);
    fieldMap = parseFillResponse(repairedResponse, fields);
  }

  const unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null || fieldMap[field._domIndex] === '');
  if (unresolvedFields.length > 0 && unresolvedFields.length < fields.length) {
    try {
      updateFillStatus('matching', `AI 正在二次校准剩余 ${unresolvedFields.length} 个字段...`, 62);
      const refineResponse = await callChatAPI(base, authToken, provider, resolvedModel, [{
        role: 'user',
        content: buildFocusedFillPrompt(unresolvedFields, resumeSummary, fields, fieldMap)
      }], {
        ...requestOpts,
        max_tokens: 3072,
        timeout: 45000
      });
      const refinedMap = parseFillResponse(refineResponse, unresolvedFields);
      fieldMap = { ...fieldMap, ...refinedMap };
    } catch (error) {
      console.warn('二次 AI 校准失败，保留首次结果:', error.message);
    }
  }

  console.log('=== 字段匹配完成 ===');
  return { fieldMap };
}

/**
 * 构建结构化字段提示：按 section 和 DOM 分组组织字段
 * 输出层次化的文本，帮助 AI 理解表单空间布局
 */
function buildStructuredFieldPrompt(fields) {
  // 按 section 分组
  const sectionMap = new Map();
  for (const f of fields) {
    const sec = f.section || '（无分区）';
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec).push(f);
  }

  const lines = [];
  for (const [section, secFields] of sectionMap) {
    lines.push(`\n【${section}】`);

    // 在同一 section 内，按 group 再分组
    const groupMap = new Map();
    for (const f of secFields) {
      const gid = f.group?.id || `field_${f._domIndex}`;
      if (!groupMap.has(gid)) groupMap.set(gid, []);
      groupMap.get(gid).push(f);
    }

    let groupIdx = 0;
    for (const [gid, groupFields] of groupMap) {
      if (groupMap.size > 1) {
        groupIdx++;
        lines.push(`  └─ 第${groupIdx}组:`);
      }
      for (const f of groupFields) {
        const pos = f.bbox ? `(位置: x=${f.bbox.x}, y=${f.bbox.y})` : '';
        const opts = f.options?.length ? ` 选项:[${f.options.slice(0, 5).join(',')}]` : '';
        const siblings = f.group?.siblings?.length ? ` 同组字段:[${f.group.siblings.join(',')}]` : '';
        const prefix = groupMap.size > 1 ? '    ' : '  ';
        const semanticHint = f.hint && f.hint !== 'unknown' ? `[类型:${f.hint}]` : '';
        const nameHint = f.name ? ` name="${f.name}"` : '';
        const placeholderHint = f.placeholder ? ` placeholder="${f.placeholder}"` : '';
        const currentValueHint = f.currentValue ? ` 当前值="${String(f.currentValue).slice(0, 40)}"` : '';
        const requiredHint = f.required ? ' required' : '';
        const autoHint = f.autocomplete ? ` autocomplete="${f.autocomplete}"` : '';
        const inputModeHint = f.inputMode ? ` inputMode="${f.inputMode}"` : '';
        lines.push(`${prefix}#${f._domIndex}: label="${f.label || f.name || f.placeholder || '?'}" [${f.type}]${semanticHint}${requiredHint}${nameHint}${placeholderHint}${autoHint}${inputModeHint}${currentValueHint}${opts}${siblings} ${pos}`.trim());
      }
    }
  }

  return lines.join('\n');
}

function buildExistingMatchesPrompt(fieldMap, fields) {
  const lines = Object.entries(fieldMap || {})
    .map(([domIndex, value]) => {
      const field = fields.find(item => item._domIndex === Number(domIndex));
      if (!field) return null;
      return `#${domIndex}: ${field.label || field.name || '?'} => "${value}"`;
    })
    .filter(Boolean);

  return lines.length ? lines.join('\n') : '（暂无已确定字段）';
}

/**
 * 构建纯文本模式的 AI 提示词（无截图）
 */
function buildTextFillPrompt(structuredFields, resumeSummary, fields, sectionContext = '') {
  const contextSection = sectionContext ? `\n【当前处理分区】${sectionContext}` : '';

  return `你是招聘表单智能填充助手，请基于语义理解准确匹配简历内容到表单字段。${contextSection}

【字段列表】
${structuredFields}

【简历完整信息】
${resumeSummary}

【AI 决策准则（重要）】
1. 🎯 完全自主理解字段语义 - 通过标签、占位符、位置、分组关系综合判断
2. 🔗 同组字段关联性 - 同一组字段（同学校/公司/项目）必须来自简历的同一条记录
3. ⏰ 多组条目分配 - 多组重复字段按时间从近到远匹配（最近的排第1组）
4. 🔄 强制覆盖模式 - 无论字段是否有"当前值"，都用简历数据覆盖（用户要求更新）
5. ✅ 选项严格匹配 - 有选项的字段必须完全匹配选项文本之一（可进行语义同义转换）
6. 🚫 数据质量校验 - 邮箱含@、电话纯数字、学校不含@、公司不含@
7. 📅 日期格式 - 日期返回 YYYY-MM 格式（如 2024-09），不要只返回年份

【语义映射策略】
通过以下线索判断字段用途：
- 文字线索：label文字（"学校名称"、"项目描述"）、placeholder（"请输入..."）、name属性
- 位置线索：在同一 section 内的相对位置、与哪些字段相邻
- 选项线索：select 选项列表通常能明确字段类型（学历、城市等）
- 类型线索：type="email"/tel/date/month 明确字段格式
- 分组线索：同组字段通常是同一实体的不同属性

【特殊字段处理】
- 项目名称：绝对不能返回 null！必须填写实际项目名（MoodPulse、CVmax插件、AI聊天助手等）
- 创业经历：联合创始人/创始人/店长等关键词 → 创业类分区
- 校园经历：社团/组织/学生会 → 校园经历分区

【输出要求】
- 尽可能为每个字段匹配简历数据，真正无法判断时才返回 null
- 只返回纯 JSON 对象，不要解释、不要 markdown 格式

JSON格式示例：{"0":"丁宏磊","1":"3043755156@qq.com","5":"上海外国语大学","10":"MoodPulse","11":"项目负责人","15":null}`;
}

function buildFocusedFillPrompt(unresolvedFields, resumeSummary, allFields, existingFieldMap = {}) {
  return `你正在进行第二轮精准校准，专注处理仍未确定的字段。

【已确定字段】
${buildExistingMatchesPrompt(existingFieldMap, allFields)}

【待匹配字段】
${buildStructuredFieldPrompt(unresolvedFields)}

【简历数据】
${resumeSummary}

【校准策略】
- 深入利用字段分组、section、选项、同组关系等语义线索
- 对比已确定字段的匹配模式，寻找相似的语义关联
- 不要改写已确定字段
- 真正无法判断时返回 null

【输出】
只返回待匹配字段的 JSON 对象，不要解释。`;
}

/**
 * 构建简化 prompt（降级模式，减少 token 消耗）
 */
function buildSimplifiedPrompt(fields, resumeSummary) {
  // 只保留关键字段信息，减少 token 消耗
  const simpleFields = fields.map(f => ({
    i: f._domIndex,
    l: f.label || f.name || f.placeholder || '?',
    t: f.type,
    h: f.hint !== 'unknown' ? f.hint : undefined,
    s: f.section || undefined,
    o: f.options?.slice(0, 5)
  }));

  return `表单快速填充：通过语义理解匹配字段到简历数据。

【字段列表】
${JSON.stringify(simpleFields)}

【简历摘要】
${resumeSummary.slice(0, 2000)}

【匹配规则】
- 完全自主判断字段语义
- 强制覆盖模式：无论字段是否有当前值，都用简历数据覆盖
- 邮箱含@、电话纯数字、学校不含邮箱格式
- 同组字段必须来自同一条记录
- 日期返回 YYYY-MM 格式
- 真正无法判断时返回 null

返回纯JSON对象：{"字段索引":"值"}`;
}

/**
 * 深度匹配场景强制使用稳定的文本模型
 */
function resolveFieldMatchModel(provider, model) {
  if (provider.id === 'deepseek' && model === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }
  return model;
}

function buildJsonResponseFormat(provider, base) {
  if (provider.apiKind !== 'openai') return undefined;
  if (base?.includes('deepseek.com')) {
    return { type: 'json_object' };
  }
  return undefined;
}

async function repairFillResponse(base, apiKey, provider, model, rawResponse) {
  const prompt = [
    '请将下面内容整理成一个纯 JSON 对象。',
    '要求：',
    '- 只返回 JSON',
    '- key 必须是字段 domIndex（字符串或数字均可）',
    '- value 是填充值，无法确定时填 null',
    '',
    '原始内容：',
    rawResponse.slice(0, 6000)
  ].join('\n');

  return callChatAPI(base, apiKey, provider, model, [{ role: 'user', content: prompt }], {
    temperature: 0,
    max_tokens: 2048,
    timeout: 30000,
    response_format: buildJsonResponseFormat(provider, base)
  });
}

function extractJsonCandidate(response) {
  if (typeof response !== 'string') return '';

  const fencedMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();

  const objectMatch = response.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) return objectMatch[0].trim();

  return '';
}

function normalizeParsedEntries(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.map(item => [item?.field_index ?? item?.index ?? item?.domIndex, item?.value]);
  }

  if (Array.isArray(parsed?.matches)) {
    return parsed.matches.map(item => [item?.field_index ?? item?.index ?? item?.domIndex, item?.value]);
  }

  return Object.entries(parsed || {});
}

/**
 * 解析 AI 填充响应
 */
function parseFillResponse(response, fields) {
  console.log('=== AI填充响应解析 ===');
  console.log('原始响应:', response);

  try {
    const jsonCandidate = extractJsonCandidate(response);
    if (!jsonCandidate) {
      console.warn('AI 返回中未提取到 JSON，已跳过本次结果');
      return {};
    }

    const normalizedJson = jsonCandidate.replace(/,\s*([}\]])/g, '$1');
    console.log('提取的JSON:', normalizedJson);
    const parsed = JSON.parse(normalizedJson);
    console.log('解析后的对象:', parsed);

    const result = {};
    let matchedCount = 0;
    let rejectedCount = 0;

    for (const [key, value] of normalizeParsedEntries(parsed)) {
      if (value == null || value === '' || value === 'null') continue;
      const domIndex = Number(key);
      if (isNaN(domIndex)) continue;

      const field = fields.find(f => f._domIndex === domIndex);
      if (!field) {
        console.warn(`字段索引 ${domIndex} 不存在于表单中`);
        continue;
      }

      // 验证字段值的合理性
      const validation = validateFieldValue(value, field);
      if (!validation.valid) {
        console.warn(`⚠️ 字段 ${domIndex} ("${field.label}") 值验证失败: ${validation.reason}`);
        console.warn(`   填入值: "${value}"`);
        rejectedCount++;
        continue;
      }

      result[domIndex] = String(value);
      matchedCount++;
      console.log(`✓ 匹配字段 ${domIndex}: "${value}"`);
    }

    console.log(`总共匹配了 ${matchedCount} 个字段，拒绝 ${rejectedCount} 个不合理值`);
    return result;
  } catch (err) {
    console.warn('填充响应解析失败:', err.message);
    return {};
  }
}

/**
 * 验证字段值的合理性
 */
function validateFieldValue(value, field) {
  const strValue = String(value).trim();

  // 空值检查
  if (!strValue) {
    return { valid: false, reason: '值为空' };
  }

  const label = (field.label || field.name || '').toLowerCase();
  const hint = (field.hint || '').toLowerCase();

  // 邮箱字段验证
  if (label.includes('mail') || label.includes('邮箱') || hint === 'email') {
    if (!/@/.test(strValue)) {
      return { valid: false, reason: '邮箱必须包含@符号' };
    }
    // 简单邮箱格式检查
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(strValue)) {
      return { valid: false, reason: '邮箱格式不正确' };
    }
  }

  // 电话字段验证
  if (label.includes('phone') || label.includes('tel') || label.includes('电话') || label.includes('手机') || hint === 'phone') {
    // 电话应该是纯数字，可能包含-或空格作为分隔符
    const phoneDigits = strValue.replace(/[\-\s\(\)]/g, '');
    if (!/^\d{7,15}$/.test(phoneDigits)) {
      return { valid: false, reason: '电话应该是数字，不能是邮箱或文字' };
    }
    // 如果值包含@，明显错误
    if (/@/.test(strValue)) {
      return { valid: false, reason: '电话字段不能包含邮箱' };
    }
  }

  // 学校字段验证
  if (label.includes('school') || label.includes('university') || label.includes('college') || label.includes('学校') || label.includes('大学') || hint === 'school') {
    // 学校名不应包含邮箱格式
    if (/@/.test(strValue)) {
      return { valid: false, reason: '学校字段不能包含邮箱' };
    }
    // 学校名应该是机构名，不应该是城市名
    const cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州'];
    if (cities.includes(strValue) || /^[京津沪渝港澳台]$/.test(strValue)) {
      return { valid: false, reason: '学校字段不能是城市名' };
    }
  }

  // 公司字段验证
  if (label.includes('company') || label.includes('employer') || label.includes('公司') || label.includes('单位') || hint === 'company') {
    // 公司名不应包含邮箱格式
    if (/@/.test(strValue)) {
      return { valid: false, reason: '公司字段不能包含邮箱' };
    }
    // 公司名不应是学校
    if (strValue.includes('大学') || strValue.includes('学院') || strValue.includes('学院')) {
      // 可能是教育机构名，但作为公司字段不太合理，这里允许但记录警告
      console.warn(`⚠️ 公司字段填入了疑似学校名: "${strValue}"`);
    }
  }

  // 专业字段验证
  if (label.includes('major') || label.includes('专业') || hint === 'major') {
    // 专业不应是邮箱
    if (/@/.test(strValue)) {
      return { valid: false, reason: '专业字段不能包含邮箱' };
    }
    // 专业不应是学校名
    if (strValue.includes('大学') || strValue.includes('学院')) {
      return { valid: false, reason: '专业字段不应是学校名' };
    }
    // 专业不应是城市名
    const cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州'];
    if (cities.includes(strValue)) {
      return { valid: false, reason: '专业字段不能是城市名' };
    }
  }

  // 姓名字段验证
  if (label.includes('name') || label.includes('姓名') || hint === 'name' || hint === 'firstname' || hint === 'lastname') {
    // 姓名不应包含邮箱
    if (/@/.test(strValue)) {
      return { valid: false, reason: '姓名字段不能包含邮箱' };
    }
    // 姓名不应是纯数字
    if (/^\d+$/.test(strValue)) {
      return { valid: false, reason: '姓名字段不能是纯数字' };
    }
  }

  // LinkedIn/GitHub 字段验证
  if (label.includes('linkedin') || label.includes('github') || hint === 'linkedin' || hint === 'github') {
    // 应该是链接或用户名
    if (/@/.test(strValue) && !strValue.includes('.com') && !strValue.includes('.io')) {
      return { valid: false, reason: '社交账号不应是邮箱格式' };
    }
  }

  // 地址/城市字段验证
  if (label.includes('address') || label.includes('city') || label.includes('location') || label.includes('地址') || label.includes('城市') || hint === 'location') {
    // 不应包含邮箱
    if (/@/.test(strValue)) {
      return { valid: false, reason: '地址字段不能包含邮箱' };
    }
  }

  return { valid: true };
}

// ─── 通用 AI 对话 ─────────────────────────────────────────────────────────────

async function handleAIChat({ messages, apiKey, apiBase, providerId, model, temperature, maxTokens }) {
  const base = apiBase || API_BASES.cn;
  const provider = resolveProvider(providerId, base);
  const authToken = normalizeAuthToken(apiKey, provider);
  if (!authToken) throw new Error('未配置 API Key');
  const defaultModel = resolveDefaultModel(provider.id, base);

  const content = await callChatAPI(base, authToken, provider, model || defaultModel, messages, {
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens || 2048
  });
  return { content };
}

// ─── PDF 简历解析 ─────────────────────────────────────────────────────────────

async function handleParsePDF({ extractedText, imageDataUrl, apiKey, apiBase, providerId, textModel, visionModel }) {
  const base = apiBase || API_BASES.cn;
  const provider = resolveProvider(providerId, base);
  const authToken = normalizeAuthToken(apiKey, provider);
  const defaultModel = resolveDefaultModel(provider.id, base);
  const model = textModel || defaultModel;

  let resumeText = extractedText || '';

  // 如果文本提取失败（扫描版 PDF），提示用户上传文字版
  if (!resumeText.trim()) {
    throw new Error('无法从 PDF 提取文本，请尝试上传文字版 PDF');
  }

  // ── 策略：始终优先 AI 解析，本地仅作兜底 ────────────────────────────────────
  if (authToken) {
    try {
      const parsePrompt = `你是一位专业的简历解析专家。请将以下简历文本**完整、精确、不遗漏地**解析为 JSON 格式。

## 重要解析规则
1. **不要遗漏任何内容**：简历中的每一段文字都必须归入合适的字段，不能有任何遗漏
2. **严格按照简历原文的板块标题来分类**：
   - "Profile/个人陈述/自我评价/求职意向" → summary
   - "教育经历/教育背景/Education" → education（只放学校、学位、专业、课程信息）
   - "工作经历/Employment/Work" → experience，isInternship=false
   - "实习经历/Internship" → experience，isInternship=true
   - "项目经历/项目经验/Project" → projects（个人项目、课程项目、开源项目也放这里）
   - "校园经历/社团经历/课外活动/学生工作/志愿者" → activities
   - "科研经历/研究经历/Research" → research
   - "技能/Skills" → skills
   - "兴趣/Hobbies/兴趣爱好" → hobbies
   - "荣誉/奖项/Awards" → awards
   - "证书/Certifications" → certifications
   - 其他无法归类的板块 → customSections
3. **当一个板块标题包含多个类别**（如"工作经历/项目经历"或"校园/科研经历"），需要根据每个条目的实际内容分别归类
4. **日期**统一为 YYYY-MM 格式（如 2024-10），"至今"对应 endDate 留空且 current 设 true
5. **description 字段**要保留完整描述，包括所有要点、职责、成就、技术栈、量化数据，使用换行符分隔各要点
6. **技能**按类别拆分为独立条目（如 "Excel（精通）", "Python（熟练）", "SQL（熟练）"）
7. 只输出 JSON，不要任何解释、注释或 markdown 标记

## 简历文本
${resumeText.slice(0, 8000)}

## JSON 模板（严格遵循此结构）
{
  "personal": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "github": "",
    "website": "",
    "birthDate": "",
    "gender": "",
    "politicalStatus": "",
    "ethnicity": ""
  },
  "summary": "Profile/个人陈述/自我评价的完整原文",
  "experience": [
    {
      "company": "公司或组织名称",
      "position": "职位名称",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM 或留空",
      "current": false,
      "isInternship": false,
      "description": "完整的工作描述，保留所有要点和细节"
    }
  ],
  "education": [
    {
      "school": "学校全称",
      "degree": "学位（博士/硕士/本科/大专）",
      "major": "专业名称",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "gpa": "",
      "description": "专业方向、课程重点、毕业论文等补充信息"
    }
  ],
  "projects": [
    {
      "name": "项目名称",
      "role": "角色/职责",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "description": "项目的完整描述",
      "url": ""
    }
  ],
  "research": [
    {
      "institution": "研究机构/实验室/大学",
      "role": "角色（如：研究助理、量化学生助理）",
      "advisor": "导师/PI姓名",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "description": "完整的研究内容描述"
    }
  ],
  "activities": [
    {
      "organization": "社团/组织名称",
      "role": "职务/角色",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM",
      "description": "活动内容和成果的完整描述"
    }
  ],
  "skills": ["Excel（精通）", "Python（熟练）"],
  "languages": ["英语（CET-6/专八）"],
  "certifications": ["证书1"],
  "awards": ["荣誉/奖项1"],
  "hobbies": ["兴趣爱好1"],
  "customSections": [
    {
      "title": "其他板块标题",
      "content": "完整内容"
    }
  ]
}`;

      const response = await callChatAPI(base, authToken, provider, model, [
        { role: 'user', content: parsePrompt }
      ], { temperature: 0.05, max_tokens: 4096, timeout: 45000, maxRetries: 1 });

      let aiParsed;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || response.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        aiParsed = JSON.parse(jsonMatch[1]);
      } else {
        aiParsed = JSON.parse(response);
      }

      return {
        resume: validateAndCleanResume(aiParsed),
        rawText: resumeText.slice(0, 300),
        parseMode: 'ai'
      };

    } catch (aiErr) {
      console.warn('AI 解析失败:', aiErr.message);

      // API Key 错误或网络问题 → 直接抛出，不要假装成功
      if (aiErr.message.includes('API Key') || aiErr.message.includes('401') || aiErr.message.includes('无效')) {
        throw new Error('API Key 无效，请在设置页面重新配置。错误：' + aiErr.message);
      }

      // 超时 → 给出明确提示
      if (aiErr.message.includes('超时') || aiErr.message.includes('timeout')) {
        throw new Error('AI解析超时（45秒）。可能原因：网络较慢或API服务繁忙。请稍后重试。');
      }

      // 其他错误 → 回退到本地解析，但明确告知用户
      console.warn('回退到本地正则解析（结果可能不完整）');
      const localResult = localParseResume(resumeText);
      return {
        resume: validateAndCleanResume(localResult),
        rawText: resumeText.slice(0, 300),
        parseMode: 'local_fallback',
        aiError: aiErr.message
      };
    }
  }

  // 无 API Key 时使用本地解析
  const localResult = localParseResume(resumeText);
  return {
    resume: validateAndCleanResume(localResult),
    rawText: resumeText.slice(0, 300),
    parseMode: 'local'
  };
}

// ─── 本地正则简历解析器 ──────────────────────────────────────────────────────

function localParseResume(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const resume = {
    personal: extractPersonal(text, lines),
    summary: extractSection(text, ['个人简介', '自我评价', '个人描述', 'Profile', 'Summary', 'Objective']),
    experience: extractExperience(text),
    education: extractEducation(text),
    skills: extractSkills(text),
    languages: extractLanguages(text),
    projects: extractProjects(text)
  };

  return resume;
}

function extractPersonal(text, lines) {
  // 姓名：通常是第一行非空短文字（2-8个中文字或英文单词）
  let name = '';
  for (const line of lines.slice(0, 5)) {
    const clean = line.replace(/[◆◇■□●○▪▫·\-\|]/g, '').trim();
    // 跳过明显不是名字的行（含邮箱、电话、数字、网址等）
    if (clean.length >= 2 && clean.length <= 10 &&
        !/@/.test(clean) && !/\d{5,}/.test(clean) && !/http/.test(clean) &&
        !/简历|resume|cv|个人|求职/i.test(clean)) {
      name = clean;
      break;
    }
  }
  // 备用：带姓名标签
  const nameLabel = text.match(/姓\s*名[：:]\s*([^\n\r◆◇·]{2,8})/);
  if (!name && nameLabel) name = nameLabel[1].trim();

  const email = (text.match(/[\w.\-+]+@[\w\-]+\.[a-zA-Z]{2,}/) || [])[0] || '';
  const phone = (text.match(/(?:^|\s|◆|·)(1[3-9]\d{9})(?:\s|$|◆|·)/) ||
                 text.match(/(\+?86[\s\-]?1[3-9]\d{9})/) ||
                 text.match(/(1[3-9]\d{9})/)) || [];
  const phoneNum = (phone[1] || phone[0] || '').replace(/^\+?86[\s\-]?/, '').replace(/\D/g, '');

  const linkedin = (text.match(/linkedin\.com\/in\/([^\s\/\n]+)/i) || [])[0] || '';
  const github = (text.match(/github\.com\/([^\s\/\n]+)/i) || [])[0] || '';
  const website = (text.match(/https?:\/\/(?!linkedin|github)[^\s\n,◆]+/) || [])[0] || '';

  // 城市/地址：常见城市名或地址标签
  const cityMatch = text.match(/(?:◆|·|地址|所在地|城市|Location)[：:\s]*([^\n◆·,，]{2,10}(?:市|省|区|县)?)/);
  const cityDirect = text.match(/(?:^|\s|◆|·)(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|厦门|青岛|济南|郑州|合肥|宁波|东莞)(?:\s|$|◆|·)/);
  const location = (cityMatch ? cityMatch[1] : (cityDirect ? cityDirect[1] : '')).trim();

  return { name, email, phone: phoneNum.slice(-11), location, linkedin, github, website };
}

function extractSection(text, keywords) {
  const pattern = new RegExp(
    `(?:${keywords.join('|')})[：:\\s]*([\\s\\S]+?)(?=\\n(?:工作经历|教育背景|技能|项目|实习|荣誉|获奖|证书|Work|Education|Skills|Project|${keywords.join('|')})|$)`,
    'i'
  );
  const m = text.match(pattern);
  return m ? m[1].replace(/\n+/g, ' ').trim().slice(0, 500) : '';
}

function extractExperience(text) {
  const sectionMatch = text.match(
    /(?:工作经历|实习经历|工作经验|Employment|Experience|Work History)[：:\s]*([\s\S]+?)(?=\n(?:教育背景|教育经历|学历|项目经历|技能|荣誉|证书|Education|Skills|Project)|$)/i
  );
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const experiences = [];

  // 按时间段切分工作条目（如 2022.03 - 2024.01 或 2022/03~至今）
  const datePattern = /(\d{4}[.\-\/年]\d{1,2}(?:[.\-\/月])?)\s*[-~至到—]\s*(\d{4}[.\-\/年]\d{1,2}(?:[.\-\/月])?|至今|Present|Now)/gi;
  const blocks = section.split(/\n(?=\S)/).filter(b => b.trim());

  for (const block of blocks) {
    const dateMatch = block.match(datePattern);
    if (!dateMatch && !block.match(/^\s*(?:\d+\.|[-•◆])/)) continue;

    const dates = (dateMatch || [''])[0];
    const [startRaw, endRaw] = dates.split(/[-~至到—]+/);
    const startDate = normalizeDate(startRaw || '');
    const endRaw2 = (endRaw || '').trim();
    const isCurrent = /至今|present|now/i.test(endRaw2);
    const endDate = isCurrent ? '' : normalizeDate(endRaw2);

    // 从块中提取公司名和职位（通常在前两行）
    const blockLines = block.replace(dates, '').split('\n').map(l => l.trim()).filter(Boolean);
    const company = blockLines[0] || '';
    const position = blockLines[1] || '';
    const description = blockLines.slice(2).join('\n').trim();

    if (company || position) {
      experiences.push({ company, position, startDate, endDate, current: isCurrent, description });
    }
  }

  return experiences;
}

function extractEducation(text) {
  const sectionMatch = text.match(
    /(?:教育背景|教育经历|学历|Education)[：:\s]*([\s\S]+?)(?=\n(?:工作经历|实习|项目|技能|荣誉|证书|Work|Skills|Project|Employment)|$)/i
  );
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const educations = [];
  const degreeKeywords = /(?:博士|硕士|本科|大专|学士|Master|Bachelor|PhD|Doctor|MBA|专科)/i;
  const blocks = section.split(/\n(?=\S)/).filter(b => b.trim());

  for (const block of blocks) {
    if (!block.match(degreeKeywords) && !block.match(/大学|学院|University|College|School/i)) continue;

    const datePattern = /(\d{4}[.\-\/年]\d{0,2})\s*[-~至到—]\s*(\d{4}[.\-\/年]\d{0,2}|至今)/;
    const dateMatch = block.match(datePattern);
    const startDate = normalizeDate((dateMatch || [])[1] || '');
    const endDate = normalizeDate((dateMatch || [])[2] || '');

    const blockLines = block.replace(datePattern, '').split('\n').map(l => l.trim()).filter(Boolean);
    const school = blockLines[0] || '';
    const degreeAndMajor = blockLines[1] || '';
    const degreeMatch = degreeAndMajor.match(degreeKeywords);
    const degree = degreeMatch ? degreeMatch[0] : '';
    const major = degreeAndMajor.replace(degree, '').replace(/[·\-\|]/g, '').trim();

    if (school) {
      educations.push({ school, degree, major, startDate, endDate, gpa: '' });
    }
  }

  return educations;
}

function extractSkills(text) {
  const sectionMatch = text.match(
    /(?:技能|专业技能|技术技能|Skills?)[：:\s]*([^\n]{5,}(?:\n(?![\n工作教育项目荣誉])[^\n]{2,}){0,10})/i
  );
  if (!sectionMatch) return [];

  const raw = sectionMatch[1];
  // 分割：· / ｜ / , / ；/ 换行
  return raw.split(/[·|·\|,，；;\n]/)
    .map(s => s.replace(/[◆◇■•▪]/g, '').trim())
    .filter(s => s.length >= 2 && s.length <= 40 && !/^\d+$/.test(s))
    .slice(0, 30);
}

function extractLanguages(text) {
  const langs = [];
  const langPatterns = [
    /(?:普通话|中文|Mandarin|Chinese)[：:\s]*([优良好流利一般母语Native Fluent\w]+)/gi,
    /(?:英语|英文|English)[：:\s]*([优良好流利一般读写\w]+)/gi,
    /(?:粤语|Cantonese)[：:\s]*([优良好流利一般母语\w]+)/gi,
    /(?:日语|Japanese)[：:\s]*([N\d优良好流利一般\w]+)/gi
  ];

  for (const p of langPatterns) {
    const m = text.match(p);
    if (m) langs.push(m[0].replace(/[：:]/g, ' ').trim());
  }
  return langs;
}

function extractProjects(text) {
  const sectionMatch = text.match(
    /(?:项目经历|项目经验|Project)[：:\s]*([\s\S]+?)(?=\n(?:教育背景|工作经历|技能|荣誉|证书|Education|Skills|Employment)|$)/i
  );
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const projects = [];
  const blocks = section.split(/\n(?=[^\s·•◆])/).filter(b => b.trim().length > 5);

  for (const block of blocks) {
    const datePattern = /(\d{4}[.\-\/年]\d{1,2})\s*[-~至到—]\s*(\d{4}[.\-\/年]\d{1,2}|至今)/;
    const dateMatch = block.match(datePattern);
    const startDate = normalizeDate((dateMatch || [])[1] || '');
    const endDate = normalizeDate((dateMatch || [])[2] || '');
    const urlMatch = block.match(/https?:\/\/[^\s\n]+/);

    const blockLines = block.replace(datePattern, '').split('\n').map(l => l.trim()).filter(Boolean);
    const name = blockLines[0] || '';

    // 尝试提取项目角色（可能是第二行，或者包含"角色"、"负责人"、"Developer"等关键词的行）
    let role = '';
    let roleLineIndex = -1;
    for (let i = 1; i < blockLines.length; i++) {
      const line = blockLines[i];
      if (line.length > 0 && line.length < 30 &&
          (line.includes('角色') || line.includes('负责人') || line.includes('Developer') ||
           line.includes('Design') || line.includes('Product') ||
           line.includes('策划') || line.includes('项目经理') ||
           line.includes('Creator') || line.includes('Founder'))) {
        role = line.replace(/[：:]/, '').trim();
        roleLineIndex = i;
        break;
      }
    }

    // 描述是除了名称和角色之外的所有内容
    let description = '';
    if (roleLineIndex > 0) {
      description = blockLines.slice(1, roleLineIndex).concat(blockLines.slice(roleLineIndex + 1)).join('\n').trim();
    } else {
      description = blockLines.slice(1).join('\n').trim();
    }

    if (name && name.length < 50) {
      projects.push({ name, role, startDate, endDate, description, url: urlMatch ? urlMatch[0] : '' });
    }
  }

  return projects;
}

function normalizeDate(raw) {
  if (!raw) return '';
  const m = raw.match(/(\d{4})[.\-\/年](\d{1,2})/);
  if (!m) return raw.trim();
  return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
}

// 评估解析覆盖率（0-1）
function scoreResumeCoverage(resume) {
  let score = 0;
  if (resume.personal?.name) score += 0.2;
  if (resume.personal?.email || resume.personal?.phone) score += 0.2;
  if (resume.experience?.length > 0) score += 0.3;
  if (resume.education?.length > 0) score += 0.2;
  if (resume.skills?.length > 0) score += 0.1;
  return score;
}

// 合并本地解析和 AI 解析结果（AI 补充本地缺失字段）
function mergeResumeResults(local, ai) {
  const p = { ...local.personal };
  const ap = ai.personal || {};
  if (!p.name && ap.name) p.name = ap.name;
  if (!p.email && ap.email) p.email = ap.email;
  if (!p.phone && ap.phone) p.phone = ap.phone;
  if (!p.location && ap.location) p.location = ap.location;
  if (!p.linkedin && ap.linkedin) p.linkedin = ap.linkedin;
  if (!p.github && ap.github) p.github = ap.github;

  return {
    personal: p,
    summary: local.summary || ai.summary || '',
    experience: local.experience?.length ? local.experience : (ai.experience || []),
    education: local.education?.length ? local.education : (ai.education || []),
    skills: local.skills?.length ? local.skills : (ai.skills || []),
    languages: local.languages?.length ? local.languages : (ai.languages || []),
    projects: local.projects?.length ? local.projects : (ai.projects || [])
  };
}


// 验证和清理解析结果
function validateAndCleanResume(resume) {
  const cleaned = {
    personal: resume.personal || {},
    summary: resume.summary || '',
    experience: Array.isArray(resume.experience) ? resume.experience : [],
    education: Array.isArray(resume.education) ? resume.education : [],
    skills: Array.isArray(resume.skills) ? resume.skills : [],
    languages: Array.isArray(resume.languages) ? resume.languages : [],
    projects: Array.isArray(resume.projects) ? resume.projects : [],
    research: Array.isArray(resume.research) ? resume.research : [],
    activities: Array.isArray(resume.activities) ? resume.activities : [],
    certifications: Array.isArray(resume.certifications) ? resume.certifications : [],
    awards: Array.isArray(resume.awards) ? resume.awards : [],
    hobbies: Array.isArray(resume.hobbies) ? resume.hobbies : [],
    customSections: Array.isArray(resume.customSections) ? resume.customSections : []
  };

  // 清理空值和异常数据
  cleaned.experience = cleaned.experience.filter(exp =>
    exp && typeof exp === 'object' && (exp.company || exp.position || exp.description)
  );

  cleaned.education = cleaned.education.filter(edu =>
    edu && typeof edu === 'object' && (edu.school || edu.degree || edu.major)
  );

  cleaned.projects = cleaned.projects.filter(proj =>
    proj && typeof proj === 'object' && (proj.name || proj.description)
  );

  cleaned.research = cleaned.research.filter(r =>
    r && typeof r === 'object' && (r.institution || r.description || r.role)
  );

  cleaned.activities = cleaned.activities.filter(a =>
    a && typeof a === 'object' && (a.organization || a.description || a.role)
  );

  cleaned.customSections = cleaned.customSections.filter(sec =>
    sec && typeof sec === 'object' && sec.title && sec.content
  );

  // 确保 personal 字段完整
  const p = cleaned.personal;
  cleaned.personal = {
    name: p.name || '',
    email: p.email || '',
    phone: p.phone || '',
    location: p.location || '',
    linkedin: p.linkedin || '',
    github: p.github || '',
    website: p.website || '',
    birthDate: p.birthDate || '',
    gender: p.gender || '',
    politicalStatus: p.politicalStatus || '',
    ethnicity: p.ethnicity || ''
  };

  return cleaned;
}

// ─── API 连接测试 ─────────────────────────────────────────────────────────────

async function testAPIConnection(apiKey, apiBase, providerId) {
  try {
    const base = apiBase || API_BASES.cn;
    const provider = resolveProvider(providerId, base);
    const authToken = normalizeAuthToken(apiKey, provider);
    if (!authToken) return { success: false, message: '请先填写 API Key' };
    const testModel = resolveDefaultModel(provider.id, base);

    const content = await callChatAPI(
      base,
      authToken,
      provider,
      testModel,
      [{ role: 'user', content: '你好，请只回复"连接成功"这四个字。' }],
      { temperature: 0, max_tokens: 16 }
    );
    return { success: true, message: content.trim() || '连接成功' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── HTTP 工具 ────────────────────────────────────────────────────────────────

function buildChatEndpoint(base, provider) {
  const normalized = String(base || '').replace(/\/$/, '');

  if (provider.apiKind === 'anthropic') {
    if (normalized.endsWith('/messages')) return normalized;
    return normalized.endsWith('/v1') ? `${normalized}/messages` : `${normalized}/v1/messages`;
  }

  if (normalized.endsWith('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1') || normalized.endsWith('/openai')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function normalizeAnthropicMessages(messages) {
  return (messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: typeof message.content === 'string' ? message.content : String(message.content || '')
  }));
}

async function callChatAPI(base, apiKey, provider, model, messages, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeout || 60000;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 添加超时保护
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`API 请求超时（${timeoutMs / 1000}秒）`)), timeoutMs);
      });

      const endpoint = buildChatEndpoint(base, provider);
      const fetchPromise = fetch(endpoint, {
        method: 'POST',
        headers: provider.apiKind === 'anthropic'
          ? {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          }
          : {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
        body: JSON.stringify(provider.apiKind === 'anthropic'
          ? {
            model,
            messages: normalizeAnthropicMessages(messages),
            temperature: opts.temperature ?? 0.3,
            max_tokens: opts.max_tokens || 2048
          }
          : {
            model,
            messages,
            temperature: opts.temperature ?? 0.3,
            max_tokens: opts.max_tokens || 2048,
            stream: false,
            ...(opts.response_format ? { response_format: opts.response_format } : {})
          })
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err.error?.message || err.message || response.statusText;

        if (response.status === 401 || response.status === 403) {
          throw new Error('API Key 无效或已过期，请检查设置');
        }

        if (response.status === 429) {
          // Rate limiting - wait longer for each retry
          const waitTime = Math.pow(2, attempt) * 2000 + Math.random() * 1000; // 2-3s, 4-5s, 8-9s
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
          throw new Error('请求频率超限，已重试多次仍失败，请稍后再试');
        }

        // 更详细的错误信息，特别是 DeepSeek API
        if (provider.id === 'deepseek' && response.status === 400) {
          console.warn('DeepSeek API 详细错误:', { status: response.status, error: err, model });
          throw new Error(`DeepSeek API 错误: ${msg}\n模型: ${model}\n状态: ${response.status}\n详情: ${JSON.stringify(err)}`);
        }
        throw new Error(`API 错误 ${response.status}: ${msg}`);
      }

      const data = await response.json();
      const content = provider.apiKind === 'anthropic'
        ? data?.content?.find((item) => item?.type === 'text')?.text
        : data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('API 返回内容为空或格式异常');
      }
      return content;

    } catch (error) {
      lastError = error;
      console.warn(`API 调用失败 (尝试 ${attempt + 1}/${maxRetries}):`, error.message);
      if (error.message.includes('API Key') || error.message.includes('API 错误') || error.message.includes('超时') || attempt === maxRetries - 1) {
        throw error; // Don't retry for auth, timeout errors or final attempt
      }

      // Wait before retry for network errors
      const waitTime = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError;
}

// ─── 简历摘要生成（与 api.js 同步） ──────────────────────────────────────────

function buildResumeSummary(resume) {
  if (!resume) return '（无简历数据）';
  const p = resume.personal || {};

  // 为关键字段添加类型标识，帮助 AI 理解
  const lines = [
    '【基本信息】',
    `[姓名] ${p.name || ''}`,
    `[邮箱] ${p.email || ''}`,
    `[电话] ${p.phone || ''}`,
    `[所在地] ${p.location || ''}`,
  ];
  if (p.gender) lines.push(`[性别] ${p.gender}`);
  if (p.birthDate) lines.push(`[出生日期] ${p.birthDate}`);
  if (p.linkedin) lines.push(`[LinkedIn] ${p.linkedin}`);
  if (p.github) lines.push(`[GitHub] ${p.github}`);
  if (p.website) lines.push(`[个人网站] ${p.website}`);
  lines.push('');

  if (resume.summary) lines.push('【个人陈述/自我评价】', resume.summary, '');

  if (resume.experience?.length) {
    lines.push('【工作/实习经历】');
    resume.experience.forEach((e, idx) => {
      // 判断是否是创业经历
      const isStartup = /创始人|联合创始人|创业|自营|店长|合伙人|founder|co-founder|entrepreneur/i.test(e.position || '');
      const tag = isStartup ? '[创业]' : (e.isInternship ? '[实习]' : '[工作]');
      lines.push(`${tag}#${idx + 1}`);
      lines.push(`  [公司] ${e.company || ''}`);
      lines.push(`  [职位] ${e.position || ''}`);
      lines.push(`  [开始时间] ${e.startDate || ''}`);
      lines.push(`  [结束时间] ${e.current ? '至今' : (e.endDate || '')}`);
      if (isStartup) lines.push(`  [备注] 此条为创业经历，适合填入"创业类经历"表单分区`);
      if (e.description) lines.push(`  [描述] ${e.description}`);
    });
    lines.push('');
  }

  if (resume.education?.length) {
    lines.push('【教育背景】');
    resume.education.forEach((e, idx) => {
      lines.push(`教育#${idx + 1}`);
      lines.push(`  [学校] ${e.school || ''}`);
      lines.push(`  [学位] ${e.degree || ''}`);
      lines.push(`  [专业] ${e.major || ''}`);
      lines.push(`  [开始时间] ${e.startDate || ''}`);
      lines.push(`  [结束时间] ${e.endDate || ''}`);
      if (e.gpa) lines.push(`  [GPA] ${e.gpa}`);
      if (e.description) lines.push(`  [描述] ${e.description}`);
    });
    lines.push('');
  }

  if (resume.projects?.length) {
    lines.push('【项目经历】');
    resume.projects.forEach((proj, idx) => {
      lines.push(`项目#${idx + 1}`);
      lines.push(`  [项目名] ${proj.name || ''}`);
      if (proj.role) lines.push(`  [角色] ${proj.role}`);
      lines.push(`  [开始时间] ${proj.startDate || ''}`);
      lines.push(`  [结束时间] ${proj.endDate || ''}`);
      if (proj.description) lines.push(`  [描述] ${proj.description}`);
      if (proj.url) lines.push(`  [链接] ${proj.url}`);
    });
    lines.push('');
  }

  if (resume.research?.length) {
    lines.push('【科研经历】');
    resume.research.forEach((r, idx) => {
      lines.push(`科研#${idx + 1}`);
      lines.push(`  [机构] ${r.institution || ''}`);
      if (r.role) lines.push(`  [角色] ${r.role}`);
      if (r.advisor) lines.push(`  [导师] ${r.advisor}`);
      lines.push(`  [开始时间] ${r.startDate || ''}`);
      lines.push(`  [结束时间] ${r.endDate || ''}`);
      if (r.description) lines.push(`  [描述] ${r.description}`);
    });
    lines.push('');
  }

  if (resume.activities?.length) {
    lines.push('【校园/社团经历】');
    resume.activities.forEach((a, idx) => {
      lines.push(`活动#${idx + 1}`);
      lines.push(`  [组织] ${a.organization || ''}`);
      if (a.role) lines.push(`  [职务] ${a.role}`);
      lines.push(`  [开始时间] ${a.startDate || ''}`);
      lines.push(`  [结束时间] ${a.endDate || ''}`);
      if (a.description) lines.push(`  [描述] ${a.description}`);
    });
    lines.push('');
  }

  if (resume.skills?.length) lines.push(`[技能] ${resume.skills.join(', ')}`, '');
  if (resume.languages?.length) lines.push(`[语言] ${resume.languages.join(', ')}`, '');
  if (resume.certifications?.length) lines.push(`[证书] ${resume.certifications.join(', ')}`, '');
  if (resume.awards?.length) lines.push(`[荣誉奖项] ${resume.awards.join(', ')}`, '');
  if (resume.hobbies?.length) lines.push(`[兴趣爱好] ${resume.hobbies.join(', ')}`, '');

  if (resume.customSections?.length) {
    resume.customSections.forEach(sec => {
      lines.push(`【${sec.title}】`, sec.content, '');
    });
  }

  return lines.join('\n');
}
