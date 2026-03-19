/**
 * CVflash Options Page Script
 * 管理简历、API 设置、填充历史
 */

// ─── 当前编辑状态 ──────────────────────────────────────────────────────────────

let currentResume = null;   // 正在编辑的简历对象
let allResumes = [];
let activeResumeId = null;
let activeCategoryFilter = '';  // 当前分类筛选

// ─── 初始化 ────────────────────────────────────────────────────────────────────

async function init() {
  await loadAll();
  bindNavigation();
  bindResumeActions();
  bindAPIActions();
  bindHistoryActions();

  // 处理来自 popup 的跳转
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'EDIT_RESUME' && msg.id) {
      activateTab('resumes');
      const resume = allResumes.find(r => r.id === msg.id);
      if (resume) openEditor(resume);
    }
  });
}

async function loadAll() {
  const data = await chrome.storage.local.get([
    'cvflash_resumes', 'cvflash_active_resume',
    'cvflash_api_key', 'cvflash_api_base', 'cvflash_settings', 'cvflash_history'
  ]);

  allResumes = data.cvflash_resumes || [];
  activeResumeId = data.cvflash_active_resume || (allResumes[0]?.id ?? null);

  renderCategoryFilter();
  renderResumeList();
  loadAPISettings(data);
  renderHistory(data.cvflash_history || []);
}

// ─── Tab 导航 ─────────────────────────────────────────────────────────────────

function bindNavigation() {
  document.querySelectorAll('.nav__item').forEach(item => {
    item.addEventListener('click', () => activateTab(item.dataset.tab));
  });
}

function activateTab(tabId) {
  document.querySelectorAll('.nav__item').forEach(el => el.classList.toggle('active', el.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === `tab-${tabId}`));
}

// ─── 简历列表 ─────────────────────────────────────────────────────────────────

function renderCategoryFilter() {
  const cats = ['', ...new Set(allResumes.map(r => r.category).filter(Boolean))];
  const container = document.getElementById('category-filter');
  container.innerHTML = cats.map(c => `
    <button class="cat-btn ${c === activeCategoryFilter ? 'active' : ''}" data-cat="${escapeHtml(c)}">
      ${c || '全部'}
    </button>
  `).join('');
  container.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCategoryFilter = btn.dataset.cat;
      renderCategoryFilter();
      renderResumeList();
    });
  });
}

function renderResumeList() {
  const container = document.getElementById('resume-list');
  const filtered = activeCategoryFilter
    ? allResumes.filter(r => r.category === activeCategoryFilter)
    : allResumes;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__text">${allResumes.length === 0 ? '还没有简历，点击「新建简历」或「上传 PDF」开始创建' : '该分类下暂无简历'}</div>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(r => `
    <div class="resume-card ${r.id === activeResumeId ? 'active' : ''}" data-id="${r.id}">
      <div class="resume-card__info">
        <div class="resume-card__name">
          ${escapeHtml(r.name || '未命名简历')}
          ${r.category ? `<span class="resume-card__tag">${escapeHtml(r.category)}</span>` : ''}
        </div>
        <div class="resume-card__meta">
          ${r.personal?.name ? escapeHtml(r.personal.name) + ' · ' : ''}
          更新于 ${formatDate(r.updatedAt)}
        </div>
      </div>
      <div class="resume-card__actions">
        <button class="btn btn--ghost btn--sm" data-action="activate" data-id="${r.id}">设为默认</button>
        <button class="btn btn--ghost btn--sm" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn--danger btn--sm" data-action="delete" data-id="${r.id}">删除</button>
      </div>
    </div>
  `).join('');
}

function bindResumeActions() {
  // 委托事件
  document.getElementById('resume-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'edit') {
      const resume = allResumes.find(r => r.id === id);
      if (resume) openEditor(resume);
    } else if (action === 'activate') {
      activeResumeId = id;
      await chrome.storage.local.set({ cvflash_active_resume: id });
      renderResumeList();
    } else if (action === 'delete') {
      if (!confirm('确定要删除这份简历吗？')) return;
      allResumes = allResumes.filter(r => r.id !== id);
      await chrome.storage.local.set({ cvflash_resumes: allResumes });
      if (activeResumeId === id) {
        activeResumeId = allResumes[0]?.id ?? null;
        await chrome.storage.local.set({ cvflash_active_resume: activeResumeId });
      }
      renderResumeList();
    }
  });

  document.getElementById('btn-new-resume').addEventListener('click', () => {
    const newResume = createEmptyResume('新建简历');
    openEditor(newResume);
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-import').click();
  });

  document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      data.id = generateId();
      data.updatedAt = new Date().toISOString();
      allResumes.push(data);
      await chrome.storage.local.set({ cvflash_resumes: allResumes });
      renderCategoryFilter();
      renderResumeList();
      showNotify('简历导入成功！');
    } catch (err) {
      alert('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  // PDF 上传
  document.getElementById('btn-upload-pdf').addEventListener('click', () => {
    document.getElementById('file-pdf').click();
  });

  document.getElementById('file-pdf').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    e.target.value = '';
    await handleBatchPDFUpload(files);
  });

  // Editor buttons
  document.getElementById('btn-save-resume').addEventListener('click', saveCurrentResume);
  document.getElementById('btn-cancel-edit').addEventListener('click', closeEditor);
  document.getElementById('btn-export-resume').addEventListener('click', () => {
    if (currentResume) exportResume(currentResume);
  });

  document.getElementById('btn-add-exp').addEventListener('click', () => addEntry('experience'));
  document.getElementById('btn-add-edu').addEventListener('click', () => addEntry('education'));
  document.getElementById('btn-add-proj').addEventListener('click', () => addEntry('project'));
  document.getElementById('btn-add-research').addEventListener('click', () => addEntry('research'));
  document.getElementById('btn-add-activity').addEventListener('click', () => addEntry('activity'));
}

// ─── 简历编辑器 ───────────────────────────────────────────────────────────────

function openEditor(resume) {
  currentResume = JSON.parse(JSON.stringify(resume)); // deep clone
  document.getElementById('resume-list').classList.add('hidden');
  document.getElementById('category-filter').classList.add('hidden');
  document.querySelector('.tab-header').classList.add('hidden');
  document.getElementById('resume-editor').classList.remove('hidden');

  // 填充基本信息
  document.getElementById('resume-name').value = resume.name || '';
  document.getElementById('resume-category').value = resume.category || '';
  const p = resume.personal || {};
  document.getElementById('f-name').value = p.name || '';
  document.getElementById('f-email').value = p.email || '';
  document.getElementById('f-phone').value = p.phone || '';
  document.getElementById('f-location').value = p.location || '';
  document.getElementById('f-linkedin').value = p.linkedin || '';
  document.getElementById('f-github').value = p.github || '';
  document.getElementById('f-website').value = p.website || '';
  document.getElementById('f-summary').value = resume.summary || '';
  document.getElementById('f-skills').value = (resume.skills || []).join(', ');
  document.getElementById('f-languages').value = (resume.languages || []).join(', ');
  document.getElementById('f-certifications').value = (resume.certifications || []).join(', ');
  document.getElementById('f-awards').value = (resume.awards || []).join(', ');
  document.getElementById('f-hobbies').value = (resume.hobbies || []).join(', ');

  // 渲染列表
  renderEntries('experience', resume.experience || []);
  renderEntries('education', resume.education || []);
  renderEntries('project', resume.projects || []);
  renderEntries('research', resume.research || []);
  renderEntries('activity', resume.activities || []);
}

function closeEditor() {
  currentResume = null;
  document.getElementById('resume-list').classList.remove('hidden');
  document.getElementById('category-filter').classList.remove('hidden');
  document.querySelector('.tab-header').classList.remove('hidden');
  document.getElementById('resume-editor').classList.add('hidden');
}

async function saveCurrentResume() {
  if (!currentResume) return;

  currentResume.name = document.getElementById('resume-name').value.trim() || '未命名简历';
  currentResume.category = document.getElementById('resume-category').value.trim();
  currentResume.personal = {
    name: document.getElementById('f-name').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    phone: document.getElementById('f-phone').value.trim(),
    location: document.getElementById('f-location').value.trim(),
    linkedin: document.getElementById('f-linkedin').value.trim(),
    github: document.getElementById('f-github').value.trim(),
    website: document.getElementById('f-website').value.trim()
  };
  currentResume.summary = document.getElementById('f-summary').value.trim();
  currentResume.skills = document.getElementById('f-skills').value.split(',').map(s => s.trim()).filter(Boolean);
  currentResume.languages = document.getElementById('f-languages').value.split(',').map(s => s.trim()).filter(Boolean);
  currentResume.certifications = document.getElementById('f-certifications').value.split(',').map(s => s.trim()).filter(Boolean);
  currentResume.awards = document.getElementById('f-awards').value.split(',').map(s => s.trim()).filter(Boolean);
  currentResume.hobbies = document.getElementById('f-hobbies').value.split(',').map(s => s.trim()).filter(Boolean);

  currentResume.experience = collectEntries('experience');
  currentResume.education = collectEntries('education');
  currentResume.projects = collectEntries('project');
  currentResume.research = collectEntries('research');
  currentResume.activities = collectEntries('activity');

  currentResume.updatedAt = new Date().toISOString();

  const idx = allResumes.findIndex(r => r.id === currentResume.id);
  if (idx >= 0) allResumes[idx] = currentResume;
  else allResumes.push(currentResume);

  await chrome.storage.local.set({ cvflash_resumes: allResumes });
  showNotify('简历已保存！');
  closeEditor();
  renderCategoryFilter();
  renderResumeList();
}

// ─── 动态条目（工作/教育/项目）────────────────────────────────────────────────

function renderEntries(type, items) {
  const containerMap = {
    experience: 'experience-list',
    education: 'education-list',
    project: 'project-list',
    research: 'research-list',
    activity: 'activity-list'
  };
  const container = document.getElementById(containerMap[type]);
  if (!container) return;
  container.innerHTML = items.map((item, i) => renderEntryCard(type, item, i)).join('');
}

function renderEntryCard(type, item, index) {
  if (type === 'experience') {
    return `
    <div class="entry-card" data-type="experience" data-index="${index}">
      <div class="entry-card__header">
        <div class="entry-card__title">${item.isInternship ? '实习' : '工作'}经历 #${index + 1}</div>
        <button class="btn btn--danger btn--sm" data-remove="${index}" data-type="experience">移除</button>
      </div>
      <div class="entry-grid">
        <div class="form-group"><label class="label">公司/组织名称</label>
          <input class="input" name="company" value="${escapeHtml(item.company || '')}" placeholder="公司全名"></div>
        <div class="form-group"><label class="label">职位</label>
          <input class="input" name="position" value="${escapeHtml(item.position || '')}" placeholder="职位名称"></div>
        <div class="form-group"><label class="label">开始时间</label>
          <input class="input" name="startDate" type="month" value="${item.startDate || ''}"></div>
        <div class="form-group"><label class="label">结束时间</label>
          <input class="input" name="endDate" type="month" value="${item.endDate || ''}" ${item.current ? 'disabled' : ''}></div>
        <div class="form-group">
          <label class="checkbox-row"><input type="checkbox" name="current" ${item.current ? 'checked' : ''}> 至今在职</label>
          <label class="checkbox-row" style="margin-left:12px"><input type="checkbox" name="isInternship" ${item.isInternship ? 'checked' : ''}> 实习</label>
        </div>
        <div class="form-group entry-full"><label class="label">工作内容</label>
          <textarea class="input textarea" name="description" rows="4" placeholder="描述主要职责和成就...">${escapeHtml(item.description || '')}</textarea></div>
      </div>
    </div>`;
  }

  if (type === 'education') {
    return `
    <div class="entry-card" data-type="education" data-index="${index}">
      <div class="entry-card__header">
        <div class="entry-card__title">教育经历 #${index + 1}</div>
        <button class="btn btn--danger btn--sm" data-remove="${index}" data-type="education">移除</button>
      </div>
      <div class="entry-grid entry-grid--3">
        <div class="form-group"><label class="label">学校名称</label>
          <input class="input" name="school" value="${escapeHtml(item.school || '')}" placeholder="学校全名"></div>
        <div class="form-group"><label class="label">学历</label>
          <select class="input select" name="degree">
            ${['专科','本科','硕士','博士','MBA','其他'].map(d => `<option ${item.degree === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="label">专业</label>
          <input class="input" name="major" value="${escapeHtml(item.major || '')}" placeholder="计算机科学"></div>
        <div class="form-group"><label class="label">入学时间</label>
          <input class="input" name="startDate" type="month" value="${item.startDate || ''}"></div>
        <div class="form-group"><label class="label">毕业时间</label>
          <input class="input" name="endDate" type="month" value="${item.endDate || ''}"></div>
        <div class="form-group"><label class="label">GPA（选填）</label>
          <input class="input" name="gpa" value="${escapeHtml(item.gpa || '')}" placeholder="3.8/4.0"></div>
        <div class="form-group entry-full"><label class="label">补充信息（选填）</label>
          <textarea class="input textarea" name="description" rows="2" placeholder="专业方向、主修课程、荣誉等...">${escapeHtml(item.description || '')}</textarea></div>
      </div>
    </div>`;
  }

  if (type === 'project') {
    return `
    <div class="entry-card" data-type="project" data-index="${index}">
      <div class="entry-card__header">
        <div class="entry-card__title">项目 #${index + 1}</div>
        <button class="btn btn--danger btn--sm" data-remove="${index}" data-type="project">移除</button>
      </div>
      <div class="entry-grid">
        <div class="form-group"><label class="label">项目名称</label>
          <input class="input" name="name" value="${escapeHtml(item.name || '')}" placeholder="项目名称"></div>
        <div class="form-group"><label class="label">担任角色</label>
          <input class="input" name="role" value="${escapeHtml(item.role || '')}" placeholder="前端负责人"></div>
        <div class="form-group"><label class="label">开始时间</label>
          <input class="input" name="startDate" type="month" value="${item.startDate || ''}"></div>
        <div class="form-group"><label class="label">结束时间</label>
          <input class="input" name="endDate" type="month" value="${item.endDate || ''}"></div>
        <div class="form-group entry-full"><label class="label">项目描述</label>
          <textarea class="input textarea" name="description" rows="4" placeholder="项目背景、技术栈、核心贡献...">${escapeHtml(item.description || '')}</textarea></div>
        <div class="form-group entry-full"><label class="label">项目链接（选填）</label>
          <input class="input" name="url" value="${escapeHtml(item.url || '')}" placeholder="https://github.com/..."></div>
      </div>
    </div>`;
  }

  if (type === 'research') {
    return `
    <div class="entry-card" data-type="research" data-index="${index}">
      <div class="entry-card__header">
        <div class="entry-card__title">科研经历 #${index + 1}</div>
        <button class="btn btn--danger btn--sm" data-remove="${index}" data-type="research">移除</button>
      </div>
      <div class="entry-grid">
        <div class="form-group"><label class="label">研究机构/实验室</label>
          <input class="input" name="institution" value="${escapeHtml(item.institution || '')}" placeholder="机构或实验室名称"></div>
        <div class="form-group"><label class="label">角色</label>
          <input class="input" name="role" value="${escapeHtml(item.role || '')}" placeholder="研究助理"></div>
        <div class="form-group"><label class="label">导师</label>
          <input class="input" name="advisor" value="${escapeHtml(item.advisor || '')}" placeholder="Prof. XXX"></div>
        <div class="form-group"><label class="label">开始时间</label>
          <input class="input" name="startDate" type="month" value="${item.startDate || ''}"></div>
        <div class="form-group"><label class="label">结束时间</label>
          <input class="input" name="endDate" type="month" value="${item.endDate || ''}"></div>
        <div class="form-group entry-full"><label class="label">研究内容</label>
          <textarea class="input textarea" name="description" rows="4" placeholder="研究方向、方法、成果...">${escapeHtml(item.description || '')}</textarea></div>
      </div>
    </div>`;
  }

  // activity
  return `
  <div class="entry-card" data-type="activity" data-index="${index}">
    <div class="entry-card__header">
      <div class="entry-card__title">校园/社团经历 #${index + 1}</div>
      <button class="btn btn--danger btn--sm" data-remove="${index}" data-type="activity">移除</button>
    </div>
    <div class="entry-grid">
      <div class="form-group"><label class="label">组织/社团名称</label>
        <input class="input" name="organization" value="${escapeHtml(item.organization || '')}" placeholder="社团或组织名称"></div>
      <div class="form-group"><label class="label">职务/角色</label>
        <input class="input" name="role" value="${escapeHtml(item.role || '')}" placeholder="社长、部长"></div>
      <div class="form-group"><label class="label">开始时间</label>
        <input class="input" name="startDate" type="month" value="${item.startDate || ''}"></div>
      <div class="form-group"><label class="label">结束时间</label>
        <input class="input" name="endDate" type="month" value="${item.endDate || ''}"></div>
      <div class="form-group entry-full"><label class="label">活动内容</label>
        <textarea class="input textarea" name="description" rows="4" placeholder="活动内容、职责、成果...">${escapeHtml(item.description || '')}</textarea></div>
    </div>
  </div>`;
}

function addEntry(type) {
  if (!currentResume) return;
  const keyMap = { project: 'projects', activity: 'activities', experience: 'experience', education: 'education', research: 'research' };
  const key = keyMap[type] || type;
  if (!currentResume[key]) currentResume[key] = [];

  const emptyMap = {
    experience: { company: '', position: '', startDate: '', endDate: '', current: false, isInternship: false, description: '' },
    education: { school: '', degree: '本科', major: '', startDate: '', endDate: '', gpa: '', description: '' },
    project: { name: '', role: '', startDate: '', endDate: '', description: '', url: '' },
    research: { institution: '', role: '', advisor: '', startDate: '', endDate: '', description: '' },
    activity: { organization: '', role: '', startDate: '', endDate: '', description: '' }
  };

  currentResume[key].push(emptyMap[type] || {});
  renderEntries(type, currentResume[key]);
}

// 监听条目移除
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn || !currentResume) return;
  const type = btn.dataset.type;
  const index = parseInt(btn.dataset.remove);
  const keyMap = { project: 'projects', activity: 'activities', experience: 'experience', education: 'education', research: 'research' };
  const key = keyMap[type] || type;
  currentResume[key].splice(index, 1);
  renderEntries(type, currentResume[key]);
});

// 监听 current checkbox 禁用 endDate
document.addEventListener('change', (e) => {
  if (e.target.name === 'current') {
    const card = e.target.closest('.entry-card');
    const endDateInput = card?.querySelector('[name="endDate"]');
    if (endDateInput) endDateInput.disabled = e.target.checked;
  }
});

function collectEntries(type) {
  const containerMap = {
    experience: 'experience-list',
    education: 'education-list',
    project: 'project-list',
    research: 'research-list',
    activity: 'activity-list'
  };
  const container = document.getElementById(containerMap[type]);
  return Array.from(container.querySelectorAll('.entry-card')).map(card => {
    const obj = {};
    card.querySelectorAll('input,textarea,select').forEach(el => {
      if (!el.name) return;
      if (el.type === 'checkbox') obj[el.name] = el.checked;
      else obj[el.name] = el.value.trim();
    });
    return obj;
  });
}

// ─── API 设置 ─────────────────────────────────────────────────────────────────

function loadAPISettings(data) {
  document.getElementById('api-key-input').value = data.cvflash_api_key || '';
  const apiBase = data.cvflash_api_base || 'https://api.deepseek.com/v1';
  document.getElementById('api-base-select').value = apiBase;

  const settings = data.cvflash_settings || {};
  const textModel = document.getElementById('text-model-select');
  const visionModel = document.getElementById('vision-model-select');
  if (settings.textModel) textModel.value = settings.textModel;
  if (settings.visionModel) visionModel.value = settings.visionModel;
  document.getElementById('setting-auto-detect').checked = settings.autoDetect ?? true;
  document.getElementById('setting-show-notification').checked = settings.showNotification ?? true;
  updateVisionModelState(apiBase);
}

function updateVisionModelState(apiBase) {
  const visionModelSelect = document.getElementById('vision-model-select');
  const visionHint = document.getElementById('vision-model-hint');
  const isDeepSeek = apiBase.includes('deepseek.com');

  visionModelSelect.disabled = isDeepSeek;
  visionHint.style.display = isDeepSeek ? 'block' : 'none';
}

function bindAPIActions() {
  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    const input = document.getElementById('api-key-input');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('btn-save-api').addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key-input').value.trim();
    const apiBase = document.getElementById('api-base-select').value;
    const settings = {
      textModel: document.getElementById('text-model-select').value,
      visionModel: document.getElementById('vision-model-select').value,
      autoDetect: document.getElementById('setting-auto-detect').checked,
      showNotification: document.getElementById('setting-show-notification').checked
    };
    await chrome.storage.local.set({
      cvflash_api_key: apiKey,
      cvflash_api_base: apiBase,
      cvflash_settings: settings
    });
    showNotify('设置已保存！');
  });

  document.getElementById('btn-test-api').addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key-input').value.trim();
    const apiBase = document.getElementById('api-base-select').value;
    const resultEl = document.getElementById('api-test-result');

    resultEl.textContent = '正在测试连接...';
    resultEl.className = 'test-result';
    resultEl.classList.remove('hidden');

    const resp = await chrome.runtime.sendMessage({ action: 'TEST_API', apiKey, apiBase });
    resultEl.textContent = resp.success ? '✓ ' + resp.message : '✗ ' + resp.message;
    resultEl.classList.add(resp.success ? 'success' : 'error');
  });

  // 自动切换默认模型（当选择不同 API 提供商时）
  document.getElementById('api-base-select').addEventListener('change', (e) => {
    const apiBase = e.target.value;
    const textModelSelect = document.getElementById('text-model-select');
    const visionModelSelect = document.getElementById('vision-model-select');

    if (apiBase.includes('deepseek.com')) {
      // 切换到 DeepSeek 时的默认模型（填充仅使用文本模型）
      textModelSelect.value = 'deepseek-chat';
      visionModelSelect.value = 'glm-4.6v-flash';
    } else if (apiBase.includes('bigmodel.cn') || apiBase.includes('api.z.ai')) {
      // 切换到智谱时的默认模型
      textModelSelect.value = 'glm-4.7-flash';
      visionModelSelect.value = 'glm-4.6v-flash';
    }

    updateVisionModelState(apiBase);
  });
}

// ─── 填充历史 ─────────────────────────────────────────────────────────────────

function renderHistory(history) {
  const container = document.getElementById('history-list');
  if (history.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state__icon">📜</div><div class="empty-state__text">暂无填充记录</div></div>';
    return;
  }
  container.innerHTML = history.map(h => `
    <div class="history-item">
      <div class="history-item__title">${escapeHtml(h.title || h.url || '未知页面')}</div>
      <div class="history-item__meta">${escapeHtml(h.resumeName || '')} · ${formatDate(h.timestamp)}</div>
      <div class="history-item__badge">已填 ${h.filledCount || 0} 项</div>
    </div>
  `).join('');
}

function bindHistoryActions() {
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (!confirm('确定要清空所有填充历史吗？')) return;
    await chrome.storage.local.remove('cvflash_history');
    renderHistory([]);
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function createEmptyResume(name, category = '') {
  return {
    id: generateId(), name, category,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    personal: { name: '', email: '', phone: '', location: '', linkedin: '', github: '', website: '' },
    summary: '', experience: [], education: [], skills: [], languages: [], projects: []
  };
}

// ─── PDF 上传解析 ──────────────────────────────────────────────────────────────

// ─── 批量 PDF 上传（支持单个或多个文件）──────────────────────────────────────

async function handleBatchPDFUpload(files) {
  const progressEl = document.getElementById('pdf-progress');
  const fillEl = document.getElementById('pdf-progress-fill');
  const textEl = document.getElementById('pdf-progress-text');
  const timerEl = document.getElementById('pdf-progress-timer');
  const batchEl = document.getElementById('pdf-batch-status');

  // 先检查 API Key
  const storageData = await chrome.storage.local.get(['cvflash_api_key', 'cvflash_api_base', 'cvflash_settings']);
  const apiKey = storageData.cvflash_api_key || '';
  if (!apiKey) {
    alert('请先在「API 设置」中填写 API Key，再上传 PDF');
    return;
  }

  const isBatch = files.length > 1;
  const results = []; // { file, status: 'done'|'error'|'scan', resume, error }

  progressEl.classList.remove('hidden');
  batchEl.classList.toggle('hidden', !isBatch);

  // 渲染批量列表
  function renderBatchList() {
    if (!isBatch) return;
    batchEl.innerHTML = results.map((r, i) => {
      const icon = r.status === 'done' ? '✓' : r.status === 'error' ? '✗' : r.status === 'scan' ? '⚠' : '⏳';
      const cls = r.status === 'done' ? 'done' : r.status === 'error' ? 'error' : 'active';
      const label = r.status === 'done'
        ? `${r.file.name} — ${r.resume?.personal?.name || '解析成功'}`
        : r.status === 'error'
        ? `${r.file.name} — 失败: ${r.error}`
        : r.status === 'scan'
        ? `${r.file.name} — 扫描版，已跳过`
        : `${r.file.name} — 处理中...`;
      return `<div class="pdf-batch-status__item pdf-batch-status__item--${cls}">${icon} ${label}</div>`;
    }).join('');
  }

  // 计时器：显示实际耗时
  let startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = `已耗时 ${elapsed}s`;
  }, 500);

  // 动态导入一次
  const { extractTextFromPDF } = await import('./lib/pdf-parser.js');
  const settings = storageData.cvflash_settings || {};

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const overallPct = Math.round((i / files.length) * 100);

    // 初始化该文件的状态
    results.push({ file, status: 'active', resume: null, error: null });
    renderBatchList();

    try {
      // Step 1: 读取文件
      fillEl.style.width = (overallPct + 5) + '%';
      textEl.textContent = isBatch
        ? `[${i + 1}/${files.length}] 读取文件...`
        : '正在读取 PDF 文件...';
      const arrayBuffer = await file.arrayBuffer();

      // Step 2: 提取文本
      fillEl.style.width = (overallPct + 10) + '%';
      textEl.textContent = isBatch
        ? `[${i + 1}/${files.length}] 提取文字内容...`
        : '正在提取文字内容...';

      let extractedText = '';
      let isScanPDF = false;
      try {
        extractedText = await extractTextFromPDF(arrayBuffer);
      } catch (pdfErr) {
        if (pdfErr.message === 'SCAN_PDF') {
          isScanPDF = true;
        } else {
          throw pdfErr;
        }
      }

      if (isScanPDF) {
        results[i].status = 'scan';
        renderBatchList();
        continue;
      }

      // Step 3: AI 解析（显示实时计时，不再写死估计时间）
      startTime = Date.now(); // 重置计时起点到 AI 调用开始
      fillEl.style.width = (overallPct + 20) + '%';
      textEl.textContent = isBatch
        ? `[${i + 1}/${files.length}] AI 解析中...`
        : 'AI 解析中...';
      timerEl.textContent = '已耗时 0s';

      const resp = await chrome.runtime.sendMessage({
        action: 'PARSE_PDF_RESUME',
        extractedText,
        imageDataUrl: null,
        apiKey,
        apiBase: storageData.cvflash_api_base,
        textModel: settings.textModel,
        visionModel: settings.visionModel
      });

      if (resp?.error) throw new Error(resp.error);
      if (!resp) throw new Error('未收到响应，请刷新后重试');

      // Step 4: 保存简历
      const fileName = file.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
      const newResume = {
        id: generateId(),
        name: resp.resume?.personal?.name ? `${resp.resume.personal.name}的简历` : fileName,
        category: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...resp.resume
      };

      allResumes.push(newResume);
      results[i].status = 'done';
      results[i].resume = newResume;
      renderBatchList();

    } catch (err) {
      console.error(`[CVflash] PDF解析失败 ${file.name}:`, err);
      results[i].status = 'error';
      results[i].error = err.message.includes('API Key') ? 'API Key 无效'
        : err.message.includes('超时') ? '请求超时'
        : err.message.slice(0, 30);
      renderBatchList();
    }
  }

  clearInterval(timerInterval);

  // 统一保存所有成功的简历
  const succeeded = results.filter(r => r.status === 'done');
  if (succeeded.length > 0) {
    await chrome.storage.local.set({ cvflash_resumes: allResumes });
  }

  fillEl.style.width = '100%';
  const failCount = results.filter(r => r.status === 'error').length;
  const scanCount = results.filter(r => r.status === 'scan').length;
  textEl.textContent = isBatch
    ? `完成：${succeeded.length} 成功${failCount ? `，${failCount} 失败` : ''}${scanCount ? `，${scanCount} 扫描版跳过` : ''}`
    : '解析完成！';
  timerEl.textContent = '';

  renderCategoryFilter();
  renderResumeList();

  // 单文件：直接打开编辑器；多文件：只提示
  setTimeout(() => {
    progressEl.classList.add('hidden');
    batchEl.classList.add('hidden');
    if (succeeded.length === 0) {
      let msg = '所有 PDF 解析失败。';
      if (results[0]?.status === 'error') {
        const e = results[0].error;
        if (e.includes('API Key') || e.includes('无效')) msg += '\n\n👉 请检查「API 设置」中的 API Key。';
        else if (e.includes('超时')) msg += '\n\n👉 网络较慢，请稍后重试。';
      }
      alert(msg);
    } else if (!isBatch) {
      openEditor(succeeded[0].resume);
      showNotify('解析完成，请确认并补充信息。');
    } else {
      showNotify(`${succeeded.length} 份简历已导入，可在列表中查看。`);
    }
  }, 800);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function exportResume(resume) {
  const blob = new Blob([JSON.stringify(resume, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cvflash_${resume.name || 'resume'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return iso; }
}

let notifyTimer = null;
function showNotify(msg) {
  let el = document.getElementById('cvflash-notify');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cvflash-notify';
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1e2e1e;border:1px solid rgba(166,227,161,.3);color:#a6e3a1;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// 启动
init();
