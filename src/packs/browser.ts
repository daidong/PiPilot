/**
 * browser - 浏览器自动化包
 *
 * 提供 Web 浏览器自动化能力，用于访问没有 API 的网站。
 * 基于 agent-browser CLI 工具。
 *
 * @see https://agent-browser.dev/
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { browser, browse } from '../tools/index.js'

/**
 * Browser Pack - 浏览器自动化工具包
 *
 * Prerequisites:
 * - npm install -g agent-browser
 * - agent-browser install
 */
export function browserPack(): Pack {
  return definePack({
    id: 'browser',
    description: '浏览器自动化工具包：browser, browse',

    tools: [
      browser as any,
      browse as any
    ],

    policies: [],

    promptFragment: `
## 浏览器自动化

### 前置条件
需要安装 agent-browser:
\`\`\`bash
npm install -g agent-browser
agent-browser install
\`\`\`

### 可用工具

#### browser - 底层浏览器控制
精细控制浏览器的工具，支持以下操作：
- **open**: 打开 URL
- **snapshot**: 获取页面元素（返回 @e1, @e2 等引用）
- **click**: 点击元素
- **fill**: 填充输入框
- **type**: 键入文本
- **press**: 按键（Enter, Tab, Escape 等）
- **scroll**: 滚动页面
- **screenshot**: 截图
- **getText/getHtml/getValue**: 提取内容
- **eval**: 执行 JavaScript
- **wait**: 等待元素或条件
- **close**: 关闭浏览器

**工作流程**:
1. 使用 action='open' 打开页面
2. 使用 action='snapshot' 获取可交互元素列表
3. 使用 action='click' 和 selector='@e1' 交互
4. 页面变化后重新 snapshot

#### browse - 简化的网页抓取
一站式网页内容提取：
- 自动打开页面
- 提取文本、链接
- 获取交互元素
- 可选截图

### 使用示例

**提取网页内容**:
\`\`\`
browse({ url: "https://example.com", extract: "all" })
\`\`\`

**填写表单**:
\`\`\`
browser({ action: "open", url: "https://example.com/login" })
browser({ action: "snapshot" })
browser({ action: "fill", selector: "@e1", text: "username" })
browser({ action: "fill", selector: "@e2", text: "password" })
browser({ action: "click", selector: "@e3" })
\`\`\`

### 注意事项
1. 每次页面变化后需要重新 snapshot
2. 使用 @e1, @e2 等引用比 CSS 选择器更可靠
3. 处理登录时考虑使用 session 参数隔离实例
4. 复杂操作后建议截图确认结果
    `.trim()
  })
}
