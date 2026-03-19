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
  let filledCount = 0, skippedCount = 0, alreadyFilledCount = 0;
  for (const [domIndex, value] of Object.entries(fieldMap)) {
    if (value == null || value === '') { skippedCount++; continue; }
    const field = detectedFields.find(f => f._domIndex === Number(domIndex));
    if (!field) { skippedCount++; continue; }

    // 问题2修复：跳过已有内容的字段，避免重复填充
    const currentVal = getCurrentValue(field.element);
    if (currentVal && String(currentVal).trim() !== '') {
      console.log(`[CVflash] 跳过已填写字段: "${field.label}" 当前值="${currentVal}"`);
      alreadyFilledCount++;
      continue;
    }

    try {
      await fillField(field, value);
      highlightElement(field.element, 'success');
      filledCount++;
    } catch (e) {
      console.warn('[CVflash] 填充失败:', field.label || field.name, e);
      skippedCount++;
    }
  }
  const skipMsg = alreadyFilledCount > 0 ? `，${alreadyFilledCount} 个已有内容跳过` : '';
  showToast(`✓ 已填充 ${filledCount} 个字段${skipMsg}`, 'success');
  return { filledCount, skippedCount, alreadyFilledCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 通用字段收集器
// ═══════════════════════════════════════════════════════════════════════════════

const IGNORED_INPUT_TYPES = new Set([
  'hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'
]);

/**
 * 递归收集文档（含 Shadow DOM）中所有可填写字段
 */
function collectAllFields(root) {
  const fields = [];
  let domIndex = 0;

  function walk(node) {
    // 1. 标准表单元素
    node.querySelectorAll('input, textarea, select').forEach(el => {
      if (el.tagName === 'INPUT' && IGNORED_INPUT_TYPES.has(el.type)) return;
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      el.dataset.cvflashScanned = '1';

      const field = buildFieldDescriptor(el, domIndex++);
      if (field) fields.push(field);
    });

    // 2. contenteditable 元素（富文本、自定义输入框）
    node.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(el => {
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      if (el.tagName === 'BODY' || el.closest('[data-cvflash-scanned]')) return;
      el.dataset.cvflashScanned = '1';

      const field = buildFieldDescriptor(el, domIndex++, 'contenteditable');
      if (field) fields.push(field);
    });

    // 3. ARIA role 自定义输入组件（企业级 UI）
    node.querySelectorAll('[role="textbox"], [role="combobox"], [role="spinbutton"], [role="searchbox"]').forEach(el => {
      if (!isInteractable(el)) return;
      if (el.dataset.cvflashScanned) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return; // 已处理
      el.dataset.cvflashScanned = '1';

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
  document.querySelectorAll('[data-cvflash-scanned]').forEach(el => {
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

async function fillField(field, value) {
  const el = field.element;
  const tag = el.tagName.toUpperCase();

  el.focus();
  await sleep(40);

  if (field.type === 'contenteditable' || el.contentEditable === 'true') {
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

  if (field.type.startsWith('aria-')) {
    // ARIA 自定义输入：模拟键盘输入
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

  // 标准 input / textarea - 兼容 React/Vue/Angular
  const nativeSetter = Object.getOwnPropertyDescriptor(
    tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }

  // 触发框架响应
  ['input', 'change', 'blur'].forEach(evt => {
    el.dispatchEvent(new Event(evt, { bubbles: true }));
  });

  // Vue 3 / React 合成事件补充
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  await sleep(30);
  el.blur();
}

async function fillSelect(el, value) {
  // 优先精确匹配，其次部分匹配
  const options = Array.from(el.options);
  const exact = options.find(o => o.text.trim() === value || o.value === value);
  const partial = options.find(o =>
    o.text.toLowerCase().includes(value.toLowerCase()) ||
    value.toLowerCase().includes(o.text.toLowerCase())
  );
  const match = exact || partial;

  if (match) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, match.value);
    else el.value = match.value;

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 自定义下拉（click 触发展开）- 若原生 select 没有 options 则尝试点击触发
  if (!match && el.options.length <= 1) {
    el.click();
    await sleep(300);
    // 查找 dropdown 选项
    const dropdowns = document.querySelectorAll(
      '[role="option"], [role="listbox"] li, .dropdown-item, .select-option, [class*="option"]'
    );
    for (const opt of dropdowns) {
      if (opt.textContent?.trim().toLowerCase().includes(value.toLowerCase())) {
        opt.click();
        break;
      }
    }
  }
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
  if (el.contentEditable === 'true') return el.textContent?.trim() || '';
  return el.value || '';
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
  if (el.disabled || el.readOnly) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // 允许 position:fixed 元素（如悬浮表单）
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && style.position !== 'fixed') return false;
  return true;
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
