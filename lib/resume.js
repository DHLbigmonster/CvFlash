/**
 * 简历数据管理
 * 处理简历的增删改查和 chrome.storage 持久化
 */

export const STORAGE_KEYS = {
  RESUMES: 'cvflash_resumes',
  ACTIVE_RESUME_ID: 'cvflash_active_resume',
  API_KEY: 'cvflash_api_key',
  API_BASE: 'cvflash_api_base',
  SETTINGS: 'cvflash_settings'
};

/**
 * 空简历模板
 */
export function createEmptyResume(name = '我的简历', category = '') {
  return {
    id: generateId(),
    name,
    category,   // 简历分类，如"前端工程师"、"产品经理"、"校招"等
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    personal: {
      name: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      github: '',
      website: ''
    },
    summary: '',
    experience: [],
    education: [],
    skills: [],
    languages: [],
    certifications: [],
    projects: []
  };
}

export function createEmptyExperience() {
  return {
    id: generateId(),
    company: '',
    position: '',
    startDate: '',
    endDate: '',
    current: false,
    description: ''
  };
}

export function createEmptyEducation() {
  return {
    id: generateId(),
    school: '',
    degree: '',
    major: '',
    startDate: '',
    endDate: '',
    gpa: ''
  };
}

export function createEmptyProject() {
  return {
    id: generateId(),
    name: '',
    role: '',
    startDate: '',
    endDate: '',
    description: '',
    url: ''
  };
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

export async function getAllResumes() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RESUMES);
  return data[STORAGE_KEYS.RESUMES] || [];
}

export async function saveResume(resume) {
  const resumes = await getAllResumes();
  resume.updatedAt = new Date().toISOString();
  const idx = resumes.findIndex(r => r.id === resume.id);
  if (idx >= 0) {
    resumes[idx] = resume;
  } else {
    resumes.push(resume);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.RESUMES]: resumes });
  return resume;
}

export async function deleteResume(id) {
  const resumes = await getAllResumes();
  const filtered = resumes.filter(r => r.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.RESUMES]: filtered });

  // 如果删的是当前激活的，清除激活
  const active = await getActiveResumeId();
  if (active === id) {
    await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_RESUME_ID);
  }
}

export async function getActiveResumeId() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_RESUME_ID);
  return data[STORAGE_KEYS.ACTIVE_RESUME_ID] || null;
}

export async function setActiveResumeId(id) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_RESUME_ID]: id });
}

export async function getActiveResume() {
  const [resumes, activeId] = await Promise.all([getAllResumes(), getActiveResumeId()]);
  if (!resumes.length) return null;
  if (activeId) {
    const found = resumes.find(r => r.id === activeId);
    if (found) return found;
  }
  return resumes[0]; // 默认返回第一个
}

// ─── API 设置 ─────────────────────────────────────────────────────────────────

export async function getApiKey() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  return data[STORAGE_KEYS.API_KEY] || '';
}

export async function saveApiKey(key) {
  await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: key });
}

export async function getApiBase() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.API_BASE);
  return data[STORAGE_KEYS.API_BASE] || 'https://open.bigmodel.cn/api/paas/v4';
}

export async function saveApiBase(base) {
  await chrome.storage.local.set({ [STORAGE_KEYS.API_BASE]: base });
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return data[STORAGE_KEYS.SETTINGS] || {
    providerId: 'zhipu-cn',
    textModel: 'glm-4.7-flash',
    visionModel: 'glm-4.6v-flash',
    autoDetect: true,
    showNotification: true
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

// ─── Export / Import ──────────────────────────────────────────────────────────

export function exportResume(resume) {
  const blob = new Blob([JSON.stringify(resume, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cvflash_${resume.name || 'resume'}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importResumeFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // 生成新 ID 防止冲突
        data.id = generateId();
        data.updatedAt = new Date().toISOString();
        resolve(data);
      } catch (err) {
        reject(new Error('JSON 解析失败：' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
