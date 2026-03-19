(() => {
  const providers = [
    {
      id: 'zhipu-cn',
      label: '智谱 GLM 国内',
      shortLabel: 'GLM CN',
      description: '默认稳定方案，适合国内直连与校招表单场景。',
      apiKind: 'openai',
      base: 'https://open.bigmodel.cn/api/paas/v4',
      supportsVision: true,
      requiresKey: true,
      tags: ['稳定', '中文', '默认'],
      textModelGroups: [
        {
          label: '推荐',
          options: [
            { value: 'glm-4.7-flash', label: 'glm-4.7-flash' },
            { value: 'glm-4.7-flashx', label: 'glm-4.7-flashx' },
            { value: 'glm-4.5-air', label: 'glm-4.5-air' }
          ]
        },
        {
          label: '高性能',
          options: [
            { value: 'glm-4.6', label: 'glm-4.6' },
            { value: 'glm-4.7', label: 'glm-4.7' },
            { value: 'glm-5-turbo', label: 'glm-5-turbo' },
            { value: 'glm-5', label: 'glm-5' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '推荐',
          options: [
            { value: 'glm-4.6v-flash', label: 'glm-4.6v-flash' },
            { value: 'glm-4.1v-thinking-flash', label: 'glm-4.1v-thinking-flash' }
          ]
        },
        {
          label: '高性能',
          options: [
            { value: 'glm-4v-flash', label: 'glm-4v-flash' },
            { value: 'glm-ocr', label: 'glm-ocr' },
            { value: 'glm-4.6v', label: 'glm-4.6v' }
          ]
        }
      ]
    },
    {
      id: 'zhipu-global',
      label: '智谱 GLM 国际',
      shortLabel: 'GLM Global',
      description: '适合海外网络环境，接口与国内版一致。',
      apiKind: 'openai',
      base: 'https://api.z.ai/api/paas/v4',
      supportsVision: true,
      requiresKey: true,
      tags: ['国际'],
      textModelGroups: [
        {
          label: '推荐',
          options: [
            { value: 'glm-4.7-flash', label: 'glm-4.7-flash' },
            { value: 'glm-4.7-flashx', label: 'glm-4.7-flashx' },
            { value: 'glm-4.5-air', label: 'glm-4.5-air' }
          ]
        },
        {
          label: '高性能',
          options: [
            { value: 'glm-4.6', label: 'glm-4.6' },
            { value: 'glm-4.7', label: 'glm-4.7' },
            { value: 'glm-5-turbo', label: 'glm-5-turbo' },
            { value: 'glm-5', label: 'glm-5' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '推荐',
          options: [
            { value: 'glm-4.6v-flash', label: 'glm-4.6v-flash' },
            { value: 'glm-4.1v-thinking-flash', label: 'glm-4.1v-thinking-flash' }
          ]
        },
        {
          label: '高性能',
          options: [
            { value: 'glm-4v-flash', label: 'glm-4v-flash' },
            { value: 'glm-ocr', label: 'glm-ocr' },
            { value: 'glm-4.6v', label: 'glm-4.6v' }
          ]
        }
      ]
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      shortLabel: 'DeepSeek',
      description: '文本匹配性价比高，当前扩展里默认不启用独立视觉链路。',
      apiKind: 'openai',
      base: 'https://api.deepseek.com/v1',
      supportsVision: false,
      requiresKey: true,
      tags: ['推理', '性价比'],
      textModelGroups: [
        {
          label: 'DeepSeek',
          options: [
            { value: 'deepseek-chat', label: 'deepseek-chat' },
            { value: 'deepseek-reasoner', label: 'deepseek-reasoner' }
          ]
        }
      ],
      visionModelGroups: []
    },
    {
      id: 'openai',
      label: 'OpenAI / ChatGPT',
      shortLabel: 'OpenAI',
      description: '主流通用模型，文本与图像输入支持完整。',
      apiKind: 'openai',
      base: 'https://api.openai.com/v1',
      supportsVision: true,
      requiresKey: true,
      tags: ['通用', '多模态'],
      textModelGroups: [
        {
          label: 'GPT-5',
          options: [
            { value: 'gpt-5.4', label: 'gpt-5.4' },
            { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
            { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano' },
            { value: 'gpt-5-chat-latest', label: 'gpt-5-chat-latest' }
          ]
        },
        {
          label: '兼容稳妥',
          options: [
            { value: 'gpt-4.1', label: 'gpt-4.1' },
            { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
            { value: 'gpt-4o', label: 'gpt-4o' },
            { value: 'gpt-4o-mini', label: 'gpt-4o-mini' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '推荐',
          options: [
            { value: 'gpt-4.1', label: 'gpt-4.1' },
            { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
            { value: 'gpt-4o', label: 'gpt-4o' }
          ]
        }
      ]
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      shortLabel: 'Gemini',
      description: '通过 Gemini OpenAI compatibility 接口接入，适合多模态与长上下文。',
      apiKind: 'openai',
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      supportsVision: true,
      requiresKey: true,
      tags: ['Google', '多模态'],
      textModelGroups: [
        {
          label: 'Gemini',
          options: [
            { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
            { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
            { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '多模态',
          options: [
            { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
            { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
            { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' }
          ]
        }
      ]
    },
    {
      id: 'anthropic',
      label: 'Anthropic Claude',
      shortLabel: 'Claude',
      description: '直连 Anthropic Messages API，适合偏稳健的长文本理解。',
      apiKind: 'anthropic',
      base: 'https://api.anthropic.com',
      supportsVision: true,
      requiresKey: true,
      tags: ['Claude', '直连'],
      textModelGroups: [
        {
          label: 'Claude',
          options: [
            { value: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0' },
            { value: 'claude-opus-4-1', label: 'claude-opus-4-1' },
            { value: 'claude-3-7-sonnet-latest', label: 'claude-3-7-sonnet-latest' },
            { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '多模态',
          options: [
            { value: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0' },
            { value: 'claude-opus-4-1', label: 'claude-opus-4-1' }
          ]
        }
      ]
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      shortLabel: 'OpenRouter',
      description: '一个入口聚合多个厂商，适合频繁切换模型或想走统一账单。',
      apiKind: 'openai',
      base: 'https://openrouter.ai/api/v1',
      supportsVision: true,
      requiresKey: true,
      tags: ['聚合', '统一网关'],
      textModelGroups: [
        {
          label: '常用预设',
          options: [
            { value: 'openai/gpt-5.4-mini', label: 'openai/gpt-5.4-mini' },
            { value: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini' },
            { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
            { value: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '多模态',
          options: [
            { value: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini' },
            { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
            { value: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' }
          ]
        }
      ]
    },
    {
      id: 'ollama',
      label: 'Ollama 本地',
      shortLabel: 'Ollama',
      description: '本地 OpenAI-compatible 入口，适合离线或隐私优先工作流。',
      apiKind: 'openai',
      base: 'http://127.0.0.1:11434/v1',
      supportsVision: false,
      requiresKey: false,
      tags: ['本地', '免 Key'],
      textModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'gpt-oss:20b', label: 'gpt-oss:20b' },
            { value: 'gpt-oss:120b', label: 'gpt-oss:120b' },
            { value: 'qwen3:14b', label: 'qwen3:14b' },
            { value: 'deepseek-r1:14b', label: 'deepseek-r1:14b' }
          ]
        }
      ],
      visionModelGroups: []
    },
    {
      id: 'lmstudio',
      label: 'LM Studio 本地',
      shortLabel: 'LM Studio',
      description: '桌面本地推理服务器，支持 OpenAI 或 Anthropic 兼容模式。',
      apiKind: 'openai',
      base: 'http://127.0.0.1:1234/v1',
      supportsVision: true,
      requiresKey: false,
      tags: ['本地', '桌面'],
      textModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'gpt-oss-20b', label: 'gpt-oss-20b' },
            { value: 'qwen3-coder-30b', label: 'qwen3-coder-30b' },
            { value: 'gemma-3-27b', label: 'gemma-3-27b' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '本地多模态',
          options: [
            { value: 'gemma-3-27b', label: 'gemma-3-27b' },
            { value: 'qwen2.5-vl-7b', label: 'qwen2.5-vl-7b' }
          ]
        }
      ]
    },
    {
      id: 'custom-openai',
      label: '自定义 OpenAI 兼容',
      shortLabel: 'Custom OpenAI',
      description: '适合任意 OpenAI-compatible 网关，也可接本地 Codex / 自建代理。',
      apiKind: 'openai',
      base: 'http://127.0.0.1:8787/v1',
      supportsVision: true,
      requiresKey: false,
      customBase: true,
      tags: ['自定义', 'Codex'],
      textModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'codex-mini-latest', label: 'codex-mini-latest' },
            { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
            { value: 'custom-model', label: 'custom-model' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            { value: 'custom-vision-model', label: 'custom-vision-model' }
          ]
        }
      ]
    },
    {
      id: 'custom-anthropic',
      label: '自定义 Anthropic 兼容',
      shortLabel: 'Custom Anthropic',
      description: '适合 Claude Code / Anthropic-compatible 本地桥接服务。',
      apiKind: 'anthropic',
      base: 'http://127.0.0.1:8123',
      supportsVision: true,
      requiresKey: false,
      customBase: true,
      tags: ['自定义', 'Claude Code'],
      textModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0' },
            { value: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku-latest' },
            { value: 'custom-claude-model', label: 'custom-claude-model' }
          ]
        }
      ],
      visionModelGroups: [
        {
          label: '示例模型',
          options: [
            { value: 'claude-sonnet-4-0', label: 'claude-sonnet-4-0' },
            { value: 'custom-vision-model', label: 'custom-vision-model' }
          ]
        }
      ]
    }
  ];

  function flattenModelGroups(groups) {
    return (groups || []).flatMap((group) => group.options || []);
  }

  function getProviderById(id) {
    return providers.find((provider) => provider.id === id) || providers[0];
  }

  function resolveProviderByBase(base) {
    const normalized = String(base || '').trim().toLowerCase();
    if (!normalized) return providers[0];

    return providers.find((provider) => {
      const expected = String(provider.base || '').toLowerCase();
      if (!expected) return false;

      if (provider.customBase) {
        if (provider.apiKind === 'anthropic') {
          return normalized.includes('anthropic') || (!normalized.endsWith('/v1') && !normalized.includes('/openai'));
        }
        return normalized.endsWith('/v1') || normalized.includes('/openai');
      }

      return normalized.startsWith(expected) || normalized.includes(expected.replace(/^https?:\/\//, ''));
    }) || providers[0];
  }

  function pickDefaultModel(provider, kind) {
    const groups = kind === 'vision' ? provider.visionModelGroups : provider.textModelGroups;
    return flattenModelGroups(groups)[0]?.value || '';
  }

  function getProviderMeta(idOrBase) {
    if (!idOrBase) return providers[0];
    if (idOrBase.includes && idOrBase.includes('http')) {
      return resolveProviderByBase(idOrBase);
    }
    return getProviderById(idOrBase);
  }

  globalThis.CVFLASH_MODEL_CONFIG = {
    providers,
    flattenModelGroups,
    getProviderById,
    getProviderMeta,
    resolveProviderByBase,
    pickDefaultTextModel(providerIdOrBase) {
      const provider = getProviderMeta(providerIdOrBase);
      return pickDefaultModel(provider, 'text');
    },
    pickDefaultVisionModel(providerIdOrBase) {
      const provider = getProviderMeta(providerIdOrBase);
      return pickDefaultModel(provider, 'vision');
    }
  };
})();
