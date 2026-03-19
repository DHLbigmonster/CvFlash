/**
 * 表单字段检测器
 * 负责扫描页面 DOM，提取所有可填写的表单元素及其语义标签
 */

// 忽略这些类型的 input
const IGNORED_INPUT_TYPES = new Set([
  'hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio'
]);

// 常见简历字段的关键词映射（用于辅助 AI 的提示）
const FIELD_HINTS = {
  name: /姓名|name|full.?name|your.?name/i,
  email: /邮箱|email|e-mail/i,
  phone: /电话|手机|phone|mobile|tel/i,
  location: /地址|城市|location|city|address/i,
  company: /公司|company|employer|organization/i,
  position: /职位|岗位|title|position|role/i,
  school: /学校|大学|school|university|college/i,
  degree: /学历|degree|education.?level/i,
  major: /专业|major|field.?of.?study/i,
  startDate: /开始时间|入职|start.?date|from/i,
  endDate: /结束时间|离职|end.?date|to(?!\w)/i,
  summary: /简介|自我介绍|summary|introduction|about.?me/i,
  skills: /技能|skill/i,
  salary: /薪资|期望薪资|salary|compensation/i,
  linkedin: /linkedin/i,
  github: /github/i,
  website: /网站|website|portfolio|homepage/i,
  years: /工作年限|experience.?year|years.?of/i
};

/**
 * 获取字段的语义标签（label 文字）
 */
function getFieldLabel(el) {
  // 1. 通过 for 属性关联的 label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent.trim();
  }

  // 2. 父元素中最近的 label
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true);
    clone.querySelectorAll('input,textarea,select').forEach(n => n.remove());
    const text = clone.textContent.trim();
    if (text) return text;
  }

  // 3. aria-label
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();

  // 4. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent.trim();
  }

  // 5. 向上查找最近包含文字的兄弟/父级元素（常见于自定义 UI 框架）
  let parent = el.parentElement;
  for (let i = 0; i < 4 && parent; i++) {
    const prevSibling = el.previousElementSibling;
    if (prevSibling && prevSibling.textContent.trim()) {
      return prevSibling.textContent.trim().substring(0, 50);
    }
    parent = parent.parentElement;
  }

  return '';
}

/**
 * 猜测字段的简历语义类型（用于提示 AI）
 */
function guessFieldType(label, name, placeholder) {
  const combined = `${label} ${name} ${placeholder}`.toLowerCase();
  for (const [type, pattern] of Object.entries(FIELD_HINTS)) {
    if (pattern.test(combined)) return type;
  }
  return 'unknown';
}

/**
 * 判断元素是否可见且可交互
 */
function isVisible(el) {
  if (!el.offsetParent && el.style.position !== 'fixed') return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  if (el.disabled || el.readOnly) return false;
  return true;
}

/**
 * 扫描页面中所有可填写的表单字段
 * @returns {Array} 字段描述对象数组
 */
export function detectFormFields() {
  const fields = [];
  let domIndex = 0;

  // 收集 input
  document.querySelectorAll('input').forEach(el => {
    if (IGNORED_INPUT_TYPES.has(el.type) || !isVisible(el)) return;

    const label = getFieldLabel(el);
    const name = el.name || '';
    const placeholder = el.placeholder || '';

    fields.push({
      _domIndex: domIndex++,
      element: el,
      tagName: 'INPUT',
      type: el.type || 'text',
      id: el.id || '',
      name,
      label,
      placeholder,
      hint: guessFieldType(label, name, placeholder),
      currentValue: el.value
    });
  });

  // 收集 textarea
  document.querySelectorAll('textarea').forEach(el => {
    if (!isVisible(el)) return;

    const label = getFieldLabel(el);
    const name = el.name || '';
    const placeholder = el.placeholder || '';

    fields.push({
      _domIndex: domIndex++,
      element: el,
      tagName: 'TEXTAREA',
      type: 'textarea',
      id: el.id || '',
      name,
      label,
      placeholder,
      hint: guessFieldType(label, name, placeholder),
      currentValue: el.value
    });
  });

  // 收集 select
  document.querySelectorAll('select').forEach(el => {
    if (!isVisible(el)) return;

    const label = getFieldLabel(el);
    const options = Array.from(el.options).map(o => o.text.trim()).filter(Boolean);

    fields.push({
      _domIndex: domIndex++,
      element: el,
      tagName: 'SELECT',
      type: 'select',
      id: el.id || '',
      name: el.name || '',
      label,
      placeholder: '',
      options,
      hint: guessFieldType(label, el.name, ''),
      currentValue: el.value
    });
  });

  return fields;
}

/**
 * 将字段列表序列化为可传给 AI 的纯数据对象（去掉 DOM 引用）
 */
export function serializeFields(fields) {
  return fields.map(f => ({
    _domIndex: f._domIndex,
    type: f.type,
    id: f.id,
    name: f.name,
    label: f.label,
    placeholder: f.placeholder,
    hint: f.hint,
    options: f.options || [],
    currentValue: f.currentValue
  }));
}

/**
 * 高亮显示检测到的字段（调试用）
 */
export function highlightFields(fields) {
  fields.forEach(f => {
    f.element.style.outline = '2px solid #4f46e5';
    f.element.style.outlineOffset = '2px';
  });
}

export function clearHighlights(fields) {
  fields.forEach(f => {
    f.element.style.outline = '';
    f.element.style.outlineOffset = '';
  });
}
