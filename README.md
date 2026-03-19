# CVflash · 雷电霸王简历 ⚡

> AI 驱动的校招表单自动填充 Chrome 插件，让投简历快如闪电。

---

## 功能

- **PDF 简历解析** — 上传 PDF，AI 自动提取教育、工作、项目等结构化信息
- **表单自动填充** — 识别招聘网站表单结构，按分区精准填充
- **防重复填充** — 已填写的字段自动跳过，不覆盖已有内容
- **多套简历管理** — 支持创建多份简历，按分类切换
- **数据本地存储** — 简历数据只存在本地，不上传到任何服务器

## 安装

### 开发者模式加载（推荐）

1. 下载或 clone 本仓库
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目文件夹
5. 工具栏出现 ⚡ 图标即安装成功

## 使用前配置

插件需要一个支持 OpenAI 兼容接口的 API Key：

- **智谱 GLM**（推荐，有免费额度）：[open.bigmodel.cn](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys)
- **DeepSeek**：[platform.deepseek.com](https://platform.deepseek.com/api_keys)

1. 点击插件图标 → 右上角齿轮 ⚙️ 进入设置
2. 在「API 设置」中填入 API Key，选择对应 API 地址
3. 点击「测试连接」验证

## 使用方法

1. **添加简历**：设置页 → 我的简历 → 上传 PDF 或手动新建
2. **打开招聘页面**：如安克、BOSS直聘、拉勾等
3. **点击插件图标**，选择要使用的简历
4. **点击「AI 自动填充」**，等待完成

> 💡 提示：如果招聘表单需要多段经历（如多个实习），请先手动在网页上添加足够的条目，再运行填充。

## 技术栈

- Chrome Extension Manifest V3
- PDF.js（本地 PDF 解析）
- OpenAI 兼容 API（智谱 GLM / DeepSeek）
- 纯原生 JS，无框架依赖

## 隐私说明

- 简历数据存储在浏览器本地（`chrome.storage.local`）
- API Key 本地存储，仅用于调用你自己配置的 AI 接口
- 不收集任何用户数据

## License

MIT
