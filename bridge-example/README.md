# Bridge Example

最小可用的本地 Bridge 服务示例。

## 启动

```bash
cd /Users/chaosmac/Desktop/CVmax/bridge-example
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4.1"
export PORT="8787"
node server.mjs
```

可选环境变量：

- `OPENAI_BASE_URL`
- `BRIDGE_TOKEN`

## 插件配置

- 打开插件设置页
- 勾选 `优先使用 Bridge API 决策`
- `Bridge URL` 填：`http://127.0.0.1:8787/decide`
- 如果设置了 `BRIDGE_TOKEN`，在插件里填同样的 token

## 接口

### 健康检查

`GET /health`

### 决策接口

`POST /decide`

请求体中的 `mode`：

- `ping`
- `fill_commands`

返回格式：

```json
{
  "ok": true,
  "commands": [
    { "action": "set", "domIndex": 12, "value": "数据分析实习生" },
    { "action": "select", "domIndex": 13, "value": "实习" },
    { "action": "clear", "domIndex": 14 },
    { "action": "toggle", "domIndex": 15, "value": true }
  ]
}
```

## 替换成 MCP

这个示例当前直接调用 OpenAI 兼容接口。  
如果你后面要改成 DevTools MCP，只需要保留 `POST /decide` 的输入输出协议不变，把 `decideCommands` 里的实现换掉即可。
