/**
 * CVflash Content Script - Universal Form Detector
 *
 * 通用性设计：支持
 * - 标准 HTML 表单 (input/textarea/select)
 * - Shadow DOM 组件（Web Components、Lit、Stencil）
 * - contenteditable 元素（富文本框）
 * - ARIA role 自定义组件（role="textbox"、role="combobox"）
 * - React/Vue/Angular 响应式填充（事件模拟）
 * - 动态加载表单（MutationObserver）
 * - 企业级 ATS 系统（Workday、Greenhouse、Lever、iCIMS、Taleo 等）
 * - 自主招聘网站任意表单结构
 */

// ─── 状态 ─────────────────────────────────────────────────────────────────────

let detectedFields = [];
let observer = null;

// ─── 消息监听 ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'DETECT_FIELDS':
      handleDetect().then(sendResponse);
      return true;
    case 'AUTOFILL':
      handleAutofill(msg.fieldMap).then(sendResponse);
      return true;
    case 'APPLY_COMMANDS':
      handleApplyCommands(msg.commands).then(sendResponse);
      return true;
    case 'FOCUS_FIELD':
      handleFocusField(msg.domIndex).then(sendResponse);
      return true;
    case 'CLEAR_HIGHLIGHT':
      clearAllHighlights();
      sendResponse({ ok: true });
      break;
    case 'GET_PAGE_INFO':
      sendResponse({ url: location.href, title: document.title, fieldCount: detectedFields.length });
      break;
  }
});

// ─── 检测 ─────────────────────────────────────────────────────────────────────

async function handleDetect() {
  detectedFields = collectAllFields(document);
  detectedFields.forEach(f => highlightElement(f.element, 'detect'));
  showToast(`检测到 ${detectedFields.length} 个表单字段`, 'info');
  return { fields: serializeFields(detectedFields), count: detectedFields.length };
}

// ─── 填充 ─────────────────────────────────────────────────────────────────────

async function handleAutofill(fieldMap) {
  let filledCount = 0, skippedCount = 0, clearedCount = 0;
  for (const [domIndex, value] of Object.entries(fieldMap)) {
    // null = 不操作此字段（完全不相关）
    if (value == null) { skippedCount++; continue; }
    const field = detectedFields.find(f => f._domIndex === Number(domIndex));
    if (!field) { skippedCount++; continue; }

    try {
      if (value === '') {
        // 空字符串 = 清除旧值（简历无此数据）
        await clearField(field);
        clearedCount++;
      } else {
        await fillField(field, value);
        highlightElement(field.element, 'success');
        filledCount++;
      }
    } catch (e) {
      console.warn('[CVflash] 填充失败:', field.label || field.name, e);
      skippedCount++;
    }
    await sleep(30);
  }
  const msg = clearedCount > 0
    ? `✓ 已填充 ${filledCount} 个字段，清除 ${clearedCount} 个旧值`
    : `✓ 已填充 ${filledCount} 个字段`;
  showToast(msg, 'success');
  return { filledCount, skippedCount, clearedCount };
}

async function handleApplyCommands(commands) {
  let appliedCount = 0, skippedCount = 0, clearedCount = 0;

  for (const command of commands || []) {
    const domIndex = Number(command?.domIndex);
    const field = detectedFields.find(f => f._domIndex === domIndex);
    if (!field) {
      skippedCount++;
      continue;
    }

    try {
      const action = String(command.action || '').toLowerCase();
      if (action === 'clear') {
        await clearField(field);
        clearedCount++;
      } else if (action === 'toggle') {
        await fillField(field, Boolean(command.value));
        appliedCount++;
      } else if (action === 'select' || action === 'set') {
        await fillField(field, command.value ?? '');
        highlightElement(field.element, 'success');
        appliedCount++;
      } else {
        skippedCount++;
      }
    } catch (error) {
      console.warn('[CVflash] 命令执行失败:', command, error);
      skippedCount++;
    }

    await sleep(40);
  }

  const msg = clearedCount > 0
    ? `✓ 已执行 ${appliedCount} 条命令，清除 ${clearedCount} 个旧值`
    : `✓ 已执行 ${appliedCount} 条命令`;
  showToast(msg, 'success');
  return { appliedCount, skippedCount, clearedCount };
}

async function handleFocusField(domIndex) {
  const field = detectedFields.find(f => f._domIndex === Number(domIndex));
  if (!field?.element) return { ok: false };

  field.element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
  highlightElement(field.element, 'detect');
  await sleep(250);
  return { ok: true, bbox: field.bbox || null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 通用字段收集器
// ═══════════════════════════════════════════════════════════════════════════════

const IGNORED_INPUT_TYPES = new Set([
  'hidden', 'submit', 'button', 'reset', 'image', 'radio'
]);

/**
 * 递归收集文档（含 Shadow DOM）中所有可填写字段
 */
function collectAllFields(root) {
  const fields = [];
  const scannedElements = [];
  let domIndex = 0;

  function walk(node) {
    // 1. 标准表单元素
    node.querySelectorAll('input, textarea, select').forEach(el => {
      if (el.tagName === 'INPUT' && IGNORED_INPUT_TYPES.has(el.type)) return;
      if (el.tagName === 'INPUT' && el.type === 'checkbox' && !shouldIncludeCheckbox(el)) return;
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      el.dataset.cvflashScanned = '1';
      scannedElements.push(el);

      const field = buildFieldDescriptor(el, domIndex++);
      if (field) fields.push(field);
    });

    // 2. contenteditable 元素（富文本、自定义输入框）
    node.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(el => {
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      if (el.tagName === 'BODY' || el.closest('[data-cvflash-scanned]')) return;
      el.dataset.cvflashScanned = '1';
      scannedElements.push(el);

      const field = buildFieldDescriptor(el, domIndex++, 'contenteditable');
      if (field) fields.push(field);
    });

    // 3. ARIA role 自定义输入组件（企业级 UI）
    node.querySelectorAll('[role="textbox"], [role="combobox"], [role="spinbutton"], [role="searchbox"]').forEach(el => {
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return; // 已处理
      el.dataset.cvflashScanned = '1';
      scannedElements.push(el);

      const field = buildFieldDescriptor(el, domIndex++, 'aria-' + (el.getAttribute('role') || 'textbox'));
      if (field) fields.push(field);
    });

    // 4. 递归进入 Shadow DOM
    node.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        // 清除 shadow DOM 内的扫描标记（允许重扫）
        walk(el.shadowRoot);
      }
    });

    // 5. iframe（同源）
    node.querySelectorAll('iframe').forEach(frame => {
      try {
        const iframeDoc = frame.contentDocument || frame.contentWindow?.document;
        if (iframeDoc && iframeDoc.readyState === 'complete') {
          walk(iframeDoc);
        }
      } catch (_) {
        // 跨域 iframe 跳过
      }
    });
  }

  walk(root);

  // 清除扫描标记以允许下次重扫
  scannedElements.forEach(el => {
    delete el.dataset.cvflashScanned;
  });

  return fields;
}

/**
 * 构建字段描述符
 */
function buildFieldDescriptor(el, index, typeOverride) {
  const tag = el.tagName.toUpperCase();
  const inputType = typeOverride || (tag === 'INPUT' ? (el.type || 'text') : tag.toLowerCase());
  const label = getLabel(el);
  const name = el.name || el.id || el.getAttribute('data-field') || el.getAttribute('data-name') || '';
  const placeholder = el.placeholder || el.getAttribute('aria-placeholder') || '';
  const options = tag === 'SELECT'
    ? Array.from(el.options).map(o => o.text.trim()).filter(Boolean)
    : getAriaOptions(el);

  // 空间元数据：bounding box 用于 AI 理解字段位置
  const rect = el.getBoundingClientRect();
  const bbox = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height)
  };

  // DOM 分组：找到最近的表单容器
  const groupInfo = getFieldGroup(el);

  return {
    _domIndex: index,
    element: el,
    tagName: tag,
    type: inputType,
    id: el.id || '',
    name,
    label,
    placeholder,
    options,
    section: getFieldSection(el),
    hint: guessSemanticType(label, name, placeholder),
    currentValue: getCurrentValue(el),
    checked: el.type === 'checkbox' ? !!el.checked : undefined,
    required: !!(el.required || el.getAttribute('aria-required') === 'true'),
    autocomplete: el.autocomplete || '',
    inputMode: el.inputMode || '',
    bbox,
    group: groupInfo
  };
}

/**
 * 获取字段所属的表单分区（如"教育经历"、"工作经历"）
 * 通过向上查找最近的 section/fieldset 标题或 heading 元素
 */
function getFieldSection(el) {
  let node = el.parentElement;
  const maxDepth = 20;
  let depth = 0;

  while (node && depth < maxDepth) {
    // 检查 fieldset > legend
    if (node.tagName === 'FIELDSET') {
      const legend = node.querySelector('legend');
      if (legend) return legend.textContent.trim().slice(0, 30);
    }

    // 检查 section/div 中的标题元素（扩展支持更多选择器）
    const heading = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > .title, :scope > [class*="title"], :scope > [class*="header"], :scope > [class*="heading"], :scope > [class*="section-title"], :scope > [class*="form-title"]');
    if (heading) {
      const text = heading.textContent.trim();
      if (text.length >= 2 && text.length <= 30) return text;
    }

    // 检查 aria-label 或 data-section
    const sectionLabel = node.getAttribute('aria-label') || node.getAttribute('data-section') || node.getAttribute('data-title');
    if (sectionLabel) return sectionLabel.trim().slice(0, 30);

    // 检查常见的表单分区标题模式（如 div/p/span）
    if (node.className && /section|group|block|category|panel|tab|step|stage/i.test(node.className)) {
      // 查找该容器内的文本元素作为标题
      const potentialTitle = node.querySelector(':scope > div, :scope > p, :scope > span, :scope > strong, :scope > b');
      if (potentialTitle) {
        const text = potentialTitle.textContent.trim();
        // 排除纯数字或过短的文本
        if (text.length >= 2 && text.length <= 30 && !/^\d+$/.test(text)) {
          return text;
        }
      }
    }

    node = node.parentElement;
    depth++;
  }

  return '';
}

/**
 * 获取字段所属的 DOM 分组（同一表单区域内的字段归为一组）
 * 用于 AI 理解哪些字段是重复的（如多组教育/工作经历）
 */
function getFieldGroup(el) {
  // 向上查找最近的表单容器
  const container = el.closest('form, fieldset, [class*="form-group"], [class*="form-row"], [class*="field-group"], [class*="repeatable"], [class*="section"], [class*="entry"], [class*="item"]');
  if (!container) return { id: '', siblings: [] };

  // 用容器的 class 或 id 作为分组标识
  const groupId = container.className?.split(' ').find(c =>
    /group|row|section|entry|item|block|card|panel/i.test(c)
  ) || container.id || '';

  // 找到同容器内的其他字段
  const siblings = [];
  container.querySelectorAll('input:not([type=hidden]), textarea, select, [contenteditable="true"]').forEach(sib => {
    if (sib === el) return;
    if (sib.disabled || sib.readOnly) return;
    const sibLabel = getLabel(sib);
    if (sibLabel) siblings.push(sibLabel);
  });

  return { id: groupId.slice(0, 40), siblings: siblings.slice(0, 5) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 标签提取（多策略，增强版）
// ═══════════════════════════════════════════════════════════════════════════════

function getLabel(el) {
  // 策略1: <label for="id">
  if (el.id) {
    try {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return cleanText(lbl.textContent);
    } catch (_) {}
  }

  // 策略2: 父级 <label>
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true);
    clone.querySelectorAll('input,textarea,select').forEach(n => n.remove());
    const t = cleanText(clone.textContent);
    if (t) return t;
  }

  // 策略3: aria-label / aria-labelledby
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledById = el.getAttribute('aria-labelledby');
  if (labelledById) {
    const ids = labelledById.split(/\s+/);
    const texts = ids.map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
    if (texts.length) return texts.join(' ');
  }

  // 策略4: placeholder 作为备用标签
  const ph = el.placeholder || el.getAttribute('aria-placeholder');
  if (ph?.trim()) return ph.trim();

  // 策略5: 向上查找最近的文字（适配各种自定义 UI 框架）
  const candidates = [
    () => el.previousElementSibling,
    () => el.parentElement?.previousElementSibling,
    () => el.closest('[class*="field"], [class*="form"], [class*="input"], [class*="group"]')
          ?.querySelector('label, [class*="label"], [class*="title"], legend, .label, .title, h3, h4, h5')
  ];

  for (const getCand of candidates) {
    const cand = getCand();
    if (cand && cand !== el) {
      const t = cleanText(cand.textContent);
      if (t && t.length < 60) return t;
    }
  }

  // 策略6: 查找 data-label / data-placeholder 属性（部分框架）
  const dataLabel = el.getAttribute('data-label') || el.getAttribute('data-placeholder');
  if (dataLabel?.trim()) return dataLabel.trim();

  // 策略7: title 属性
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  return '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 语义类型推测（扩展版，覆盖更多招聘字段）
// ═══════════════════════════════════════════════════════════════════════════════

const SEMANTIC_PATTERNS = [
  // 个人信息 - 高优先级
  ['name',        /^(full.?)?name$|姓名|名字|your.?name|applicant.?name/i],
  ['firstName',   /first.?name|名|given.?name/i],
  ['lastName',    /last.?name|姓|family.?name|surname/i],
  ['email',       /e-?mail|邮箱|电子邮/i],
  ['phone',       /phone|mobile|tel|手机|电话|联系方式/i],
  ['location',    /city|location|address|城市|地址|所在地|居住/i],
  ['country',     /country|国家/i],
  ['gender',      /gender|sex|性别/i],
  ['birthday',    /birth|dob|出生|生日/i],
  ['nationality', /nationality|国籍/i],
  ['idcard',      /id.?card|身份证/i],

  // 社交媒体 - 高优先级
  ['linkedin',    /linkedin/i],
  ['github',      /github/i],
  ['portfolio',   /portfolio|website|个人网站|作品/i],

  // 求职意向
  ['position',    /position|job.?title|role|岗位|职位|应聘/i],
  ['department',  /department|部门/i],
  ['salary',      /salary|compensation|期望薪|薪资|薪酬|ctc/i],
  ['salaryMin',   /min.?salary|最低薪/i],
  ['salaryMax',   /max.?salary|最高薪/i],
  ['startDate',   /start.?date|available|entry|入职|开始时间|到岗/i],
  ['workType',    /work.?type|employment.?type|job.?type|全职|兼职|实习/i],
  ['workMode',    /remote|work.?mode|办公方式|远程/i],
  ['currentFlag', /present|current|currently|至今|在职|在读|ongoing/i],

  // 教育 - 高优先级
  ['school',      /school|university|college|institution|学校|大学|院校/i],
  ['degree',      /degree|education.?level|学历|学位/i],
  ['major',       /major|field.?of.?study|discipline|专业|学专/i],
  ['gpa',         /gpa|grade.?point|成绩|绩点/i],
  ['graduation',  /graduation|graduat|毕业时间|毕业年份/i],

  // 工作经历 - 高优先级
  ['company',     /company|employer|organization|firm|单位|公司|雇主/i],
  ['jobStartDate',/from|start|入职|开始/i],
  ['jobEndDate',  /to\b|end|until|present|离职|结束/i],
  ['description', /description|responsibilities|duties|experience|introduce|简介|经历|介绍|自我|cover/i],
  ['yearsExp',    /years?.?of.?exp|work.?years|experience.?year|工作年限|经验年/i],

  // 技能 & 其他
  ['skills',      /skill|技能|ability|expertise/i],
  ['languages',   /language|语言/i],
  ['cover',       /cover.?letter|求职信/i],
  ['referee',     /reference|referral|推荐人/i],
  ['source',      /how.?did.?you|referral.?source|来源|渠道/i],
  ['agree',       /agree|consent|confirm|authorization|同意|确认/i],
];

function guessSemanticType(label, name, placeholder) {
  const haystack = `${label} ${name} ${placeholder}`.toLowerCase();
  for (const [type, pattern] of SEMANTIC_PATTERNS) {
    if (pattern.test(haystack)) return type;
  }
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 填充逻辑（框架兼容版）
// ═══════════════════════════════════════════════════════════════════════════════

async function clearField(field) {
  const el = field.element;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' && el.type === 'checkbox') {
    await setCheckboxState(el, false);
    return;
  }
  if (tag === 'SELECT') {
    const emptyOption = Array.from(el.options).find(option => !option.value || !option.text.trim());
    if (emptyOption) {
      el.value = emptyOption.value;
    } else {
      el.selectedIndex = -1;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (field.type === 'contenteditable' || el.contentEditable === 'true') {
    el.innerHTML = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, '');
  else el.value = '';
  const tracker = el._valueTracker;
  if (tracker) tracker.setValue('__clear__');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fillField(field, value) {
  const el = field.element;
  const tag = el.tagName.toUpperCase();
  const normalizedTarget = normalizeComparableText(value);

  el.focus();
  await sleep(40);

  if (tag === 'INPUT' && el.type === 'checkbox') {
    await setCheckboxState(el, Boolean(value));
    if (Boolean(value)) {
      await clearNearbyEndDateField(el);
    }
    return;
  }

  if (field.type === 'contenteditable' || el.contentEditable === 'true') {
    el.innerHTML = '';
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return;
  }

  if (tag === 'SELECT') {
    await fillSelect(el, value);
    return;
  }

  // 自定义下拉组件（aria-combobox、readonly input、UI框架 select 组件等）
  const isCustomDropdown = field.type === 'aria-combobox'
    || (field.options && field.options.length > 0)
    || (tag === 'INPUT' && el.readOnly && el.type !== 'date' && el.type !== 'month')
    || el.closest('.ant-select, .el-select, [class*="select-wrap"], [class*="dropdown-trigger"]')
    || el.getAttribute('aria-haspopup') === 'listbox';
  if (isCustomDropdown) {
    const currentComparable = normalizeComparableText(getCurrentValue(el));
    if (normalizedTarget && currentComparable && (currentComparable.includes(normalizedTarget) || normalizedTarget.includes(currentComparable))) {
      return;
    }

    const filled = await fillCustomDropdown(el, value);
    if (filled) return;

    // 选择型控件如果没真正选中，宁可保留原值，也不要误写文本
    if (tag === 'INPUT' && (el.readOnly || field.type === 'aria-combobox' || field.options?.length)) {
      throw new Error('自定义下拉未能成功选中目标选项');
    }
  }

  if (field.type.startsWith('aria-')) {
    el.textContent = '';
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(30);
    document.execCommand('insertText', false, value);
    if (!el.textContent.trim()) el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return;
  }

  // 日期/月份字段特殊处理
  if (el.type === 'date' || el.type === 'month') {
    await ensureNearbyCurrentCheckboxState(el, false);
    await fillDateInput(el, value);
    return;
  }

  if (isDateLikeField(field, el)) {
    await ensureNearbyCurrentCheckboxState(el, false);
    await fillTextualDateInput(el, value);
    return;
  }

  // 标准 input / textarea - 兼容 React/Vue/Angular
  const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  // 先清空旧值
  if (nativeSetter) nativeSetter.call(el, '');
  else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(20);

  // 写入新值
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;

  // React _valueTracker hack
  const tracker = el._valueTracker;
  if (tracker) tracker.setValue('');

  // 触发完整事件序列
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  await sleep(30);
}

async function fillDateInput(el, value) {
  let normalized = String(value).trim();
  if (el.type === 'month') {
    // yyyy-MM-dd → yyyy-MM; yyyy → yyyy-01
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized = normalized.slice(0, 7);
    else if (/^\d{4}$/.test(normalized)) normalized = normalized + '-01';
    else if (/^\d{4}[.\/]\d{1,2}$/.test(normalized)) {
      const [y, m] = normalized.split(/[.\/]/);
      normalized = `${y}-${m.padStart(2, '0')}`;
    }
  } else if (el.type === 'date') {
    if (/^\d{4}-\d{2}$/.test(normalized)) normalized = normalized + '-01';
    else if (/^\d{4}$/.test(normalized)) normalized = normalized + '-01-01';
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, normalized);
  else el.value = normalized;

  const tracker = el._valueTracker;
  if (tracker) tracker.setValue('');

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function fillTextualDateInput(el, value) {
  const normalized = normalizeDateLikeValue(String(value).trim());
  const displayValue = applyDateDisplayFormat(el, normalized);
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  if (nativeSetter) nativeSetter.call(el, '');
  else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(20);

  if (nativeSetter) nativeSetter.call(el, displayValue);
  else el.value = displayValue;

  const tracker = el._valueTracker;
  if (tracker) tracker.setValue('');

  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: displayValue }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function fillSelect(el, value) {
  const val = String(value).trim();
  const valLower = val.toLowerCase();
  const normalize = s => s.replace(/[\s\-_.,()（）【】]/g, '').toLowerCase();
  const options = Array.from(el.options);

  // 策略1: 精确匹配 text 或 value
  let match = options.find(o => o.text.trim() === val || o.value === val);
  // 策略2: 大小写不敏感包含匹配
  if (!match) match = options.find(o =>
    o.text.toLowerCase().includes(valLower) || valLower.includes(o.text.trim().toLowerCase())
  );
  // 策略3: 去标点归一化匹配
  if (!match) match = options.find(o => normalize(o.text) === normalize(val));

  if (match) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, match.value);
    else el.value = match.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return;
  }

  // 策略4: 自定义下拉框 - 点击触发展开，查找浮层选项
  el.click();
  await sleep(300);
  const dropdownSelectors = [
    '[role="option"]', '[role="listbox"] li', '.dropdown-item', '.select-option',
    '[class*="option"]', '[class*="dropdown"] li', '.ant-select-item',
    '.el-select-dropdown__item', '[class*="menu-item"]', '[class*="list-item"]'
  ].join(', ');
  const dropdownOpts = document.querySelectorAll(dropdownSelectors);
  for (const opt of dropdownOpts) {
    const optText = (opt.textContent || '').trim();
    if (optText && (optText === val || optText.toLowerCase().includes(valLower) || valLower.includes(optText.toLowerCase()))) {
      await activateOptionNode(opt);
      return;
    }
  }
  // 点击空白关闭弹出
  document.body.click();
}

async function fillCustomDropdown(el, value) {
  const val = String(value).trim();
  const valLower = val.toLowerCase();
  const normalize = s => s.replace(/[\s\-_.,()（）【】]/g, '').toLowerCase();

  // 点击触发元素展开下拉
  el.click();
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  await sleep(350);

  const searchInput = findDropdownSearchInput(el);
  if (searchInput) {
    await setNativeInputValue(searchInput, val);
    await sleep(250);
  }

  // 查找浮层选项（覆盖主流 UI 框架）
  const allOpts = getDropdownOptionNodes();
  if (allOpts.length === 0) {
    return tryKeyboardSelect(el, val);
  }

  // 策略1: 精确匹配
  for (const opt of allOpts) {
    const text = (opt.textContent || '').trim();
    if (text === val) { await activateOptionNode(opt); return true; }
  }
  // 策略2: 包含匹配
  for (const opt of allOpts) {
    const text = (opt.textContent || '').trim().toLowerCase();
    if (text && (text.includes(valLower) || valLower.includes(text))) {
      await activateOptionNode(opt); return true;
    }
  }
  // 策略3: 归一化匹配
  for (const opt of allOpts) {
    const text = (opt.textContent || '').trim();
    if (text && normalize(text) === normalize(val)) {
      await activateOptionNode(opt); return true;
    }
  }
  // 策略4: 数值模糊匹配（如 "3年" 匹配 "3-5年" 或 "3年以上"）
  const numMatch = val.match(/\d+/);
  if (numMatch) {
    for (const opt of allOpts) {
      const text = (opt.textContent || '').trim();
      if (text.includes(numMatch[0])) {
        await activateOptionNode(opt); return true;
      }
    }
  }

  // 策略5: 键盘回车选择首项（很多搜索型下拉依赖这个）
  if (searchInput) {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
    await sleep(80);
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    await sleep(150);
    if (String(getCurrentValue(el) || '').trim()) return true;
  }

  // 关闭下拉
  document.body.click();
  await sleep(100);
  return false;
}

async function setCheckboxState(el, shouldCheck) {
  if (!!el.checked === !!shouldCheck) return;
  el.click();
  await sleep(80);
  if (!!el.checked !== !!shouldCheck) {
    el.checked = !!shouldCheck;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

async function activateOptionNode(node) {
  node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  node.click();
  await sleep(120);
}

async function ensureNearbyCurrentCheckboxState(el, shouldCheck) {
  const checkbox = findNearbyCurrentCheckbox(el);
  if (!checkbox) return;
  await setCheckboxState(checkbox, shouldCheck);
}

async function clearNearbyEndDateField(checkboxEl) {
  const endDateField = findNearbyEndDateField(checkboxEl);
  if (!endDateField) return;

  const fieldLike = {
    element: endDateField,
    type: endDateField.type || 'text',
    tagName: endDateField.tagName?.toUpperCase() || '',
    label: getLabel(endDateField),
    name: endDateField.name || '',
    placeholder: endDateField.placeholder || ''
  };
  await clearField(fieldLike);
}

function findNearbyCurrentCheckbox(el) {
  const container = el.closest('form, fieldset, [class*="form-group"], [class*="form-row"], [class*="field-group"], [class*="repeatable"], [class*="section"], [class*="entry"], [class*="item"]')
    || el.parentElement
    || document.body;
  const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'))
    .filter(node => shouldIncludeCheckbox(node));
  if (!checkboxes.length) return null;

  const sourceRect = el.getBoundingClientRect();
  return checkboxes
    .map(node => ({ node, dist: distanceBetweenRects(sourceRect, node.getBoundingClientRect()) }))
    .sort((a, b) => a.dist - b.dist)[0]?.node || null;
}

function findNearbyEndDateField(checkboxEl) {
  const container = checkboxEl.closest('form, fieldset, [class*="form-group"], [class*="form-row"], [class*="field-group"], [class*="repeatable"], [class*="section"], [class*="entry"], [class*="item"]')
    || checkboxEl.parentElement
    || document.body;
  const candidates = Array.from(container.querySelectorAll('input, textarea, select'))
    .filter(node => node !== checkboxEl && isInteractable(node));

  const scored = candidates
    .map(node => {
      const label = `${getLabel(node)} ${node.name || ''} ${node.placeholder || ''}`.toLowerCase();
      const score = /结束|离职|毕业|to\b|end|until|结束时间|end.?date/.test(label) ? 0 : 1000;
      return { node, score, dist: distanceBetweenRects(checkboxEl.getBoundingClientRect(), node.getBoundingClientRect()) };
    })
    .sort((a, b) => (a.score - b.score) || (a.dist - b.dist));

  return scored[0]?.node || null;
}

function distanceBetweenRects(a, b) {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function normalizeComparableText(value) {
  return String(value ?? '')
    .replace(/[\s\-_.,()（）【】/]/g, '')
    .toLowerCase()
    .trim();
}

function shouldIncludeCheckbox(el) {
  const label = `${getLabel(el)} ${el.name || ''} ${el.id || ''}`.toLowerCase();
  return /至今|当前|present|current|currently|在职|在读|ongoing/.test(label);
}

function isDateLikeField(field, el) {
  if (el.tagName?.toUpperCase() !== 'INPUT') return false;
  if (['date', 'month', 'datetime-local'].includes(el.type)) return true;
  const text = `${field.label || ''} ${field.name || ''} ${field.placeholder || ''}`.toLowerCase();
  return /日期|时间|start|end|from|to|毕业|入学|在职/.test(text);
}

function normalizeDateLikeValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(raw)) return raw.replace(/\//g, '-');
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/(\d{4})[./年-](\d{1,2})(?:[./月-](\d{1,2}))?/);
  if (!match) return raw;
  const year = match[1];
  const month = String(match[2]).padStart(2, '0');
  const day = match[3] ? `-${String(match[3]).padStart(2, '0')}` : '';
  return `${year}-${month}${day}`;
}

function applyDateDisplayFormat(el, normalized) {
  const current = String(el.value || el.placeholder || '').trim();
  if (!normalized) return '';
  if (current.includes('/')) return normalized.replace(/-/g, '/');
  if (current.includes('.')) return normalized.replace(/-/g, '.');
  if (current.includes('年')) {
    const match = normalized.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!match) return normalized;
    return match[3] ? `${match[1]}年${match[2]}月${match[3]}日` : `${match[1]}年${match[2]}月`;
  }
  return normalized;
}

function getDropdownOptionNodes() {
  const dropdownSelectors = [
    '[role="option"]', '[role="listbox"] li', '[role="listbox"] [role="option"]',
    '.ant-select-item-option', '.ant-select-item',
    '.el-select-dropdown__item', '.el-option',
    '.ant-cascader-menu-item',
    '.rc-virtual-list-holder-inner [role="option"]',
    '[class*="option"]:not(select)', '[class*="dropdown"] li',
    '[class*="menu-item"]', '[class*="list-item"]',
    '[class*="select-item"]', '[class*="picker-item"]'
  ].join(', ');

  return Array.from(document.querySelectorAll(dropdownSelectors)).filter(isVisibleNode);
}

function findDropdownSearchInput(el) {
  const active = document.activeElement;
  if (active && active.tagName === 'INPUT' && active !== el && isVisibleNode(active)) {
    return active;
  }

  const root = el.closest('.ant-select, .el-select, [class*="select"], [class*="dropdown"]') || document.body;
  const candidates = root.querySelectorAll('input:not([type="hidden"]):not([readonly]), [contenteditable="true"]');
  return Array.from(candidates).find(node => node !== el && isVisibleNode(node)) || null;
}

async function setNativeInputValue(el, value) {
  if (!el) return;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(20);
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (el.contentEditable === 'true') {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }
}

async function tryKeyboardSelect(el, value) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : el;
  if (!target) return false;
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
  target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowDown' }));
  await sleep(100);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  await sleep(150);

  const currentValue = String(getCurrentValue(el) || '').trim();
  if (!currentValue) return false;
  const normalizedCurrent = currentValue.replace(/[\s\-_.,()（）【】]/g, '').toLowerCase();
  const normalizedTarget = String(value || '').replace(/[\s\-_.,()（）【】]/g, '').toLowerCase();
  return normalizedCurrent.includes(normalizedTarget) || normalizedTarget.includes(normalizedCurrent);
}

function getAriaOptions(el) {
  // 找关联的 listbox 选项（aria-controls / aria-owns）
  const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (controls) {
    const listbox = document.getElementById(controls);
    if (listbox) {
      return Array.from(listbox.querySelectorAll('[role="option"]'))
        .map(o => o.textContent?.trim()).filter(Boolean);
    }
  }
  return [];
}

function getCurrentValue(el) {
  if (el.type === 'checkbox') return !!el.checked;
  if (el.contentEditable === 'true') return el.textContent?.trim() || '';
  return el.value || '';
}

function isVisibleNode(node) {
  if (!node || !(node instanceof Element)) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 动态表单监听（MutationObserver）
// ═══════════════════════════════════════════════════════════════════════════════

function startObserving() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    // 检查是否有新增的表单元素
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const hasForm = node.querySelector?.('input:not([type=hidden]), textarea, select, [contenteditable]');
        if (hasForm || node.matches?.('input, textarea, select')) {
          // 新表单出现，不自动重扫（避免频繁打扰）
          return;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// 页面加载完成后开始观察
if (document.readyState === 'complete') {
  startObserving();
} else {
  window.addEventListener('load', startObserving);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

function isInteractable(el) {
  if (el.disabled) return false;
  if (el.readOnly && !isCustomDropdownCandidate(el)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // 允许 position:fixed 元素（如悬浮表单）
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && style.position !== 'fixed') return false;
  return true;
}

function isCustomDropdownCandidate(el) {
  return el.getAttribute?.('role') === 'combobox'
    || el.getAttribute?.('aria-haspopup') === 'listbox'
    || el.closest?.('.ant-select, .el-select, [class*="select-wrap"], [class*="dropdown-trigger"]');
}

function cleanText(text) {
  return text?.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().substring(0, 80) || '';
}

function serializeFields(fields) {
  return fields.map(f => ({
    _domIndex: f._domIndex,
    type: f.type,
    id: f.id,
    name: f.name,
    label: f.label,
    placeholder: f.placeholder,
    hint: f.hint,
    section: f.section || '',
    options: f.options || [],
    currentValue: f.currentValue,
    checked: f.checked,
    required: !!f.required,
    autocomplete: f.autocomplete || '',
    inputMode: f.inputMode || '',
    bbox: f.bbox || null,
    group: f.group || null
  }));
}

function highlightElement(el, mode) {
  if (mode === 'detect') {
    el.style.outline = '2px solid #4f46e5';
    el.style.outlineOffset = '2px';
  } else if (mode === 'success') {
    el.style.outline = '2px solid #22c55e';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }, 2500);
  }
}

function clearAllHighlights() {
  document.querySelectorAll('*').forEach(el => {
    if (el.style?.outline?.includes('4f46e5') || el.style?.outline?.includes('22c55e')) {
      el.style.outline = '';
      el.style.outlineOffset = '';
    }
  });
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('cvflash-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'cvflash-toast';
  toast.className = `cvflash-toast cvflash-toast--${type}`;
  toast.innerHTML = `
    <span class="cvflash-toast__icon">${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
    <span class="cvflash-toast__text">${message}</span>
  `;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
