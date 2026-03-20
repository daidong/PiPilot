/**
 * AgentFoundry — Operations DI 示例
 *
 * 展示 #4 Operations Interface DI：如何让不同工具使用不同的 IO 后端。
 *
 * 场景：一个 DevOps agent 同时操作本地和远程服务器。
 * - `read`/`write`/`glob` 等内置工具 → 本地文件系统（默认）
 * - `remote-exec` 工具 → 模拟 SSH 远程执行
 * - `remote-read` 工具 → 模拟从远程读取文件，但结果写到本地
 *
 * 用法:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx with-operations-di.ts
 */

import { createAgent, defineTool, definePack, packs } from '../../src/index.js'
import type { RuntimeIO } from '../../src/types/runtime.js'

// ---------------------------------------------------------------------------
// 1. 模拟 SSH IO 后端（真实场景中这里会用 ssh2 库连接远程服务器）
// ---------------------------------------------------------------------------

function createSSHIO(host: string): RuntimeIO {
  const tag = `[SSH:${host}]`

  return {
    async readFile(path) {
      console.log(`  ${tag} readFile(${path})`)
      // 模拟从远程读取
      return {
        success: true,
        data: `# Remote content from ${host}:${path}\nserver_name=${host}\nstatus=running\nuptime=42d`,
        traceId: `ssh-read-${Date.now()}`
      }
    },

    async writeFile(path, content) {
      console.log(`  ${tag} writeFile(${path}, ${content.length} bytes)`)
      return { success: true, traceId: `ssh-write-${Date.now()}` }
    },

    async exec(command, options) {
      console.log(`  ${tag} exec(${command})`)
      // 模拟远程命令执行
      const simulated: Record<string, string> = {
        'uptime': ' 14:23:01 up 42 days, 3:15, 2 users, load average: 0.15, 0.10, 0.05',
        'df -h': 'Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1   100G   45G   55G  45% /',
        'docker ps': 'CONTAINER ID  IMAGE         STATUS      NAMES\nabc123        nginx:latest  Up 2 days   web-prod',
      }
      const stdout = simulated[command] ?? `${host}$ ${command}\n(command executed successfully)`
      return {
        success: true,
        data: { stdout, stderr: '', exitCode: 0 },
        traceId: `ssh-exec-${Date.now()}`
      }
    },

    async readdir(path) {
      console.log(`  ${tag} readdir(${path})`)
      return {
        success: true,
        data: [
          { name: 'app.conf', isFile: true, isDirectory: false },
          { name: 'logs', isFile: false, isDirectory: true },
        ],
        traceId: `ssh-readdir-${Date.now()}`
      }
    },

    async exists(path) {
      return { success: true, data: true, traceId: `ssh-exists-${Date.now()}` }
    },

    async glob(pattern) {
      console.log(`  ${tag} glob(${pattern})`)
      return { success: true, data: ['/etc/nginx/nginx.conf', '/etc/nginx/sites-enabled/default'], traceId: `ssh-glob-${Date.now()}` }
    },

    async grep(pattern) {
      return { success: true, data: [], traceId: `ssh-grep-${Date.now()}` }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 定义使用远程 IO 的工具
// ---------------------------------------------------------------------------

/** 在远程服务器上执行命令 */
const remoteExecTool = defineTool({
  name: 'remote-exec',
  description: 'Execute a command on the remote production server via SSH. Use this for server health checks, deployments, and remote operations.',
  parameters: {
    command: { type: 'string', description: 'Shell command to execute on remote server', required: true }
  },
  execute: async (input, context) => {
    const result = await context.runtime.io.exec(input.command as string)
    if (!result.success) {
      return { success: false, error: result.error }
    }
    return { success: true, data: result.data!.stdout }
  },
  // 关键：这个工具的 IO 指向远程服务器
  createIO: (_defaultIO, _runtime) => createSSHIO('prod-server-01')
})

/** 从远程读取配置文件 */
const remoteReadTool = defineTool({
  name: 'remote-read',
  description: 'Read a file from the remote production server. Returns the file content.',
  parameters: {
    path: { type: 'string', description: 'File path on remote server', required: true }
  },
  execute: async (input, context) => {
    const result = await context.runtime.io.readFile(input.path as string)
    if (!result.success) {
      return { success: false, error: result.error }
    }
    return { success: true, data: result.data }
  },
  createIO: (_defaultIO, _runtime) => createSSHIO('prod-server-01')
})

/** 混合工具：从远程读取，写到本地 */
const syncConfigTool = defineTool({
  name: 'sync-config',
  description: 'Sync a config file from remote server to local. Reads from remote and writes to local ./synced/ directory.',
  parameters: {
    remotePath: { type: 'string', description: 'Config file path on remote server', required: true }
  },
  execute: async (input, context) => {
    // context.runtime.io 已经被 createIO 组合好了：
    // readFile → 远程, writeFile → 本地
    const readResult = await context.runtime.io.readFile(input.remotePath as string)
    if (!readResult.success) {
      return { success: false, error: `Failed to read remote: ${readResult.error}` }
    }

    const localPath = `./synced/${(input.remotePath as string).split('/').pop()}`
    // 这里 writeFile 会走本地 IO（因为 createIO 只替换了 readFile 和 exec）
    // 注意：在这个示例中本地写入也是模拟的，不会真的写文件
    console.log(`  [local] would write to ${localPath}`)

    return {
      success: true,
      data: `Synced ${input.remotePath} → ${localPath}\nContent: ${readResult.data?.substring(0, 50)}...`
    }
  },
  // 混合 IO：读取走远程 SSH，写入走本地默认
  createIO: (defaultIO, _runtime) => {
    const remoteIO = createSSHIO('prod-server-01')
    return {
      ...defaultIO,             // 大部分操作走本地（写入、glob、grep...）
      readFile: remoteIO.readFile,  // 读取走远程
      exec: remoteIO.exec           // 执行也走远程
    } as RuntimeIO
  }
})

// ---------------------------------------------------------------------------
// 3. 打包 & 创建 Agent
// ---------------------------------------------------------------------------

const devopsPack = definePack({
  id: 'devops-remote',
  description: 'Remote server operations via SSH',
  tools: [remoteExecTool, remoteReadTool, syncConfigTool]
})

async function main() {
  const agent = createAgent({
    projectPath: process.cwd(),
    skipConfigFile: true,
    packs: [packs.safe(), devopsPack],
    identity: `You are a DevOps assistant. You have access to both local files and a remote production server.
Use remote-exec to run commands on the server, remote-read to read server files, and sync-config to pull configs locally.
For local file operations, use the standard read/write/glob tools.`,
    constraints: ['Be concise.', 'Always explain which environment (local vs remote) you are operating on.'],
    trace: { export: { enabled: false } }
  })

  const prompt = process.argv[2]
    || 'Check the uptime of the production server and read the server config at /etc/app.conf'

  console.log(`\n> ${prompt}\n`)
  console.log('--- IO operations will be logged below ---\n')

  const result = await agent.run(prompt)

  console.log('\n--- Agent Response ---')
  console.log(result.response)
  console.log(`\n--- ${result.steps} steps, ${result.tokensUsed} tokens ---`)
}

main().catch(console.error)
