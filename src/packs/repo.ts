/**
 * repo - 仓库探索包
 */

import { definePack } from '../factories/define-pack.js'
import type { Pack } from '../types/pack.js'
import { repoIndex, repoSearch, repoSymbols, repoFile, repoGit } from '../context-sources/index.js'

/**
 * 仓库 Pack - 包含仓库探索相关的上下文源
 */
export function repo(): Pack {
  return definePack({
    id: 'repo',
    description: '仓库探索包：repo.index, repo.search, repo.symbols, repo.file, repo.git',

    contextSources: [
      repoIndex as any,
      repoSearch as any,
      repoSymbols as any,
      repoFile as any,
      repoGit as any
    ],

    promptFragment: `
## 仓库探索

使用 \`ctx.get\` 获取仓库信息：

### 可用上下文源

1. **repo.index** - 获取项目目录结构
   \`\`\`
   ctx.get("repo.index", { path: "src", depth: 2 })
   \`\`\`

2. **repo.search** - 搜索代码内容
   \`\`\`
   ctx.get("repo.search", { pattern: "function.*handler", type: "ts" })
   \`\`\`

3. **repo.symbols** - 获取代码符号（函数、类等）
   \`\`\`
   ctx.get("repo.symbols", { type: "function", pattern: "handle" })
   \`\`\`

4. **repo.file** - 读取文件（带行号）
   \`\`\`
   ctx.get("repo.file", { path: "src/index.ts", limit: 100 })
   \`\`\`

5. **repo.git** - 获取 Git 状态
   \`\`\`
   ctx.get("repo.git", { includeLog: true })
   \`\`\`

### 探索策略
1. 先用 repo.index 了解项目结构
2. 用 repo.search 找到相关代码
3. 用 repo.file 阅读具体实现
4. 用 repo.symbols 查找函数/类定义
    `.trim()
  })
}
