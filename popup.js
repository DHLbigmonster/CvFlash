/**
 * CVmax Popup Script
 */

// DOM refs
const resumeSelect = document.getElementById('resume-select');
const btnEditResume = document.getElementById('btn-edit-resume');
const btnSettings = document.getElementById('btn-settings');
const btnDetect = document.getElementById('btn-detect');
const btnFill = document.getElementById('btn-fill');
const btnVision = document.getElementById('btn-vision');
const btnHistory = document.getElementById('btn-history');
const warnGotoSettings = document.getElementById('warn-goto-settings');
const pageTitle = document.getElementById('page-title');
const fieldBadge = document.getElementById('field-badge');
const statusMessage = document.getElementById('status-message');
const errorMessage = document.getElementById('error-message');
const statusSpinner = document.getElementById('status-spinner');
const statusText = document.getElementById('status-text');
const errorText = document.getElementById('error-text');
const noApiWarning = document.getElementById('no-api-warning');

let detectedFields = [];
let activeResume = null;
let apiKey = '';
let settings = {};

// ─── 分类 Tab + 简历下拉渲染 ─────────────────────────────────────────────────

let allResumesList = [];
let currentCategoryFilter = '';

function renderCategoryTabs(resumes, activeId) {
  allResumesList = resumes;
  const tabContainer = document.getElementById('popup-cat-tabs');
  const cats = [...new Set(resumes.map(r => r.category).filter(Boolean))];

  if (cats.length > 1) {
    tabContainer.innerHTML = ['', ...cats].map(c => `
      <button class="popup-cat-tab ${c === currentCategoryFilter ? 'active' : ''}" data-cat="${escapeHtml(c)}">
        ${c || '全部'}
      </button>
    `).join('');
    tabContainer.querySelectorAll('.popup-cat-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        currentCategoryFilter = btn.dataset.cat;
        renderCategoryTabs(allResumesList, resumeSelect.value);
      });
    });
    tabContainer.style.display = 'flex';
  } else {
    tabContainer.style.display = 'none';
  }

  // 根据当前分类筛选简历
  const filtered = currentCategoryFilter
    ? resumes.filter(r => r.category === currentCategoryFilter)
    : resumes;

  resumeSelect.innerHTML = filtered.length
    ? filtered.map(r => `<option value="${r.id}">${escapeHtml(r.category ? `[${r.category}] ` : '') + escapeHtml(r.name)}</option>`).join('')
    : '<option value="">— 请先添加简历 —</option>';

  if (filtered.length) {
    if (activeId && filtered.find(r => r.id === activeId)) {
      resumeSelect.value = activeId;
    }
    activeResume = filtered.find(r => r.id === resumeSelect.value) || filtered[0];
    if (activeResume) resumeSelect.value = activeResume.id;
  }
}

// ─── 初始化 ────────────────────────────────────────────────────────────────────

async function init() {
  // 从 storage 加载数据
  const data = await chrome.storage.local.get([
    'cvmax_resumes', 'cvmax_active_resume', 'cvmax_api_key', 'cvmax_settings'
  ]);

  apiKey = data.cvmax_api_key || '';
  settings = data.cvmax_settings || { textModel: 'glm-4.7-flash', visionModel: 'glm-4.6v-flash' };

  // 填充简历下拉列表（含分类 tab）
  const resumes = data.cvmax_resumes || [];
  renderCategoryTabs(resumes, data.cvmax_active_resume);

  // API Key 检查
  if (!apiKey) {
    noApiWarning.classList.remove('hidden');
  }

  // 获取当前标签页信息
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    pageTitle.textContent = tab.title?.substring(0, 40) || tab.url || '—';
    // 询问 content script 当前已检测的字段数
    const resp = await sendToContent(tab.id, { action: 'GET_PAGE_INFO' });
    if (resp?.fieldCount > 0) {
      updateFieldBadge(resp.fieldCount);
      detectedFields = new Array(resp.fieldCount);
      btnFill.disabled = false;
    }
  }

  // 检查是否有正在进行的后台填充任务
  chrome.runtime.sendMessage({ action: 'GET_FILL_STATUS' }, (status) => {
    if (chrome.runtime.lastError) return;
    if (status && status.state !== 'idle' && status.state !== 'done' && status.state !== 'error') {
      // 有正在进行的填充任务
      showStatus(status.message, true);
      setBtnsDisabled(true);
    } else if (status?.state === 'done' && Date.now() - status.timestamp < 5000) {
      showStatus('✓ ' + status.message, false);
      setTimeout(hideStatus, 3000);
    } else if (status?.state === 'error' && Date.now() - status.timestamp < 5000) {
      showStatus(status.message, false);
      setTimeout(hideStatus, 3000);
    }
  });
}

// ─── 事件绑定 ─────────────────────────────────────────────────────────────────

btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
warnGotoSettings.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

btnEditResume.addEventListener('click', () => {
  const id = resumeSelect.value;
  chrome.runtime.openOptionsPage();
  // 传递要编辑的 id（通过 URL hash 简单实现）
  setTimeout(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.url?.includes('options.html')) {
        chrome.tabs.sendMessage(tab.id, { action: 'EDIT_RESUME', id });
      }
    });
  }, 300);
});

resumeSelect.addEventListener('change', async () => {
  const data = await chrome.storage.local.get('cvmax_resumes');
  const resumes = data.cvmax_resumes || [];
  activeResume = resumes.find(r => r.id === resumeSelect.value);
  if (activeResume) {
    await chrome.storage.local.set({ cvmax_active_resume: activeResume.id });
  }
});

btnDetect.addEventListener('click', handleDetect);
btnFill.addEventListener('click', handleFill);
btnVision.addEventListener('click', handleVisionFill);
btnHistory.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ─── 检测表单字段 ─────────────────────────────────────────────────────────────

async function handleDetect() {
  showStatus('正在检测表单字段...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const resp = await sendToContent(tab.id, { action: 'DETECT_FIELDS' });

    if (resp?.error) throw new Error(resp.error);

    detectedFields = resp.fields || [];
    updateFieldBadge(detectedFields.length);

    if (detectedFields.length > 0) {
      btnFill.disabled = false;
      hideStatus();
    } else {
      showStatus('未找到可填写的表单字段', false);
      setTimeout(hideStatus, 2500);
    }
  } catch (e) {
    showStatus('检测失败: ' + e.message, false);
    setTimeout(hideStatus, 3000);
  }
}

// ─── AI 自动填充（后台驱动，不受 popup 关闭影响）─────────────────────────────

async function handleFill() {
  if (!apiKey) { chrome.runtime.openOptionsPage(); return; }
  if (!activeResume) {
    showStatus('请先选择简历', false);
    setTimeout(hideStatus, 2000);
    return;
  }

  showStatus('正在启动 AI 填充...');
  setBtnsDisabled(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 发起后台填充（整个流程在 background 运行，popup 关闭也不影响）
    chrome.runtime.sendMessage({
      action: 'START_FILL',
      tabId: tab.id,
      resume: activeResume,
      apiKey,
      apiBase: (await chrome.storage.local.get('cvmax_api_base')).cvmax_api_base,
      model: settings.textModel
    }).then(resp => {
      if (resp?.error) {
        showStatus('填充失败: ' + resp.error, false);
        setTimeout(hideStatus, 4000);
      } else if (resp?.filledCount != null) {
        updateFieldBadge(resp.totalFields, resp.filledCount);
        showStatus(`✓ 已填充 ${resp.filledCount} 个字段`, false);
        setTimeout(hideStatus, 3000);
      }
      setBtnsDisabled(false);
    }).catch(e => {
      showStatus('填充失败: ' + e.message, false);
      setTimeout(hideStatus, 4000);
      setBtnsDisabled(false);
    });

  } catch (e) {
    showStatus('填充失败: ' + e.message, false);
    setTimeout(hideStatus, 4000);
    setBtnsDisabled(false);
  }
}

// 监听后台填充状态更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'FILL_STATUS_UPDATE') {
    if (msg.state === 'error') {
      showStatus(msg.message, false);
      setBtnsDisabled(false);
    } else if (msg.state === 'done') {
      showStatus('✓ ' + msg.message, false);
      setBtnsDisabled(false);
      setTimeout(hideStatus, 3000);
    } else {
      showStatus(msg.message, true);
    }
  }
});

// ─── 视觉模式（已合并到主填充流程）────────────────────────────────────────────

async function handleVisionFill() {
  // 视觉分析已合并到主填充流程（自动截图+AI识别），直接调用普通填充
  return handleFill();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function showStatus(text, spinning = true) {
  // Check if it's an error message
  const isError = text.includes('失败') || text.includes('错误') || text.includes('异常');

  if (isError) {
    errorText.textContent = text;
    errorMessage.classList.remove('hidden');
    statusMessage.classList.add('hidden');
  } else {
    statusText.textContent = text;
    statusSpinner.style.display = spinning ? 'block' : 'none';
    statusMessage.classList.remove('hidden');
    errorMessage.classList.add('hidden');
  }
}

function hideStatus() {
  statusMessage.classList.add('hidden');
  errorMessage.classList.add('hidden');
}

function setBtnsDisabled(disabled) {
  btnDetect.disabled = disabled;
  btnFill.disabled = disabled;
  btnVision.disabled = disabled;
}

function updateFieldBadge(total, filled) {
  if (total === 0) {
    fieldBadge.textContent = '未检测';
    fieldBadge.className = 'field-badge field-badge--gray';
  } else if (filled != null) {
    fieldBadge.textContent = `${filled}/${total} 已填`;
    fieldBadge.className = 'field-badge field-badge--success';
  } else {
    fieldBadge.textContent = `${total}个字段`;
    fieldBadge.className = 'field-badge';
  }
}

function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, async (resp) => {
      if (!chrome.runtime.lastError) {
        resolve(resp);
        return;
      }

      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
        chrome.tabs.sendMessage(tabId, message, (retryResp) => {
          if (chrome.runtime.lastError) {
            resolve({ error: '无法连接到页面，请刷新后重试' });
          } else {
            resolve(retryResp);
          }
        });
      } catch (_) {
        resolve({ error: '当前页面无法加载扩展脚本，请刷新后重试' });
      }
    });
  });
}

async function saveHistory(entry) {
  const data = await chrome.storage.local.get('cvmax_history');
  const history = data.cvmax_history || [];
  history.unshift(entry);
  // 最多保留 50 条
  if (history.length > 50) history.length = 50;
  await chrome.storage.local.set({ cvmax_history: history });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 启动
init();
