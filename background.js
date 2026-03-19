/**
 * CVmax Background Service Worker
 * 负责 AI API 调用（避免 CSP 限制）、消息路由、截图捕获
 */

const API_BASES = {
  cn: 'https://open.bigmodel.cn/api/paas/v4',
  global: 'https://api.z.ai/api/paas/v4',
  deepseek: 'https://api.deepseek.com/v1'
};

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'AI_MATCH_FIELDS':
      handleAIMatch(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'START_FILL': {
      // 整个填充流程在 background 中完成，不依赖 popup
      handleFullFill(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'GET_FILL_STATUS':
      sendResponse(fillStatus);
      break;

    case 'AI_CHAT':
      handleAIChat(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'TEST_API':
      testAPIConnection(msg.apiKey, msg.apiBase).then(sendResponse).catch(e => sendResponse({ success: false, message: e.message }));
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

async function handleFullFill({ tabId, resume, apiKey, apiBase, model }) {
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

    // 3. 分区块依次处理
    const totalSections = Object.keys(sectionGroups).length;
    let currentSection = 0;
    const allFieldMap = {};
    let totalAiMatched = 0;
    let totalFallbackUsed = 0;

    for (const [sectionName, sectionFields] of Object.entries(sectionGroups)) {
      currentSection++;
      const progress = 20 + Math.floor((currentSection / totalSections) * 50);

      // 更新状态：显示当前处理的分区
      updateFillStatus('matching', `[${currentSection}/${totalSections}] 正在处理 ${sectionName}...`, progress);
      console.log(`\n=== 处理分区: ${sectionName} (${sectionFields.length} 个字段) ===`);

      // 构建该分区的本地候选
      const { fieldHints, fallbackFieldMap } = localRuleMatch(sectionFields, resume);
      const hintCount = Object.keys(fieldHints).length;

      // AI 匹配该分区的字段
      const aiResult = await handleAIMatch({
        fields: sectionFields,
        resume,
        apiKey,
        apiBase,
        model,
        fieldHints,
        sectionContext: sectionName
      });

      if (aiResult.error) {
        console.warn(`分区 ${sectionName} AI 匹配失败:`, aiResult.error);
        // 分区失败不影响其他分区，直接使用兜底
        const fallbackMap = applyFallbackFieldMap({}, fallbackFieldMap);
        Object.assign(allFieldMap, fallbackMap);
        totalFallbackUsed += Object.keys(fallbackMap).length;
        continue;
      }

      // 合并 AI 结果和兜底
      const sectionFieldMap = applyFallbackFieldMap(aiResult.fieldMap, fallbackFieldMap);
      Object.assign(allFieldMap, sectionFieldMap);

      const aiMatchedCount = Object.keys(aiResult.fieldMap || {}).length;
      const fallbackUsedCount = Object.keys(sectionFieldMap).length - aiMatchedCount;
      totalAiMatched += aiMatchedCount;
      totalFallbackUsed += fallbackUsedCount;

      console.log(`✓ ${sectionName}: AI匹配 ${aiMatchedCount} 个, 兜底 ${fallbackUsedCount} 个`);
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

    // 5. 记录历史
    const tab = await chrome.tabs.get(tabId);
    const histData = await chrome.storage.local.get('cvmax_history');
    const history = histData.cvmax_history || [];
    history.unshift({
      url: tab.url,
      title: tab.title,
      resumeName: resume.name || '未命名',
      filledCount: fillResp.filledCount,
      timestamp: new Date().toISOString()
    });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ cvmax_history: history });

    updateFillStatus('done', `已填充 ${fillResp.filledCount} 个字段（AI ${totalAiMatched}${totalFallbackUsed > 0 ? ` + 规则兜底 ${totalFallbackUsed}` : ''}）`, 100);
    console.log(`=== 填充完成 ===`);
    console.log(`总计: ${fillResp.filledCount}/${fields.length} 个字段`);
    console.log(`AI匹配: ${totalAiMatched} 个`);
    console.log(`规则兜底: ${totalFallbackUsed} 个`);

    return { fieldMap: allFieldMap, filledCount: fillResp.filledCount, totalFields: fields.length };

  } catch (e) {
    updateFillStatus('error', '填充失败: ' + e.message);
    console.error('=== 填充流程异常 ===', e);
    return { error: e.message };
  }
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

// ─── 本地规则候选（作为 AI 提示与高置信度兜底）──────────────────────────────

function localRuleMatch(fields, resume) {
  const fieldHints = {};
  const fallbackFieldMap = {};

  // 对字段按 group 分组，每组使用不同的条目索引
  const groups = new Map();
  for (const field of fields) {
    const groupId = field.group?.id || `single_${field._domIndex}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(field);
  }

  let groupIndex = 0;
  for (const [groupId, groupFields] of groups) {
    // 对该组的每个字段应用匹配，使用组索引
    for (const field of groupFields) {
      const suggestion = matchFieldByRules(field, resume, groupIndex);
      if (!suggestion?.value) continue;

      const normalized = normalizeSuggestionForField(field, suggestion.value);
      if (!normalized.value) continue;

      const hint = {
        value: normalized.value,
        confidence: suggestion.confidence,
        source: suggestion.source,
        fallback: suggestion.confidence === 'high' && normalized.allowFallback !== false
      };

      fieldHints[field._domIndex] = hint;
      if (hint.fallback) fallbackFieldMap[field._domIndex] = hint.value;
    }
    groupIndex++;
  }

  return { fieldHints, fallbackFieldMap };
}

function createFieldSuggestion(value, confidence, source) {
  if (value == null || value === '') return null;
  return { value: String(value), confidence, source };
}

function normalizeSuggestionForField(field, value) {
  const raw = String(value || '').trim();
  if (!raw) return { value: '', allowFallback: false };

  if (!field.options?.length) {
    return { value: raw, allowFallback: true };
  }

  const exact = field.options.find(option => option.trim().toLowerCase() === raw.toLowerCase());
  if (exact) return { value: exact, allowFallback: true };

  const partial = field.options.find(option => {
    const normalizedOption = option.trim().toLowerCase();
    const normalizedRaw = raw.toLowerCase();
    return normalizedOption.includes(normalizedRaw) || normalizedRaw.includes(normalizedOption);
  });
  if (partial) return { value: partial, allowFallback: false };

  return { value: raw, allowFallback: false };
}

function applyFallbackFieldMap(aiFieldMap, fallbackFieldMap) {
  const merged = { ...(aiFieldMap || {}) };
  for (const [domIndex, value] of Object.entries(fallbackFieldMap || {})) {
    if (merged[domIndex] == null || merged[domIndex] === '') {
      merged[domIndex] = value;
    }
  }
  return merged;
}

function matchFieldByRules(field, resume, groupIndex = 0) {
  const label = (field.label || field.name || field.placeholder || '').toLowerCase();
  const hint = (field.hint || '').toLowerCase();
  const section = (field.section || '').toLowerCase();
  const p = resume.personal || {};

  // 根据 group 信息确定这是第几个条目（用于多个教育/工作/项目组）
  let entryIndex = groupIndex;
  // 如果 field 有 group 信息，尝试从 group ID 中解析索引
  if (field.group?.id && typeof field.group.id === 'string') {
    const groupMatch = field.group.id.match(/_?(\d+)$/);
    if (groupMatch) {
      entryIndex = parseInt(groupMatch[1]) || 0;
    }
  }

  if (hint === 'name' || hint === 'firstname' || hint === 'lastname' || /^(full.?)?name$|姓名|名字|your.?name/i.test(label)) {
    return createFieldSuggestion(p.name, 'high', 'personal.name');
  }

  if (hint === 'email' || /e-?mail|邮箱|电子邮/i.test(label)) {
    return createFieldSuggestion(p.email, 'high', 'personal.email');
  }

  if (hint === 'phone' || /phone|mobile|tel|手机|电话|联系方式/i.test(label)) {
    return createFieldSuggestion(p.phone, 'high', 'personal.phone');
  }

  if (hint === 'location' || /city|location|address|城市|地址|所在地|居住/i.test(label)) {
    return createFieldSuggestion(p.location, 'high', 'personal.location');
  }

  if (hint === 'linkedin' || /linkedin/i.test(label)) {
    return createFieldSuggestion(p.linkedin, 'high', 'personal.linkedin');
  }

  if (hint === 'github' || /github/i.test(label)) {
    return createFieldSuggestion(p.github, 'high', 'personal.github');
  }

  if (hint === 'portfolio' || /portfolio|website|个人网站/i.test(label)) {
    return createFieldSuggestion(p.website, 'high', 'personal.website');
  }

  if (hint === 'gender' || /gender|sex|性别/i.test(label)) {
    return createFieldSuggestion(p.gender, 'high', 'personal.gender');
  }

  if (hint === 'birthday' || /birth|dob|出生|生日/i.test(label)) {
    return createFieldSuggestion(p.birthDate, 'high', 'personal.birthDate');
  }

  if (
    section.includes('教育') ||
    /school|university|college|institution|学校|大学|院校/i.test(label) ||
    /degree|education.?level|学历|学位/i.test(label) ||
    /major|field.?of.?study|discipline|专业|学专/i.test(label) ||
    /gpa|grade.?point|成绩|绩点/i.test(label) ||
    /graduation|graduat|毕业时间|毕业年份/i.test(label)
  ) {
    const edu = resume.education?.[entryIndex];
    if (!edu) return null;

    if (hint === 'school' || /school|university|college|institution|学校|大学|院校/i.test(label)) {
      return createFieldSuggestion(edu.school, 'medium', 'education.school');
    }
    if (hint === 'degree' || /degree|education.?level|学历|学位/i.test(label)) {
      return createFieldSuggestion(edu.degree, 'medium', 'education.degree');
    }
    if (hint === 'major' || /major|field.?of.?study|discipline|专业|学专/i.test(label)) {
      return createFieldSuggestion(edu.major, 'medium', 'education.major');
    }
    if (hint === 'gpa' || /gpa|grade.?point|成绩|绩点/i.test(label)) {
      return createFieldSuggestion(edu.gpa, 'medium', 'education.gpa');
    }
    if (hint === 'graduation' || /graduation|graduat|毕业时间|毕业年份/i.test(label)) {
      return createFieldSuggestion(edu.endDate, 'medium', 'education.endDate');
    }
  }

  if (
    section.includes('工作') ||
    section.includes('实习') ||
    /company|employer|organization|firm|单位|公司|雇主/i.test(label) ||
    /position|job.?title|role|岗位|职位|应聘/i.test(label) ||
    /from|start|入职|开始/i.test(label) ||
    /to\b|end|until|present|离职|结束/i.test(label)
  ) {
    const exp = resume.experience?.[entryIndex];
    if (!exp) return null;

    if (hint === 'company' || /company|employer|organization|firm|单位|公司|雇主/i.test(label)) {
      return createFieldSuggestion(exp.company, 'medium', 'experience.company');
    }
    if (hint === 'position' || /position|job.?title|role|岗位|职位|应聘/i.test(label)) {
      return createFieldSuggestion(exp.position, 'medium', 'experience.position');
    }
    if (hint === 'jobStartDate' || /from|start|入职|开始/i.test(label)) {
      return createFieldSuggestion(exp.startDate, 'medium', 'experience.startDate');
    }
    if (hint === 'jobEndDate' || /to\b|end|until|present|离职|结束/i.test(label)) {
      return createFieldSuggestion(exp.current ? '至今' : exp.endDate, 'medium', 'experience.endDate');
    }
  }

  if (hint === 'skills' || /skill|技能|ability|expertise/i.test(label)) {
    return createFieldSuggestion(resume.skills?.join(', '), 'low', 'skills');
  }

  if (hint === 'languages' || /language|语言/i.test(label)) {
    return createFieldSuggestion(resume.languages?.join(', '), 'low', 'languages');
  }

  // 项目经历字段匹配
  if (
    section.includes('项目') ||
    section.includes('project') ||
    /projectname|项目名|项目名称|project.?title/i.test(label) ||
    /projectrole|项目角色|project.?role|项目负责人|项目职位/i.test(label) ||
    /projectdesc|项目描述|project.?description|项目内容|项目简介/i.test(label) ||
    /projecturl|项目链接|project.?link|project.?url/i.test(label) ||
    /projectstart|项目开始/i.test(label) ||
    /projectend|项目结束/i.test(label)
  ) {
    const proj = resume.projects?.[entryIndex];
    if (!proj) return null;

    if (/projectname|项目名|项目名称|project.?title/i.test(label)) {
      return createFieldSuggestion(proj.name, 'medium', 'project.name');
    }
    if (/projectrole|项目角色|project.?role|项目负责人|项目职位/i.test(label)) {
      return createFieldSuggestion(proj.role || '项目负责人', 'medium', 'project.role');
    }
    if (/projectdesc|项目描述|project.?description|项目内容|项目简介/i.test(label)) {
      return createFieldSuggestion(proj.description, 'low', 'project.description');
    }
    if (/projecturl|项目链接|project.?link|project.?url/i.test(label)) {
      return createFieldSuggestion(proj.url || '', 'low', 'project.url');
    }
    // 项目开始时间（如果label包含"项目"和"开始"关键词）
    if (/project.*start|项目.*开始/i.test(label)) {
      return createFieldSuggestion(proj.startDate, 'medium', 'project.startDate');
    }
    // 项目结束时间（如果label包含"项目"和"结束"关键词）
    if (/project.*end|项目.*结束/i.test(label)) {
      return createFieldSuggestion(proj.endDate, 'medium', 'project.endDate');
    }
  }

  // 检查是否是通用的时间字段，在项目分区下可能是项目时间
  if (section.includes('项目') || section.includes('project')) {
    const proj = resume.projects?.[entryIndex];
    if (!proj) return null;

    if (/from|start|开始/i.test(label) && !/(job|work|company)/i.test(label)) {
      return createFieldSuggestion(proj.startDate, 'medium', 'project.startDate');
    }
    if (/to\b|end|until|结束/i.test(label) && !/(job|work|company)/i.test(label)) {
      return createFieldSuggestion(proj.endDate, 'medium', 'project.endDate');
    }
  }

  return null;
}

// ─── AI 字段匹配（纯文本模式）────────────────────────────────────────────────

async function handleAIMatch({ fields, resume, apiKey, apiBase, model, fieldHints = {}, sectionContext = '' }) {
  if (!apiKey) throw new Error('未配置 API Key，请先前往设置页面填写');

  const base = apiBase || API_BASES.cn;
  const resumeSummary = buildResumeSummary(resume);

  console.log('=== 开始 AI 字段匹配 ===');
  console.log(`分区: ${sectionContext || '全表单'}`);
  console.log(`字段数量: ${fields.length}`);
  console.log(`API 端点: ${base}`);
  console.log(`使用模型: ${model || 'default'}`);

  const structuredPrompt = buildStructuredFieldPrompt(fields);

  // 纯文本模式：仅发送结构化字段数据
  const messages = [{
    role: 'user',
    content: buildTextFillPrompt(structuredPrompt, resumeSummary, fields, fieldHints, sectionContext)
  }];

  console.log('准备调用 API...');
  const defaultModel = base?.includes('deepseek.com') ? 'deepseek-chat' : 'glm-4.7-flash';
  const resolvedModel = resolveFieldMatchModel(base, model || defaultModel);
  const requestOpts = {
    temperature: 0.05,
    max_tokens: 4096,
    timeout: 90000,
    response_format: buildJsonResponseFormat(base)
  };

  // 智能降级：先尝试完整 prompt，超时后降级到简化 prompt
  let response;
  try {
    response = await callChatAPI(base, apiKey, resolvedModel, messages, requestOpts);
  } catch (error) {
    // 检查是否是超时错误
    if (error.message.includes('超时') || error.message.includes('timeout')) {
      console.warn('⚠️ API 超时，降级到简化 prompt...');
      updateFillStatus('matching', '响应较慢，正在重试简化模式...', 50);

      // 降级：使用简化 prompt
      const simplifiedPrompt = buildSimplifiedPrompt(fields, resumeSummary, fieldHints);
      const simplifiedMessages = [{
        role: 'user',
        content: simplifiedPrompt
      }];

      response = await callChatAPI(base, apiKey, resolvedModel, simplifiedMessages, {
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
    const repairedResponse = await repairFillResponse(base, apiKey, resolvedModel, response);
    fieldMap = parseFillResponse(repairedResponse, fields);
  }

  const unresolvedFields = fields.filter(field => fieldMap[field._domIndex] == null || fieldMap[field._domIndex] === '');
  if (unresolvedFields.length > 0 && unresolvedFields.length < fields.length) {
    try {
      updateFillStatus('matching', `AI 正在二次校准剩余 ${unresolvedFields.length} 个字段...`, 62);
      const refineResponse = await callChatAPI(base, apiKey, resolvedModel, [{
        role: 'user',
        content: buildFocusedFillPrompt(unresolvedFields, resumeSummary, fields, fieldHints, fieldMap)
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

function buildFieldHintsPrompt(fields, fieldHints) {
  const hintLines = fields
    .filter(field => fieldHints[field._domIndex]?.value)
    .map(field => {
      const hint = fieldHints[field._domIndex];
      return `#${field._domIndex}: 候选="${hint.value}" 置信度=${hint.confidence} 来源=${hint.source}`;
    });

  return hintLines.length ? hintLines.join('\n') : '（无规则候选）';
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
function buildTextFillPrompt(structuredFields, resumeSummary, fields, fieldHints = {}, sectionContext = '') {
  const contextSection = sectionContext ? `\n【当前处理分区】${sectionContext}` : '';

  return `你是招聘表单自动填充专家，需要尽可能准确地为每个字段匹配简历内容。${contextSection}

【字段信息】
${structuredFields}

【简历数据】
${resumeSummary}

【规则候选（仅供参考，AI 可推翻）】
${buildFieldHintsPrompt(fields, fieldHints)}

【执行规则】
- 你必须优先自行理解字段语义，再参考规则候选，不能机械照抄
- 同一组字段必须尽量来自同一条教育/工作/项目经历
- 多组重复字段按时间从近到远分配
- 项目经历字段：项目名称→project.name，项目角色→project.role，项目描述→project.description，项目链接→project.url
- 项目经历与实习经历的区别：
  * 实习经历：有公司名称、职位名称、通常是正式的工作实习
  * 项目经历：有项目名称、项目角色/负责人、可能是个人项目、课程项目、开源项目或AI项目
- 识别项目字段的关键词：项目名称、项目描述、项目角色、项目链接、project name、project description
- 若字段提供选项，返回值必须优先贴近选项文本
- 邮箱必须包含 @；电话以数字为主；学校不能是邮箱；公司不能是邮箱
- 无法判断时返回 null，不要编造

【项目经历字段特别说明】
- 项目名称（Project Name）：个人项目、AI项目、课程项目、开源项目的名称
- 项目角色（Project Role）：项目负责人、开发者、策划者、设计者等
- 项目描述（Project Description）：项目的完整描述，包括技术栈、功能、成果
- 项目链接（Project URL）：项目网址、GitHub链接等
- AI项目示例：MoodPulse、CVmax简历投递插件、AI聊天助手、大模型应用等都是项目经历

【输出要求】
- 覆盖所有字段，未命中返回 null
- 只返回一个 JSON 对象
- 不要解释，不要 markdown，不要代码块
- 格式：{"字段_domIndex号":"填充值", "字段_domIndex号":null}

示例：{"0":"丁宏磊","1":"3043755156@qq.com","5":"上海外国语大学","6":null,"10":"MoodPulse","11":"项目负责人","12":"个人情绪与精力管理记录与预测工具"}`;
}

function buildFocusedFillPrompt(unresolvedFields, resumeSummary, allFields, fieldHints = {}, existingFieldMap = {}) {
  return `你正在做第二轮表单匹配，只处理仍未确定的字段。

【已确定字段】
${buildExistingMatchesPrompt(existingFieldMap, allFields)}

【待匹配字段】
${buildStructuredFieldPrompt(unresolvedFields)}

【简历数据】
${resumeSummary}

【规则候选（仅供参考）】
${buildFieldHintsPrompt(unresolvedFields, fieldHints)}

【要求】
- 重点利用分组、section、选项和同组字段关系补齐剩余字段
- 不要改写已确定字段
- 无法判断时返回 null

【输出】
只返回待匹配字段的 JSON 对象，不要解释。`;
}

/**
 * 构建简化 prompt（降级模式，减少 token 消耗）
 */
function buildSimplifiedPrompt(fields, resumeSummary, fieldHints = {}) {
  // 只保留关键字段信息，减少 token 消耗
  const simpleFields = fields.map(f => ({
    i: f._domIndex,
    l: f.label || f.name || f.placeholder || '?',
    t: f.type,
    h: f.hint !== 'unknown' ? f.hint : undefined,
    s: f.section || undefined,
    o: f.options?.slice(0, 5)
  }));

  return `表单填充：为字段匹配简历数据。

字段：${JSON.stringify(simpleFields)}
简历：${resumeSummary.slice(0, 2000)}
候选：${buildFieldHintsPrompt(fields, fieldHints)}

规则：
- AI 需独立判断字段语义，候选仅参考
- 邮箱必须含@
- 电话纯数字
- 学校含大学/学院
- 同组字段取同一条记录
- 未命中返回 null

返回纯JSON对象：{"字段索引":"值"}`;
}

/**
 * 深度匹配场景强制使用稳定的文本模型
 */
function resolveFieldMatchModel(base, model) {
  if (base?.includes('deepseek.com') && model === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }
  return model;
}

function buildJsonResponseFormat(base) {
  if (base?.includes('deepseek.com')) {
    return { type: 'json_object' };
  }
  return undefined;
}

async function repairFillResponse(base, apiKey, model, rawResponse) {
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

  return callChatAPI(base, apiKey, model, [{ role: 'user', content: prompt }], {
    temperature: 0,
    max_tokens: 2048,
    timeout: 30000,
    response_format: buildJsonResponseFormat(base)
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

async function handleAIChat({ messages, apiKey, apiBase, model, temperature, maxTokens }) {
  if (!apiKey) throw new Error('未配置 API Key');
  const base = apiBase || API_BASES.cn;
  // 智能选择默认模型
  let defaultModel = 'glm-4.7-flash';
  if (base && base.includes('deepseek.com')) {
    defaultModel = 'deepseek-chat';
  }

  const content = await callChatAPI(base, apiKey, model || defaultModel, messages, {
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens || 2048
  });
  return { content };
}

// ─── PDF 简历解析 ─────────────────────────────────────────────────────────────

async function handleParsePDF({ extractedText, imageDataUrl, apiKey, apiBase, textModel, visionModel }) {
  const base = apiBase || API_BASES.cn;
  // 根据 API 提供商选择默认模型
  let defaultModel = 'glm-4.7-flash';
  if (base && base.includes('deepseek.com')) {
    defaultModel = 'deepseek-chat';
  }
  const model = textModel || defaultModel;

  let resumeText = extractedText || '';

  // 如果文本提取失败（扫描版 PDF），提示用户上传文字版
  if (!resumeText.trim()) {
    throw new Error('无法从 PDF 提取文本，请尝试上传文字版 PDF');
  }

  // ── 策略：始终优先 AI 解析，本地仅作兜底 ────────────────────────────────────
  if (apiKey) {
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

      const response = await callChatAPI(base, apiKey, model, [
        { role: 'user', content: parsePrompt }
      ], { temperature: 0.05, max_tokens: 8192 });

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
      console.warn('AI 解析失败，回退到本地解析:', aiErr.message);
      // AI 失败时回退到本地解析
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

async function testAPIConnection(apiKey, apiBase) {
  if (!apiKey) return { success: false, message: '请先填写 API Key' };
  try {
    const base = apiBase || API_BASES.cn;

    // 根据 API 提供商选择合适的测试模型
    let testModel = 'glm-4.7-flash'; // 智谱默认
    if (base.includes('deepseek.com')) {
      testModel = 'deepseek-chat';
    }

    const content = await callChatAPI(
      base,
      apiKey,
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

async function callChatAPI(base, apiKey, model, messages, opts = {}) {
  const maxRetries = 3;
  const timeoutMs = opts.timeout || 60000; // 默认60秒超时，大表单需要更长时间
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 添加超时保护
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`API 请求超时（${timeoutMs / 1000}秒）`)), timeoutMs);
      });

      const fetchPromise = fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
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
        const msg = err.error?.message || response.statusText;

        if (response.status === 401) {
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
        if (base.includes('deepseek.com') && response.status === 400) {
          console.warn('DeepSeek API 详细错误:', { status: response.status, error: err, model });
          throw new Error(`DeepSeek API 错误: ${msg}\n模型: ${model}\n状态: ${response.status}\n详情: ${JSON.stringify(err)}`);
        }
        throw new Error(`API 错误 ${response.status}: ${msg}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
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
      const tag = e.isInternship ? '[实习]' : '[工作]';
      lines.push(`${tag}#${idx + 1}`);
      lines.push(`  [公司] ${e.company || ''}`);
      lines.push(`  [职位] ${e.position || ''}`);
      lines.push(`  [开始时间] ${e.startDate || ''}`);
      lines.push(`  [结束时间] ${e.current ? '至今' : (e.endDate || '')}`);
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
