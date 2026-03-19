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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function normalizeBridgeConfig(settings = {}) {
  return {
    enabled: !!settings.bridgeEnabled,
    url: String(settings.bridgeUrl || '').trim(),
    token: String(settings.bridgeToken || '').trim(),
    timeoutMs: Math.max(5000, (Number(settings.bridgeTimeoutSec) || 45) * 1000)
  };
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

    case 'TEST_BRIDGE':
      testBridgeConnection(msg.bridgeUrl, msg.bridgeToken, msg.bridgeTimeoutSec).then(sendResponse).catch(e => sendResponse({ success: false, message: e.message }));
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

async function handleFullFill({ tabId, resume, apiKey, apiBase, providerId, model, visionModel }) {
  try {
    const storageData = await chrome.storage.local.get('cvflash_settings');
    const bridgeConfig = normalizeBridgeConfig(storageData.cvflash_settings || {});

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
    const allCommands = [];
    let totalAiMatched = 0;

    for (const [sectionName, sectionFields] of Object.entries(sectionGroups)) {
      currentSection++;
      const progress = 20 + Math.floor((currentSection / totalSections) * 50);

      updateFillStatus('matching', `[${currentSection}/${totalSections}] 正在处理 ${sectionName}...`, progress);
      console.log(`\n=== 处理分区: ${sectionName} (${sectionFields.length} 个字段) ===`);

      // AI 完全自主决策
      const aiResult = await handleAIMatch({
        tabId, fields: sectionFields, resume, apiKey, apiBase, providerId, model, visionModel, bridgeConfig,
        sectionContext: sectionName
      });

      if (aiResult.error) {
        console.warn(`分区 ${sectionName} AI 匹配失败:`, aiResult.error);
        continue; // 分区失败不影响其他分区
      }

      Object.assign(allFieldMap, aiResult.fieldMap);
      allCommands.push(...(aiResult.commands || []));
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

    const fillResp = allCommands.length
      ? await sendToTab(tabId, { action: 'APPLY_COMMANDS', commands: allCommands })
      : await sendToTab(tabId, { action: 'AUTOFILL', fieldMap: allFieldMap });
    if (fillResp?.error) {
      updateFillStatus('error', '填充失败: ' + fillResp.error);
      return fillResp;
    }
    const appliedCount = fillResp?.filledCount ?? fillResp?.appliedCount ?? 0;

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
      filledCount: appliedCount,
      timestamp: new Date().toISOString()
    });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ cvflash_history: history });

    updateFillStatus('done', `已填充 ${appliedCount} 个字段（AI 匹配 ${totalAiMatched}）`, 100);
    console.log(`=== 填充完成: ${appliedCount}/${fields.length} 个字段 ===`);

    return { fieldMap: allFieldMap, filledCount: appliedCount, totalFields: fields.length };

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
  console.log('[预分析] resume keys:', Object.keys(resume));
  console.log('[预分析] r keys:', Object.keys(r));
  console.log('[预分析] r.personal:', r.personal);
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

// ─── 本地高置信映射 + AI/视觉补齐 ───────────────────────────────────────────

function sortResumeEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    const latestDiff = getEntryLatestMonth(b) - getEntryLatestMonth(a);
    if (latestDiff !== 0) return latestDiff;
    return getEntryStartMonth(b) - getEntryStartMonth(a);
  });
}

function getEntryLatestMonth(entry) {
  if (!entry) return 0;
  if (entry.current) return 999912;
  return parseMonthKey(entry.endDate) || parseMonthKey(entry.startDate) || 0;
}

function getEntryStartMonth(entry) {
  if (!entry) return 0;
  return parseMonthKey(entry.startDate) || 0;
}

function parseMonthKey(raw) {
  const str = String(raw || '').trim();
  const match = str.match(/(\d{4})[-/.年]?(\d{1,2})?/);
  if (!match) return 0;
  return Number(match[1]) * 100 + Number(match[2] || '1');
}

function normalizeResumeForFill(resume) {
  const source = resume?.resume || resume || {};
  return {
    ...source,
    personal: source.personal || {},
    summary: source.summary || '',
    experience: sortResumeEntries(source.experience || []),
    education: sortResumeEntries(source.education || []),
    projects: sortResumeEntries(source.projects || []),
    research: sortResumeEntries(source.research || []),
    activities: sortResumeEntries(source.activities || []),
    skills: Array.isArray(source.skills) ? source.skills : [],
    languages: Array.isArray(source.languages) ? source.languages : [],
    certifications: Array.isArray(source.certifications) ? source.certifications : [],
    awards: Array.isArray(source.awards) ? source.awards : [],
    hobbies: Array.isArray(source.hobbies) ? source.hobbies : [],
    customSections: Array.isArray(source.customSections) ? source.customSections : []
  };
}

function sortFieldsForMatching(fields) {
  return [...fields].sort((a, b) => {
    const yDiff = (a.bbox?.y ?? 0) - (b.bbox?.y ?? 0);
    if (Math.abs(yDiff) > 6) return yDiff;
    const xDiff = (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0);
    if (xDiff !== 0) return xDiff;
    return a._domIndex - b._domIndex;
  });
}

function inferSectionCategory(sectionContext, fields) {
  const scores = {
    personal: 0,
    summary: 0,
    education: 0,
    experience: 0,
    projects: 0,
    research: 0,
    activities: 0,
    skills: 0,
    languages: 0
  };

  const scoreText = (text, rules) => {
    for (const [category, pattern, weight] of rules) {
      if (pattern.test(text)) scores[category] += weight;
    }
  };

  scoreText(String(sectionContext || '').toLowerCase(), [
    ['personal', /基本|个人|信息|profile|personal|contact/, 5],
    ['summary', /简介|概述|summary|objective|profile|自我评价|求职意向/, 5],
    ['education', /教育|学历|学校|education/, 5],
    ['experience', /工作|实习|职业|employment|experience|career/, 5],
    ['projects', /项目|project|作品/, 5],
    ['research', /科研|研究|research|lab/, 5],
    ['activities', /社团|校园|活动|志愿|student|activity/, 5],
    ['skills', /技能|skill|expertise/, 5],
    ['languages', /语言|language/, 5]
  ]);

  for (const field of fields) {
    const label = `${field.label || ''} ${field.name || ''} ${field.placeholder || ''}`.toLowerCase();
    const hint = String(field.hint || '').toLowerCase();

    if (['name', 'firstname', 'lastname', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio'].includes(hint)) scores.personal += 3;
    if (['school', 'degree', 'major', 'gpa', 'graduation'].includes(hint)) scores.education += 3;
    if (['company', 'position', 'department', 'jobstartdate', 'jobenddate', 'worktype', 'yearsexp'].includes(hint)) scores.experience += 3;
    if (hint === 'skills') scores.skills += 3;
    if (hint === 'languages') scores.languages += 3;

    scoreText(label, [
      ['personal', /姓名|邮箱|电话|手机|location|地址|linkedin|github/, 2],
      ['summary', /自我评价|个人简介|求职意向|summary|cover/, 2],
      ['education', /学校|大学|学历|学位|专业|gpa|毕业/, 2],
      ['experience', /公司|部门|职位|岗位|工作类型|入职|离职|在职|职责|工作内容/, 2],
      ['projects', /项目名称|项目角色|项目描述|project/, 2],
      ['research', /实验室|导师|研究方向|research|advisor/, 2],
      ['activities', /社团|组织|活动|学生会|志愿/, 2],
      ['skills', /技能|skill|expertise/, 2],
      ['languages', /语言|english|英语|日语|德语/, 2]
    ]);
  }

  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return winner && winner[1] > 0 ? winner[0] : 'other';
}

function splitPersonName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return { firstName: '', lastName: '' };
  if (/[\u4e00-\u9fff]/.test(name) && name.length >= 2 && name.length <= 4) {
    return { lastName: name.slice(0, 1), firstName: name.slice(1) };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: name, lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) || '' };
}

function matchesPattern(text, pattern) {
  return pattern.test(String(text || '').toLowerCase());
}

function inferFieldBinding(field, sectionCategory) {
  const text = `${field.label || ''} ${field.name || ''} ${field.placeholder || ''}`.toLowerCase();
  const hint = String(field.hint || '').toLowerCase();

  if (hint === 'name' || matchesPattern(text, /full.?name|姓名|姓名拼音/)) return { scope: 'personal', slot: 'name' };
  if (hint === 'firstname' || matchesPattern(text, /first.?name|名(?!称)|given.?name/)) return { scope: 'personal', slot: 'firstName' };
  if (hint === 'lastname' || matchesPattern(text, /last.?name|姓|family.?name|surname/)) return { scope: 'personal', slot: 'lastName' };
  if (hint === 'email') return { scope: 'personal', slot: 'email' };
  if (hint === 'phone') return { scope: 'personal', slot: 'phone' };
  if (hint === 'location' || matchesPattern(text, /location|城市|地址|所在地|居住地/)) return { scope: 'personal', slot: 'location' };
  if (hint === 'linkedin') return { scope: 'personal', slot: 'linkedin' };
  if (hint === 'github') return { scope: 'personal', slot: 'github' };
  if (hint === 'portfolio' || matchesPattern(text, /website|portfolio|个人网站|博客/)) return { scope: 'personal', slot: 'website' };

  if (sectionCategory === 'summary' || matchesPattern(text, /summary|profile|自我评价|个人简介|求职意向/)) {
    return { scope: 'summary', slot: 'summary' };
  }
  if (sectionCategory === 'skills' || hint === 'skills' || matchesPattern(text, /技能|skill|expertise/)) {
    return { scope: 'skills', slot: 'list' };
  }
  if (sectionCategory === 'languages' || hint === 'languages' || matchesPattern(text, /语言|language|英语|日语|德语|法语/)) {
    return { scope: 'languages', slot: 'list' };
  }

  if (sectionCategory === 'education') {
    if (hint === 'school' || matchesPattern(text, /school|university|college|学校|大学|院校/)) return { scope: 'education', slot: 'school' };
    if (hint === 'degree' || matchesPattern(text, /degree|学历|学位|education.?level/)) return { scope: 'education', slot: 'degree' };
    if (hint === 'major' || matchesPattern(text, /major|专业|field.?of.?study|discipline/)) return { scope: 'education', slot: 'major' };
    if (hint === 'gpa' || matchesPattern(text, /gpa|绩点|成绩/)) return { scope: 'education', slot: 'gpa' };
    if (hint === 'currentflag' || matchesPattern(text, /至今|在读|current|present|ongoing/)) return { scope: 'education', slot: 'current' };
    if (hint === 'startdate' || matchesPattern(text, /start|from|开始|入学/)) return { scope: 'education', slot: 'startDate' };
    if (hint === 'graduation' || hint === 'jobenddate' || matchesPattern(text, /graduat|end|to|毕业|结束/)) return { scope: 'education', slot: 'endDate' };
    if (hint === 'description' || matchesPattern(text, /课程|补充信息|描述|说明/)) return { scope: 'education', slot: 'description' };
  }

  if (sectionCategory === 'experience') {
    if (hint === 'company' || matchesPattern(text, /company|employer|organization|公司|单位|雇主/)) return { scope: 'experience', slot: 'company' };
    if (hint === 'department' || matchesPattern(text, /department|部门/)) return { scope: 'experience', slot: 'department' };
    if (hint === 'position' || matchesPattern(text, /position|job.?title|岗位|职位|职务|role/)) return { scope: 'experience', slot: 'position' };
    if (hint === 'worktype' || matchesPattern(text, /work.?type|employment.?type|job.?type|全职|兼职|实习/)) return { scope: 'experience', slot: 'workType' };
    if (hint === 'currentflag' || matchesPattern(text, /至今|在职|current|present|ongoing/)) return { scope: 'experience', slot: 'current' };
    if (hint === 'jobstartdate' || hint === 'startdate' || matchesPattern(text, /start|from|开始|入职|任职/)) return { scope: 'experience', slot: 'startDate' };
    if (hint === 'jobenddate' || matchesPattern(text, /end|to|until|结束|离职|在职/)) return { scope: 'experience', slot: 'endDate' };
    if (hint === 'description' || matchesPattern(text, /description|responsibilit|duties|工作内容|职责|经历描述|工作描述/)) return { scope: 'experience', slot: 'description' };
  }

  if (sectionCategory === 'projects') {
    if (matchesPattern(text, /project.?name|项目名称|项目名|课题名称|名称/)) return { scope: 'projects', slot: 'name' };
    if (hint === 'position' || matchesPattern(text, /role|职责|角色|担任/)) return { scope: 'projects', slot: 'role' };
    if (hint === 'currentflag' || matchesPattern(text, /至今|当前|current|present|ongoing/)) return { scope: 'projects', slot: 'current' };
    if (hint === 'startdate' || matchesPattern(text, /start|from|开始/)) return { scope: 'projects', slot: 'startDate' };
    if (hint === 'jobenddate' || matchesPattern(text, /end|to|结束/)) return { scope: 'projects', slot: 'endDate' };
    if (hint === 'description' || matchesPattern(text, /description|项目描述|介绍|内容/)) return { scope: 'projects', slot: 'description' };
    if (hint === 'portfolio' || matchesPattern(text, /url|link|链接|网址|仓库/)) return { scope: 'projects', slot: 'url' };
  }

  if (sectionCategory === 'research') {
    if (matchesPattern(text, /institution|lab|实验室|研究机构|大学|院系/)) return { scope: 'research', slot: 'institution' };
    if (hint === 'position' || matchesPattern(text, /role|角色|职务|身份/)) return { scope: 'research', slot: 'role' };
    if (matchesPattern(text, /advisor|导师|pi/)) return { scope: 'research', slot: 'advisor' };
    if (hint === 'currentflag' || matchesPattern(text, /至今|当前|current|present|ongoing/)) return { scope: 'research', slot: 'current' };
    if (hint === 'startdate' || matchesPattern(text, /start|from|开始/)) return { scope: 'research', slot: 'startDate' };
    if (hint === 'jobenddate' || matchesPattern(text, /end|to|结束/)) return { scope: 'research', slot: 'endDate' };
    if (hint === 'description' || matchesPattern(text, /research|研究内容|描述|方向/)) return { scope: 'research', slot: 'description' };
  }

  if (sectionCategory === 'activities') {
    if (matchesPattern(text, /organization|社团|组织|学生会|协会|活动单位/)) return { scope: 'activities', slot: 'organization' };
    if (hint === 'position' || matchesPattern(text, /role|角色|职务|岗位/)) return { scope: 'activities', slot: 'role' };
    if (hint === 'currentflag' || matchesPattern(text, /至今|当前|current|present|ongoing/)) return { scope: 'activities', slot: 'current' };
    if (hint === 'startdate' || matchesPattern(text, /start|from|开始/)) return { scope: 'activities', slot: 'startDate' };
    if (hint === 'jobenddate' || matchesPattern(text, /end|to|结束/)) return { scope: 'activities', slot: 'endDate' };
    if (hint === 'description' || matchesPattern(text, /活动内容|描述|经历|工作内容/)) return { scope: 'activities', slot: 'description' };
  }

  return null;
}

function buildLocalFieldMap(fields, resume, sectionContext = '') {
  const sectionCategory = inferSectionCategory(sectionContext, fields);
  const result = {};

  for (const group of buildSectionEntryGroups(fields, sectionCategory)) {
    for (const field of group.fields) {
      const binding = inferFieldBinding(field, sectionCategory);
      if (!binding) continue;

      const entryIndex = isRepeatableSectionCategory(binding.scope) ? group.index : 0;
      const rawValue = getBindingValue(binding, resume, field, entryIndex);
      const normalizedValue = normalizeValueForField(rawValue, field, binding);
      if (normalizedValue == null) continue;

      result[field._domIndex] = normalizedValue;
    }
  }

  return result;
}

function getBindingValue(binding, resume, field, entryIndex) {
  if (binding.scope === 'personal') {
    const personal = resume.personal || {};
    if (binding.slot === 'firstName') return splitPersonName(personal.name).firstName;
    if (binding.slot === 'lastName') return splitPersonName(personal.name).lastName;
    return personal[binding.slot] ?? '';
  }

  if (binding.scope === 'summary') {
    return resume.summary || '';
  }

  if (binding.scope === 'skills') {
    return joinListForField(resume.skills || [], field);
  }

  if (binding.scope === 'languages') {
    return joinListForField(resume.languages || [], field);
  }

  const entries = Array.isArray(resume[binding.scope]) ? resume[binding.scope] : [];
  const entry = entries[entryIndex];
  if (!entry) return '';

  if (binding.scope === 'experience' && binding.slot === 'company') {
    return entry.company || entry.employer || entry.organization || '';
  }
  if (binding.scope === 'experience' && binding.slot === 'department') {
    return entry.department || entry.team || entry.businessUnit || '';
  }
  if (binding.scope === 'experience' && binding.slot === 'position') {
    return entry.position || entry.role || entry.title || entry.jobTitle || '';
  }
  if (binding.scope === 'experience' && binding.slot === 'workType') {
    return entry.workType || inferEmploymentType(entry, field);
  }
  if (binding.slot === 'current') {
    return !!entry.current;
  }
  if (binding.scope === 'experience' && binding.slot === 'endDate') {
    return entry.current ? '' : (entry.endDate || '');
  }

  if (binding.scope === 'education' && binding.slot === 'endDate') {
    return entry.endDate || '';
  }

  if (binding.scope === 'projects' && binding.slot === 'role') {
    return entry.role || entry.position || entry.title || '';
  }

  return entry[binding.slot] ?? '';
}

function joinListForField(items, field) {
  const values = (items || []).map(item => String(item || '').trim()).filter(Boolean);
  if (!values.length) return '';
  return field.type === 'textarea' || field.type === 'contenteditable'
    ? values.join('\n')
    : values.join(', ');
}

function inferEmploymentType(entry, field) {
  const desired = entry?.isInternship || /实习|intern/i.test(`${entry?.position || ''} ${entry?.company || ''}`)
    ? '实习'
    : '全职';
  return field.options?.length ? pickBestOption(field.options, desired) : desired;
}

function normalizeValueForField(value, field, binding = null) {
  if (value == null) return null;
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    const str = String(value).trim().toLowerCase();
    if (!str) return false;
    return ['true', '1', 'yes', 'checked', '至今', '当前', 'current', 'present'].includes(str);
  }
  if (typeof value === 'string' && !value.trim()) return '';

  let normalized = String(value).trim();
  const hint = String(field.hint || '').toLowerCase();
  const label = `${field.label || ''} ${field.name || ''}`.toLowerCase();

  if (binding?.slot?.toLowerCase().includes('date') || field.type === 'date' || field.type === 'month' || /日期|时间|from|to|start|end|毕业|入学|在职/.test(label)) {
    normalized = normalizeMonthValue(normalized);
  }

  if (hint === 'phone' || /电话|手机|tel|phone/.test(label)) {
    normalized = normalized.replace(/[^\d+]/g, '');
  }

  if (hint === 'email') {
    normalized = normalized.toLowerCase();
  }

  if (field.options?.length) {
    normalized = pickBestOption(field.options, normalized);
  }

  return normalized;
}

function normalizeMonthValue(value) {
  const str = String(value || '').trim();
  if (!str) return '';
  if (/^\d{4}-\d{2}$/.test(str) || /^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const match = str.match(/(\d{4})[./年-](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}`;
  if (/^\d{4}$/.test(str)) return `${str}-01`;
  return str;
}

function pickBestOption(options, desiredValue) {
  const desired = String(desiredValue || '').trim();
  if (!desired) return '';

  const normalize = (text) => String(text || '').replace(/[\s\-_.,()（）【】/]/g, '').toLowerCase();
  const desiredNorm = normalize(desired);
  const candidates = options.map(option => String(option || '').trim()).filter(Boolean);

  const exact = candidates.find(option => option === desired);
  if (exact) return exact;

  const lowered = desired.toLowerCase();
  const contains = candidates.find(option => option.toLowerCase() === lowered || option.toLowerCase().includes(lowered) || lowered.includes(option.toLowerCase()));
  if (contains) return contains;

  const normalizedMatch = candidates.find(option => normalize(option) === desiredNorm || normalize(option).includes(desiredNorm) || desiredNorm.includes(normalize(option)));
  if (normalizedMatch) return normalizedMatch;

  const synonymMap = [
    [['实习', 'internship', 'intern'], /实习|intern/],
    [['全职', 'fulltime', 'full-time'], /全职|full.?time|正式/],
    [['兼职', 'parttime', 'part-time'], /兼职|part.?time/],
    [['本科', 'bachelor', '学士'], /本科|学士|bachelor/],
    [['硕士', 'master'], /硕士|master|msc|ma/],
    [['博士', 'phd', 'doctor'], /博士|phd|doctor/]
  ];

  for (const [keywords, pattern] of synonymMap) {
    if (!pattern.test(desired.toLowerCase())) continue;
    const synonym = candidates.find(option => keywords.some(keyword => normalize(option).includes(normalize(keyword))));
    if (synonym) return synonym;
  }

  return desired;
}

function isSelectLikeField(field) {
  return field?.tagName === 'SELECT'
    || field?.type === 'aria-combobox'
    || !!field?.options?.length;
}

function buildCommandForField(field, value) {
  if (value == null) return null;
  if (value === '') {
    return { action: 'clear', domIndex: field._domIndex };
  }
  if (field.type === 'checkbox') {
    return { action: 'toggle', domIndex: field._domIndex, value: Boolean(value) };
  }
  if (isSelectLikeField(field)) {
    return { action: 'select', domIndex: field._domIndex, value: String(value) };
  }
  return { action: 'set', domIndex: field._domIndex, value: String(value) };
}

function fieldMapToCommands(fieldMap, fields) {
  return Object.entries(fieldMap || {})
    .map(([domIndex, value]) => {
      const field = fields.find(item => item._domIndex === Number(domIndex));
      if (!field) return null;
      return buildCommandForField(field, value);
    })
    .filter(Boolean);
}

function isRepeatableSectionCategory(sectionCategory) {
  return ['education', 'experience', 'projects', 'research', 'activities'].includes(sectionCategory);
}

function buildSectionEntryGroups(fields, sectionCategory) {
  const sortedFields = sortFieldsForMatching(fields);
  if (!sortedFields.length) return [];

  if (!isRepeatableSectionCategory(sectionCategory)) {
    return [{ key: 'single', index: 0, fields: sortedFields }];
  }

  const explicitGroups = new Map();
  for (const field of sortedFields) {
    const key = field.group?.id || '';
    if (!key) continue;
    if (!explicitGroups.has(key)) explicitGroups.set(key, []);
    explicitGroups.get(key).push(field);
  }

  const meaningfulGroups = [...explicitGroups.entries()]
    .filter(([, groupFields]) => groupFields.length >= 2)
    .sort((a, b) => getGroupTop(a[1]) - getGroupTop(b[1]));

  if (meaningfulGroups.length >= 2) {
    return meaningfulGroups.map(([key, groupFields], index) => ({
      key,
      index,
      fields: sortFieldsForMatching(groupFields)
    }));
  }

  return [{ key: 'single', index: 0, fields: sortedFields }];
}

function getGroupTop(fields) {
  return Math.min(...fields.map(field => field.bbox?.y ?? 0));
}

// ─── AI 字段匹配（纯文本模式）────────────────────────────────────────────────

async function handleAIMatch({ tabId, fields, resume, apiKey, apiBase, providerId, model, visionModel, bridgeConfig, sectionContext = '' }) {
  const base = apiBase || API_BASES.cn;
  const provider = resolveProvider(providerId, base);
  const normalizedResume = normalizeResumeForFill(resume);
  const resumeSummary = buildResumeSummary(normalizedResume);
  let fieldMap = buildLocalFieldMap(fields, normalizedResume, sectionContext);
  let commands = fieldMapToCommands(fieldMap, fields);

  console.log('=== 开始 AI 字段匹配 ===');
  console.log(`分区: ${sectionContext || '全表单'}`);
  console.log(`字段数量: ${fields.length}`);
  console.log(`API 端点: ${base}`);
  console.log(`供应商: ${provider.label}`);
  console.log(`使用模型: ${model || 'default'}`);

  let unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null);
  if (!unresolvedFields.length) {
    return { fieldMap, commands };
  }

  if (bridgeConfig?.enabled && bridgeConfig.url) {
    try {
      updateFillStatus('matching', `正在通过 Bridge 处理 ${sectionContext || '当前分区'}...`, 46);
      const bridgeResult = await callBridgeAPI({
        tabId,
        bridgeConfig,
        fields: unresolvedFields,
        allFields: fields,
        resume: normalizedResume,
        sectionContext,
        existingFieldMap: fieldMap,
        includeScreenshot: !!visionModel
      });
      const bridgeCommands = parseBridgeCommands(bridgeResult, unresolvedFields, normalizedResume);
      if (bridgeCommands.length) {
        const bridgeMap = commandsToFieldMap(bridgeCommands, unresolvedFields);
        fieldMap = { ...fieldMap, ...bridgeMap };
        commands.push(...bridgeCommands);
        unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null);
        if (!unresolvedFields.length) {
          return { fieldMap, commands: dedupeCommands(commands) };
        }
      }
    } catch (error) {
      console.warn('Bridge 调用失败，回退内置模型链路:', error.message);
    }
  }

  updateFillStatus('matching', `正在补齐 ${sectionContext || '当前分区'} 的剩余 ${unresolvedFields.length} 个字段...`, 48);
  const structuredPrompt = buildStructuredFieldPrompt(unresolvedFields);
  const authToken = normalizeAuthToken(apiKey, provider);
  if (!authToken) {
    throw new Error('Bridge 未返回有效命令，且未配置 API Key，无法继续使用内置模型链路');
  }

  // 纯文本模式：仅发送结构化字段数据（AI 完全自主决策，不受本地规则干扰）
  const messages = [{
    role: 'user',
    content: buildCommandFillPrompt(structuredPrompt, resumeSummary, fields, sectionContext, fieldMap)
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
      const simplifiedPrompt = buildSimplifiedCommandPrompt(unresolvedFields, resumeSummary, fieldMap, fields);
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
  let aiCommands = parseCommandResponse(response, unresolvedFields, normalizedResume);
  let aiFieldMap = commandsToFieldMap(aiCommands, unresolvedFields);
  if (!aiCommands.length && typeof response === 'string' && response.trim()) {
    updateFillStatus('matching', '正在修正 AI 返回格式...', 55);
    const repairedResponse = await repairFillResponse(base, authToken, provider, resolvedModel, response);
    aiCommands = parseCommandResponse(repairedResponse, unresolvedFields, normalizedResume);
    aiFieldMap = commandsToFieldMap(aiCommands, unresolvedFields);
  }
  fieldMap = { ...fieldMap, ...aiFieldMap };
  commands.push(...aiCommands);

  unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null);

  if (unresolvedFields.length > 0 && provider.supportsVision && visionModel) {
    try {
      updateFillStatus('matching', `正在用视觉模式校准剩余 ${unresolvedFields.length} 个字段...`, 58);
      const visionMap = await handleVisionFieldMatch({
        tabId,
        fields: unresolvedFields,
        allFields: fields,
        existingFieldMap: fieldMap,
        resumeSummary,
        resume: normalizedResume,
        apiKey: authToken,
        apiBase: base,
        provider,
        visionModel,
        sectionContext
      });
      fieldMap = { ...fieldMap, ...visionMap };
      commands.push(...fieldMapToCommands(visionMap, unresolvedFields));
      unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null);
    } catch (error) {
      console.warn('视觉校准失败，继续文本流程:', error.message);
    }
  }

  if (unresolvedFields.length > 0 && unresolvedFields.length < fields.length) {
    try {
      updateFillStatus('matching', `AI 正在二次校准剩余 ${unresolvedFields.length} 个字段...`, 62);
      const refineResponse = await callChatAPI(base, authToken, provider, resolvedModel, [{
        role: 'user',
        content: buildFocusedCommandPrompt(unresolvedFields, resumeSummary, fields, fieldMap)
      }], {
        ...requestOpts,
        max_tokens: 3072,
        timeout: 45000
      });
      const refinedCommands = parseCommandResponse(refineResponse, unresolvedFields, normalizedResume);
      const refinedMap = commandsToFieldMap(refinedCommands, unresolvedFields);
      fieldMap = { ...fieldMap, ...refinedMap };
      commands.push(...refinedCommands);
    } catch (error) {
      console.warn('二次 AI 校准失败，保留首次结果:', error.message);
    }
  }

  console.log('=== 字段匹配完成 ===');
  return { fieldMap, commands: dedupeCommands(commands) };
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
    if (groupMap.size > 1) {
      lines.push(`  ⚠ 此分区有 ${groupMap.size} 组条目，每组必须对应简历的一条独立记录（第1组=最近，第2组=次近）`);
    }
    for (const [gid, groupFields] of groupMap) {
      if (groupMap.size > 1) {
        groupIdx++;
        lines.push(`  └─ 第${groupIdx}组（对应简历第${groupIdx}条记录）:`);
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
        const checkedHint = f.type === 'checkbox' ? ` checked=${Boolean(f.checked)}` : '';
        const requiredHint = f.required ? ' required' : '';
        const autoHint = f.autocomplete ? ` autocomplete="${f.autocomplete}"` : '';
        const inputModeHint = f.inputMode ? ` inputMode="${f.inputMode}"` : '';
        lines.push(`${prefix}#${f._domIndex}: label="${f.label || f.name || f.placeholder || '?'}" [${f.type}]${semanticHint}${requiredHint}${checkedHint}${nameHint}${placeholderHint}${autoHint}${inputModeHint}${currentValueHint}${opts}${siblings} ${pos}`.trim());
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
function buildCommandFillPrompt(structuredFields, resumeSummary, fields, sectionContext = '', existingFieldMap = {}) {
  const contextSection = sectionContext ? `\n【当前处理分区】${sectionContext}` : '';
  const existingMatches = Object.keys(existingFieldMap || {}).length
    ? `\n【已高置信确定字段】\n${buildExistingMatchesPrompt(existingFieldMap, fields)}\n- 上述字段已确定，不要改动，只补齐仍未确定的字段。`
    : '';

  return `你是招聘表单智能填充专家。请根据简历数据精准填充每一个表单字段。你的输出必须是“执行命令列表”。${contextSection}${existingMatches}

【待补齐字段列表】
${structuredFields}

【简历完整信息】
${resumeSummary}

【核心规则 - 严格遵守】

规则1: 字段语义精准匹配（最重要！）
- "学校名称" → 只能填学校全称（如"拜罗伊特大学"），绝不能填日期、GPA
- "专业名称" → 只能填专业名（如"金融与成本控制"），绝不能填日期、学位
- "学历" → 只能填学位等级（硕士/本科/博士/大专），绝不能填 GPA 或专业
- "公司名称" → 只能填公司全称，绝不能填人名或职位
- "职位名称" → 只能填职位（如"数据营销实习生"），绝不能填公司名
- "部门名称" → 只能填部门（如"市场部"），简历无此信息则返回 ""
- "工作类型" → 只能从选项中选（全职/兼职/实习等），绝不能填工作描述或项目名
- "工作描述" → 填该条经历的具体描述内容，每条经历描述必须不同
- "在职时间/在校时间" → 只能填日期（YYYY-MM 或 YYYY/MM），绝不能填其他内容
- "GPA/成绩" → 只能填数字成绩（如"3.8"），绝不能填到学历字段

规则2: 同组字段 = 同一条简历记录
- 第1组（学校名称+专业+学历+时间）→ 必须全部来自简历的同一条教育经历
- 第2组（学校名称+专业+学历+时间）→ 必须全部来自简历的另一条教育经历
- 同理：每组工作经历的（公司+职位+部门+时间+描述）必须来自同一条
- 绝对禁止跨记录混搭（不能把A公司的职位填到B公司那组）

规则3: 按时间从近到远排列
- 第1组 = 最近的经历，第2组 = 次近的经历，以此类推

规则4: 强制覆盖 + 清除无数据字段
- 有简历数据：无论字段是否已有值，都用简历数据覆盖
- 无简历数据：返回空字符串 ""（清除旧的残留数据）
- 只有完全不相关的字段才返回 null（表示不动）

规则5: 选项字段严格匹配
- 有选项列表的字段，返回值必须是选项之一
- 可做语义同义转换：简历写"本科" → 选项里找"本科/Bachelor/学士"
- 工作类型：实习经历→选"实习"，正式工作→选"全职"
- 对于复选框字段（如"至今/当前在职/当前在读"），返回 true 或 false

规则6: 数据格式
- 日期：返回 YYYY-MM 格式（如 2024-09）
- 邮箱：必须含 @
- 电话：纯数字
- 描述：保留完整内容，每条经历的描述必须是该条经历自己的描述

【输出】
返回纯 JSON 数组，每项一条命令：
{"action":"set|select|clear|toggle","domIndex":数字,"value":"字符串或布尔值","reason":"可选"}

规则：
- 普通输入框/文本域/日期输入框 → action="set"
- 下拉/可搜索下拉/combobox → action="select"
- 需要清空旧值 → action="clear"
- 复选框（至今/当前） → action="toggle"，value 为 true/false
- 完全不相关的字段不要输出命令

示例：
[{"action":"set","domIndex":0,"value":"丁宏磊"},{"action":"select","domIndex":5,"value":"实习"},{"action":"clear","domIndex":6},{"action":"toggle","domIndex":12,"value":true}]`;
}

function buildFocusedCommandPrompt(unresolvedFields, resumeSummary, allFields, existingFieldMap = {}) {
  return `第二轮精准校准。参考已确定字段，处理剩余字段。

【已确定字段】
${buildExistingMatchesPrompt(existingFieldMap, allFields)}

【待匹配字段】
${buildStructuredFieldPrompt(unresolvedFields)}

【简历数据】
${resumeSummary}

【校准规则】
- 字段语义精准：学校名→只填学校名，职位→只填职位，学历→只填学位等级
- 工作类型→全职/兼职/实习，不是工作描述
- 复选框（至今/当前）使用 toggle 命令，value 为 true/false
- 同组字段对应同一条简历记录
- 简历无此数据→""（清除旧值），完全不相关→null
- 不要改写已确定字段
- 每条经历的描述必须独立，不能复制其他经历的描述

只返回待匹配字段的命令 JSON 数组。`;
}

/**
 * 构建简化 prompt（降级模式，减少 token 消耗）
 */
function buildSimplifiedCommandPrompt(fields, resumeSummary, existingFieldMap = {}, allFields = fields) {
  // 只保留关键字段信息，减少 token 消耗
  const simpleFields = fields.map(f => ({
    i: f._domIndex,
    l: f.label || f.name || f.placeholder || '?',
    t: f.type,
    h: f.hint !== 'unknown' ? f.hint : undefined,
    s: f.section || undefined,
    o: f.options?.slice(0, 5)
  }));

  return `招聘表单填充。精准匹配简历数据到表单字段，并输出命令列表。

【已确定字段】
${buildExistingMatchesPrompt(existingFieldMap, allFields)}

【字段列表】
${JSON.stringify(simpleFields)}

【简历摘要】
${resumeSummary.slice(0, 2000)}

【严格规则】
- 字段语义精准：学校名→只填学校名，职位→只填职位，学历→只填学位等级，工作类型→只从选项选
- 复选框（至今/当前在职）输出 toggle 命令
- 同组字段必须来自简历的同一条记录，禁止跨记录混搭
- 多组按时间从近到远排列
- 日期返回 YYYY-MM 格式
- 有数据→输出命令，简历无此数据→clear，完全不相关→不输出
- 每条经历的描述必须是该经历自己的描述，不能重复

返回纯JSON数组：[{"action":"set|select|clear|toggle","domIndex":1,"value":"..."}]`;
}

function buildVisionFillPrompt(unresolvedFields, resumeSummary, allFields, existingFieldMap = {}, sectionContext = '') {
  const contextSection = sectionContext ? `\n【当前处理分区】${sectionContext}` : '';
  return `你正在根据网页截图校准招聘表单字段。截图是真实招聘网页，字段列表包含对应 DOM 索引和页面坐标。${contextSection}

【已确定字段】
${buildExistingMatchesPrompt(existingFieldMap, allFields)}

【待校准字段】
${buildStructuredFieldPrompt(unresolvedFields)}

【简历完整信息】
${resumeSummary}

【视觉校准规则】
- 结合截图中的可见标签、占位符、相邻字段和坐标判断字段真实语义
- 如果字段已有历史残留值，但简历没有对应信息，请返回 "" 清空
- 如果是复选框（如至今/当前在职），请返回 true 或 false
- 部门、岗位、学校、专业、公司、邮箱、电话不能互相串位
- 同组字段必须来自同一条简历记录
- 只能返回待校准字段的纯 JSON 对象
- 看不清或无法确定时返回 null

示例：{"12":"市场部","13":"数据营销实习生","14":""}`;
}

async function handleVisionFieldMatch({ tabId, fields, allFields, existingFieldMap, resumeSummary, resume, apiKey, apiBase, provider, visionModel, sectionContext }) {
  if (!tabId || !fields.length) return {};
  const screenshotDataUrl = await captureTabForFields(tabId, fields);
  if (!screenshotDataUrl) return {};

  const prompt = buildVisionFillPrompt(fields, resumeSummary, allFields, existingFieldMap, sectionContext);
  const response = await callChatAPI(apiBase, apiKey, provider, visionModel, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: screenshotDataUrl } }
    ]
  }], {
    temperature: 0.1,
    max_tokens: 3072,
    timeout: 60000,
    response_format: buildJsonResponseFormat(provider, apiBase)
  });

  return parseFillResponse(response, fields, resume);
}

async function captureTabForFields(tabId, fields) {
  try {
    const firstField = sortFieldsForMatching(fields)[0];
    if (firstField) {
      await sendToTab(tabId, { action: 'FOCUS_FIELD', domIndex: firstField._domIndex }).catch(() => null);
      await sleep(350);
    }

    const tab = await chrome.tabs.get(tabId);
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (error) {
    console.warn('截图失败:', error.message);
    return null;
  }
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
    '请将下面内容整理成纯 JSON。',
    '要求：',
    '- 只返回 JSON',
    '- 如果原内容是命令列表，整理成 JSON 数组',
    '- 如果原内容是字段映射，整理成 JSON 对象',
    '- 不要补充解释',
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

  const arrayMatch = response.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) return arrayMatch[0].trim();

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

function normalizeParsedCommands(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.commands)) return parsed.commands;
  if (Array.isArray(parsed?.actions)) return parsed.actions;
  return [];
}

function parseCommandResponse(response, fields, resume = null) {
  try {
    const jsonCandidate = extractJsonCandidate(response);
    if (!jsonCandidate) return [];

    const normalizedJson = jsonCandidate.replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(normalizedJson);
    const commands = [];

    for (const rawCommand of normalizeParsedCommands(parsed)) {
      const action = String(rawCommand?.action || '').toLowerCase();
      const domIndex = Number(rawCommand?.domIndex ?? rawCommand?.field_index ?? rawCommand?.index);
      if (!['set', 'select', 'clear', 'toggle'].includes(action)) continue;
      if (Number.isNaN(domIndex)) continue;

      const field = fields.find(item => item._domIndex === domIndex);
      if (!field) continue;

      if (action === 'clear') {
        commands.push({ action, domIndex });
        continue;
      }

      const normalizedValue = normalizeValueForField(rawCommand?.value, field);
      if (normalizedValue == null) continue;
      const validation = validateFieldValue(normalizedValue, field, resume);
      if (!validation.valid) continue;

      commands.push({
        action,
        domIndex,
        value: field.type === 'checkbox' ? Boolean(normalizedValue) : normalizedValue
      });
    }

    return dedupeCommands(commands);
  } catch (error) {
    console.warn('命令响应解析失败:', error.message);
    return [];
  }
}

function commandsToFieldMap(commands, fields) {
  const result = {};
  for (const command of commands || []) {
    const field = fields.find(item => item._domIndex === Number(command.domIndex));
    if (!field) continue;
    if (command.action === 'clear') {
      result[field._domIndex] = '';
    } else if (command.action === 'toggle') {
      result[field._domIndex] = Boolean(command.value);
    } else {
      result[field._domIndex] = command.value;
    }
  }
  return result;
}

function dedupeCommands(commands) {
  const map = new Map();
  for (const command of commands || []) {
    map.set(Number(command.domIndex), command);
  }
  return [...map.values()].sort((a, b) => Number(a.domIndex) - Number(b.domIndex));
}

async function callBridgeAPI({ tabId, bridgeConfig, fields, allFields, resume, sectionContext, existingFieldMap, includeScreenshot }) {
  const screenshot = includeScreenshot ? await captureTabForFields(tabId, fields) : null;
  const payload = {
    mode: 'fill_commands',
    page: {
      url: await getTabUrl(tabId),
      title: await getTabTitle(tabId),
      sectionContext: sectionContext || '',
      fields,
      allFields,
      existingFieldMap
    },
    resume,
    screenshot,
    timestamp: new Date().toISOString()
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (bridgeConfig.token) {
    headers.Authorization = bridgeConfig.token.startsWith('Bearer ')
      ? bridgeConfig.token
      : `Bearer ${bridgeConfig.token}`;
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Bridge 请求超时（${bridgeConfig.timeoutMs / 1000}秒）`)), bridgeConfig.timeoutMs);
  });

  const fetchPromise = fetch(bridgeConfig.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Bridge 错误 ${response.status}: ${errorText || response.statusText}`);
  }
  return response.json();
}

function parseBridgeCommands(result, fields, resume) {
  if (!result) return [];
  if (Array.isArray(result.commands) || Array.isArray(result.actions)) {
    return parseCommandResponse(JSON.stringify(result.commands || result.actions), fields, resume);
  }
  if (result.fieldMap && typeof result.fieldMap === 'object') {
    return fieldMapToCommands(result.fieldMap, fields);
  }
  if (typeof result === 'string') {
    return parseCommandResponse(result, fields, resume);
  }
  return [];
}

async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  } catch (_) {
    return '';
  }
}

async function getTabTitle(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title || '';
  } catch (_) {
    return '';
  }
}

/**
 * 解析 AI 填充响应
 */
function parseFillResponse(response, fields, resume = null) {
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
      if (value == null || value === 'null') continue;
      const domIndex = Number(key);
      if (isNaN(domIndex)) continue;

      const field = fields.find(f => f._domIndex === domIndex);
      if (!field) {
        console.warn(`字段索引 ${domIndex} 不存在于表单中`);
        continue;
      }

      const normalizedValue = normalizeValueForField(value, field);
      if (normalizedValue === '') {
        result[domIndex] = '';
        matchedCount++;
        console.log(`✓ 清空字段 ${domIndex}`);
        continue;
      }
      if (normalizedValue == null) continue;

      // 验证字段值的合理性
      const validation = validateFieldValue(normalizedValue, field, resume);
      if (!validation.valid) {
        console.warn(`⚠️ 字段 ${domIndex} ("${field.label}") 值验证失败: ${validation.reason}`);
        console.warn(`   填入值: "${normalizedValue}"`);
        rejectedCount++;
        continue;
      }

      result[domIndex] = field.type === 'checkbox' ? Boolean(normalizedValue) : String(normalizedValue);
      matchedCount++;
      console.log(`✓ 匹配字段 ${domIndex}: "${normalizedValue}"`);
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
function validateFieldValue(value, field, resume = null) {
  if (field.type === 'checkbox') {
    if (typeof value === 'boolean') return { valid: true };
    if (['true', 'false', '1', '0'].includes(String(value).trim().toLowerCase())) return { valid: true };
    return { valid: false, reason: '复选框字段必须是 true/false' };
  }

  const strValue = String(value).trim();
  const personalName = String(resume?.personal?.name || '').trim();
  const personalParts = splitPersonName(personalName);
  const personalTokens = [personalName, personalParts.firstName, personalParts.lastName].filter(Boolean);

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

  // 部门字段验证
  if (label.includes('department') || label.includes('部门') || hint === 'department') {
    if (/@/.test(strValue)) {
      return { valid: false, reason: '部门字段不能包含邮箱' };
    }
    if (/^\d{4}[-/.年]\d{1,2}/.test(strValue) || /至今|present/i.test(strValue)) {
      return { valid: false, reason: '部门字段不能是日期' };
    }
    if (personalTokens.includes(strValue)) {
      return { valid: false, reason: '部门字段不能是姓名' };
    }
  }

  // 职位字段验证
  if (label.includes('position') || label.includes('job title') || label.includes('职位') || label.includes('岗位') || hint === 'position') {
    if (/@/.test(strValue)) {
      return { valid: false, reason: '职位字段不能包含邮箱' };
    }
    if (/^\d{4}[-/.年]\d{1,2}/.test(strValue) || /至今|present/i.test(strValue)) {
      return { valid: false, reason: '职位字段不能是日期' };
    }
    if (personalTokens.includes(strValue)) {
      return { valid: false, reason: '职位字段不能是姓名' };
    }
  }

  // 工作类型字段验证
  if (label.includes('work type') || label.includes('employment type') || label.includes('工作类型') || hint === 'worktype') {
    if (/^\d{4}[-/.年]\d{1,2}/.test(strValue)) {
      return { valid: false, reason: '工作类型不能是日期' };
    }
    if (strValue.length > 20) {
      return { valid: false, reason: '工作类型不应是长段描述' };
    }
  }

  // 日期字段验证
  if (field.type === 'date' || field.type === 'month' || /日期|时间|start|end|from|to|毕业|入学|在职/.test(label)) {
    if (/@/.test(strValue)) {
      return { valid: false, reason: '日期字段不能包含邮箱' };
    }
    const normalizedDate = normalizeMonthValue(strValue);
    if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(normalizedDate) && !/至今|present|now/i.test(strValue)) {
      return { valid: false, reason: '日期格式不正确' };
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

async function testBridgeConnection(bridgeUrl, bridgeToken, bridgeTimeoutSec) {
  const bridgeConfig = normalizeBridgeConfig({
    bridgeEnabled: true,
    bridgeUrl,
    bridgeToken,
    bridgeTimeoutSec
  });

  if (!bridgeConfig.url) {
    return { success: false, message: '请先填写 Bridge URL' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (bridgeConfig.token) {
    headers.Authorization = bridgeConfig.token.startsWith('Bearer ')
      ? bridgeConfig.token
      : `Bearer ${bridgeConfig.token}`;
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Bridge 请求超时（${bridgeConfig.timeoutMs / 1000}秒）`)), bridgeConfig.timeoutMs);
  });

  const fetchPromise = fetch(bridgeConfig.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mode: 'ping',
      timestamp: new Date().toISOString()
    })
  });

  const response = await Promise.race([fetchPromise, timeoutPromise]);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return { success: false, message: `Bridge 错误 ${response.status}: ${errorText || response.statusText}` };
  }

  const data = await response.json().catch(() => ({}));
  return {
    success: true,
    message: data.message || data.status || 'Bridge 连接成功'
  };
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
    content: normalizeAnthropicContent(message.content)
  }));
}

function normalizeAnthropicContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: String(content || '') }];
  }

  return content.flatMap((part) => {
    if (!part) return [];
    if (part.type === 'text') {
      return [{ type: 'text', text: String(part.text || '') }];
    }
    if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) return [];
      return [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2]
        }
      }];
    }
    return [];
  });
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
