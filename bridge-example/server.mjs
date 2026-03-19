import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_TOKEN = String(process.env.BRIDGE_TOKEN || '').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4.1').trim();

const server = http.createServer(async (req, res) => {
  try {
    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      sendJson(res, 200, { ok: true, status: 'healthy', message: 'Bridge is running' });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/decide') {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    if (BRIDGE_TOKEN) {
      const auth = String(req.headers.authorization || '');
      const expected = BRIDGE_TOKEN.startsWith('Bearer ') ? BRIDGE_TOKEN : `Bearer ${BRIDGE_TOKEN}`;
      if (auth !== expected) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
    }

    const payload = await readJson(req);
    if (payload.mode === 'ping') {
      sendJson(res, 200, { ok: true, status: 'ok', message: 'Bridge ping succeeded' });
      return;
    }

    if (payload.mode !== 'fill_commands') {
      sendJson(res, 400, { ok: false, error: 'Unsupported mode' });
      return;
    }

    if (!OPENAI_API_KEY) {
      sendJson(res, 500, { ok: false, error: 'OPENAI_API_KEY is required for the example bridge server' });
      return;
    }

    const commands = await decideCommands(payload);
    sendJson(res, 200, { ok: true, commands });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`CVflash bridge example listening on http://127.0.0.1:${PORT}`);
});

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function decideCommands(payload) {
  const page = payload.page || {};
  const fields = Array.isArray(page.fields) ? page.fields : [];
  const resume = payload.resume || {};
  const screenshot = typeof payload.screenshot === 'string' ? payload.screenshot : '';

  const prompt = buildPrompt(page, fields, resume);
  const responseText = await callOpenAICompatible(prompt, screenshot);
  return parseCommands(responseText);
}

function buildPrompt(page, fields, resume) {
  const visibleFields = fields.map(field => ({
    domIndex: field._domIndex,
    label: field.label || field.name || field.placeholder || '',
    type: field.type,
    hint: field.hint,
    section: field.section,
    options: field.options || [],
    currentValue: field.currentValue,
    checked: field.checked,
    group: field.group || null,
    bbox: field.bbox || null
  }));

  return [
    '你是招聘表单填充决策器。请阅读页面字段快照与简历信息，返回可执行命令。',
    '',
    `页面标题: ${page.title || ''}`,
    `页面地址: ${page.url || ''}`,
    `当前分区: ${page.sectionContext || ''}`,
    '',
    '字段快照:',
    JSON.stringify(visibleFields, null, 2),
    '',
    '已确定字段:',
    JSON.stringify(page.existingFieldMap || {}, null, 2),
    '',
    '简历信息:',
    JSON.stringify(resume, null, 2),
    '',
    '只返回纯 JSON 对象，格式如下：',
    '{"commands":[{"action":"set|select|clear|toggle","domIndex":123,"value":"字符串或布尔值"}]}',
    '',
    '规则:',
    '- 普通输入框/文本域/日期输入框用 set',
    '- 下拉、可搜索下拉、combobox 用 select',
    '- 需要清空旧值时用 clear',
    '- 复选框（如至今/当前在职）用 toggle，value 必须是 true/false',
    '- 无法确定时不要输出该字段',
    '- 不要把姓名填到部门或职位',
    '- 工作类型必须是选项语义，如实习/全职/兼职',
    '- 日期返回 YYYY-MM 或页面已有格式等价值'
  ].join('\n');
}

async function callOpenAICompatible(prompt, screenshot) {
  const endpoint = `${OPENAI_BASE_URL}/chat/completions`;
  const content = screenshot
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: screenshot } }
      ]
    : prompt;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Model API error ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Model returned empty content');
  }
  return text;
}

function parseCommands(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) throw new Error('No JSON found in model response');

  const parsed = JSON.parse(candidate);
  const commands = Array.isArray(parsed?.commands) ? parsed.commands : (Array.isArray(parsed) ? parsed : []);
  return commands
    .map(command => ({
      action: String(command?.action || '').toLowerCase(),
      domIndex: Number(command?.domIndex),
      value: command?.value
    }))
    .filter(command => ['set', 'select', 'clear', 'toggle'].includes(command.action) && !Number.isNaN(command.domIndex));
}

function extractJsonCandidate(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) return objectMatch[0].trim();

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) return arrayMatch[0].trim();

  return '';
}
