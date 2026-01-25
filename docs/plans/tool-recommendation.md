# Tool Recommendation System 设计方案

## 目标

当用户创建 agent 但未指定工具时，根据 agent 描述自动推荐合适的工具。

## 核心原则

1. **推荐而非自动启用** - 用户有最终决定权
2. **安全优先** - 高风险工具需要显式确认
3. **可解释** - 每个推荐都有理由
4. **可缓存** - 相似描述复用推荐结果

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    Tool Recommendation                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  AgentDescription ──► ToolRecommender ──► RecommendedTools  │
│                            │                                 │
│                     ┌──────┴──────┐                         │
│                     │             │                         │
│              ToolCatalog    MCPRegistry                     │
│                     │             │                         │
│              ┌──────┴──────┬──────┴──────┐                 │
│              │             │             │                  │
│         BuiltinTools  DomainPacks   MCPServers             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Tool Catalog（工具目录）

### 1.1 定义工具元数据结构

```typescript
interface ToolCatalogEntry {
  // 基本信息
  name: string
  category: 'safe' | 'exec' | 'network' | 'compute' | 'browser' | 'domain'

  // 推荐相关
  description: string           // 给 LLM 看的详细描述
  useCases: string[]           // 使用场景列表
  keywords: string[]           // 关键词（用于快速匹配）

  // 风险评估
  riskLevel: 'safe' | 'elevated' | 'high'
  requiresExplicitApproval: boolean

  // 依赖
  providedBy: string           // pack 名称
  dependencies?: string[]      // 依赖的其他工具

  // 示例
  exampleUsage?: string
}
```

### 1.2 内置工具目录

```typescript
const builtinToolCatalog: ToolCatalogEntry[] = [
  // === Safe Tools ===
  {
    name: 'read',
    category: 'safe',
    description: 'Read file contents with pagination support',
    useCases: [
      'Reading source code files',
      'Viewing configuration files',
      'Analyzing log files'
    ],
    keywords: ['file', 'read', 'content', 'source', 'code'],
    riskLevel: 'safe',
    requiresExplicitApproval: false,
    providedBy: 'safe'
  },

  {
    name: 'llm-expand',
    category: 'compute',
    description: 'Expand text into multiple variations using LLM',
    useCases: [
      'Search query expansion',
      'Synonym generation',
      'Multi-perspective rephrasing'
    ],
    keywords: ['expand', 'query', 'synonym', 'rephrase', 'variation'],
    riskLevel: 'elevated',
    requiresExplicitApproval: false,
    providedBy: 'compute'
  },

  {
    name: 'llm-filter',
    category: 'compute',
    description: 'Filter items by relevance using LLM scoring',
    useCases: [
      'Search result filtering',
      'Content relevance ranking',
      'Quality assessment'
    ],
    keywords: ['filter', 'relevance', 'score', 'rank', 'quality'],
    riskLevel: 'elevated',
    requiresExplicitApproval: false,
    providedBy: 'compute'
  },

  {
    name: 'fetch',
    category: 'network',
    description: 'Make HTTP requests to external APIs',
    useCases: [
      'Calling REST APIs',
      'Fetching web content',
      'Downloading files'
    ],
    keywords: ['http', 'api', 'request', 'web', 'download', 'fetch'],
    riskLevel: 'elevated',
    requiresExplicitApproval: true,
    providedBy: 'network'
  },

  {
    name: 'bash',
    category: 'exec',
    description: 'Execute shell commands',
    useCases: [
      'Running build scripts',
      'System administration',
      'Process management'
    ],
    keywords: ['shell', 'command', 'terminal', 'script', 'execute'],
    riskLevel: 'high',
    requiresExplicitApproval: true,
    providedBy: 'exec'
  },

  // ... more tools
]
```

### 1.3 MCP 服务器目录

```typescript
interface MCPServerEntry {
  name: string
  description: string
  useCases: string[]
  keywords: string[]

  // 配置模板
  configTemplate: MCPServerConfig

  // 安装说明
  installCommand?: string
  documentation?: string
}

const mcpServerCatalog: MCPServerEntry[] = [
  {
    name: 'filesystem',
    description: 'Advanced file system operations',
    useCases: [
      'Complex file operations',
      'Directory traversal',
      'File watching'
    ],
    keywords: ['file', 'directory', 'filesystem', 'watch'],
    configTemplate: {
      name: 'filesystem',
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/mcp-filesystem'] }
    }
  },

  {
    name: 'github',
    description: 'GitHub API integration',
    useCases: [
      'Managing repositories',
      'Creating issues/PRs',
      'Code review automation'
    ],
    keywords: ['github', 'git', 'repository', 'pr', 'issue'],
    configTemplate: {
      name: 'github',
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/mcp-github'] }
    },
    installCommand: 'npx -y @anthropic/mcp-github'
  },

  {
    name: 'postgres',
    description: 'PostgreSQL database operations',
    useCases: [
      'Database queries',
      'Schema management',
      'Data analysis'
    ],
    keywords: ['database', 'sql', 'postgres', 'query', 'data'],
    configTemplate: {
      name: 'postgres',
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/mcp-postgres'] }
    }
  }
]
```

## Phase 2: Tool Recommender（工具推荐器）

### 2.1 推荐器接口

```typescript
interface ToolRecommendation {
  tool: string
  reason: string
  confidence: number  // 0-1
  riskLevel: 'safe' | 'elevated' | 'high'
  providedBy: string
}

interface MCPRecommendation {
  server: string
  reason: string
  confidence: number
  configTemplate: MCPServerConfig
  installCommand?: string
}

interface RecommendationResult {
  tools: ToolRecommendation[]
  mcpServers: MCPRecommendation[]
  suggestedPacks: string[]
  warnings: string[]
}

interface ToolRecommenderConfig {
  maxRecommendations?: number        // 默认 10
  minConfidence?: number             // 默认 0.6
  includeHighRisk?: boolean          // 默认 false
  includeMCP?: boolean               // 默认 true
}

class ToolRecommender {
  constructor(
    private catalog: ToolCatalogEntry[],
    private mcpCatalog: MCPServerEntry[],
    private llmClient: LLMClient
  )

  async recommend(
    agentDescription: string,
    config?: ToolRecommenderConfig
  ): Promise<RecommendationResult>
}
```

### 2.2 推荐算法

```typescript
async recommend(description: string, config: ToolRecommenderConfig): Promise<RecommendationResult> {
  // Step 1: 快速关键词匹配（无 LLM 调用）
  const keywordMatches = this.quickMatch(description)

  // Step 2: LLM 深度分析（如果关键词匹配不足）
  if (keywordMatches.length < 3) {
    return this.llmRecommend(description, config)
  }

  // Step 3: 合并结果
  return this.mergeRecommendations(keywordMatches, config)
}

private quickMatch(description: string): ToolCatalogEntry[] {
  const words = description.toLowerCase().split(/\s+/)

  return this.catalog.filter(tool =>
    tool.keywords.some(keyword =>
      words.some(word => word.includes(keyword) || keyword.includes(word))
    )
  )
}

private async llmRecommend(description: string, config: ToolRecommenderConfig): Promise<RecommendationResult> {
  const prompt = `
Analyze this agent description and recommend appropriate tools.

Agent Description:
${description}

Available Tools:
${this.formatCatalog()}

Available MCP Servers:
${this.formatMCPCatalog()}

For each recommendation, provide:
1. Tool/server name
2. Why it's needed (specific to the agent's purpose)
3. Confidence score (0-1)

Return JSON:
{
  "tools": [
    {"name": "tool_name", "reason": "why needed", "confidence": 0.8}
  ],
  "mcpServers": [
    {"name": "server_name", "reason": "why needed", "confidence": 0.7}
  ],
  "warnings": ["any security or usage concerns"]
}
`

  const result = await this.llmClient.generate({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1000,
    jsonMode: true
  })

  return this.parseRecommendations(result.text, config)
}
```

## Phase 3: Integration（集成）

### 3.1 修改 defineAgent

```typescript
interface AgentDefinition {
  // 现有字段...

  // 新增：工具推荐相关
  autoRecommendTools?: boolean        // 默认 true（如果未指定 packs/tools）
  recommendationConfig?: ToolRecommenderConfig
}

// 修改 defineAgent 工厂函数
export function defineAgent(definition: AgentDefinition) {
  return async (config: AgentConfig): Promise<Agent> => {
    let packs = definition.packs || []

    // 如果没有指定工具，触发推荐
    if (packs.length === 0 && definition.autoRecommendTools !== false) {
      const recommender = new ToolRecommender(/*...*/)
      const recommendations = await recommender.recommend(
        definition.identity + '\n' + definition.constraints?.join('\n'),
        definition.recommendationConfig
      )

      // 显示推荐并等待确认
      const confirmed = await confirmRecommendations(recommendations, config)
      packs = confirmed.packs
    }

    // 继续现有逻辑...
  }
}
```

### 3.2 推荐确认 UI

```typescript
async function confirmRecommendations(
  recommendations: RecommendationResult,
  config: AgentConfig
): Promise<{ packs: Pack[] }> {
  // CLI 模式
  if (config.interactive !== false) {
    console.log('\n📦 Recommended Tools:\n')

    for (const rec of recommendations.tools) {
      const riskBadge = rec.riskLevel === 'high' ? '⚠️' :
                        rec.riskLevel === 'elevated' ? '⚡' : '✅'
      console.log(`${riskBadge} ${rec.tool} (${Math.round(rec.confidence * 100)}%)`)
      console.log(`   ${rec.reason}`)
      console.log(`   Provided by: ${rec.providedBy}`)
    }

    if (recommendations.mcpServers.length > 0) {
      console.log('\n🔌 Recommended MCP Servers:\n')
      for (const rec of recommendations.mcpServers) {
        console.log(`  ${rec.server} (${Math.round(rec.confidence * 100)}%)`)
        console.log(`   ${rec.reason}`)
        if (rec.installCommand) {
          console.log(`   Install: ${rec.installCommand}`)
        }
      }
    }

    if (recommendations.warnings.length > 0) {
      console.log('\n⚠️ Warnings:')
      recommendations.warnings.forEach(w => console.log(`   ${w}`))
    }

    // 等待用户确认
    const confirmed = await promptConfirmation('Use these recommendations?')

    if (confirmed) {
      return buildPacksFromRecommendations(recommendations)
    }
  }

  // 非交互模式：使用最小安全配置
  return { packs: [packs.safe()] }
}
```

## Phase 4: 文件结构

```
src/
├── recommendation/
│   ├── index.ts                 # 导出
│   ├── tool-catalog.ts          # 内置工具目录
│   ├── mcp-catalog.ts           # MCP 服务器目录
│   ├── tool-recommender.ts      # 推荐器核心逻辑
│   └── confirmation-ui.ts       # 确认交互
```

## 实现优先级

### P0 - 核心功能
1. [ ] 定义 ToolCatalogEntry 类型
2. [ ] 创建内置工具目录（所有现有工具）
3. [ ] 实现关键词快速匹配
4. [ ] 实现 LLM 推荐逻辑
5. [ ] 集成到 defineAgent

### P1 - MCP 支持
6. [ ] 定义 MCPServerEntry 类型
7. [ ] 创建常用 MCP 服务器目录
8. [ ] MCP 推荐逻辑

### P2 - 用户体验
9. [ ] CLI 确认交互
10. [ ] 推荐缓存
11. [ ] 推荐历史记录

### P3 - 高级功能
12. [ ] 自定义工具目录
13. [ ] 基于项目类型的推荐
14. [ ] 推荐反馈学习

## API 示例

```typescript
// 用户代码 - 不指定任何工具
const myAgent = defineAgent({
  id: 'research-agent',
  name: 'Research Agent',
  identity: `You are a research assistant that helps users find and analyze
  academic papers, summarize findings, and track research progress.`
})

// 创建时自动触发推荐
const agent = await myAgent({ apiKey: '...' })

// 输出：
// 📦 Recommended Tools:
//
// ✅ read (95%)
//    Reading source files for research materials
//    Provided by: safe
//
// ⚡ llm-expand (88%)
//    Expanding search queries for better coverage
//    Provided by: compute
//
// ⚡ llm-filter (85%)
//    Filtering search results by relevance
//    Provided by: compute
//
// ⚡ fetch (82%)
//    Fetching papers from academic APIs
//    Provided by: network
//
// 🔌 Recommended MCP Servers:
//
//   arxiv (75%)
//    Searching and downloading arXiv papers
//    Install: npx -y @mcp/arxiv
//
// Use these recommendations? (Y/n)
```

## 安全考虑

1. **高风险工具默认不推荐** - bash、完整 network 需要显式请求
2. **MCP 需要用户确认** - 外部服务器不自动启用
3. **推荐解释透明** - 用户知道为什么推荐
4. **最小权限原则** - 只推荐必要的工具
