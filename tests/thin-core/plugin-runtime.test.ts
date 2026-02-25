import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  InMemoryStateStore,
  HookBus,
  ToolRunner,
  PluginRegistry,
  memoryPlugin
} from '../../src/thin-core/index.js'

const tempDirs: string[] = []

async function createPlugin(projectPath: string, id: string, manifest: Record<string, unknown>, indexCode: string): Promise<string> {
  const dir = join(projectPath, 'plugins', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, 'index.ts'), indexCode, 'utf8')
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('thin-core plugin runtime', () => {
  it('installs plugin as pending and activates on next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-foundry-thin-'))
    tempDirs.push(root)

    const store = new InMemoryStateStore()
    const registry = new PluginRegistry({
      projectPath: root,
      store,
      hookBus: new HookBus(),
      toolRunner: new ToolRunner()
    })

    await registry.registerStatic(memoryPlugin())

    await createPlugin(
      root,
      'echo-plugin',
      {
        id: 'echo-plugin',
        version: '0.1.0',
        capabilities: ['memory'],
        permissions: {
          memory: {},
          limits: {
            timeoutMs: 10_000,
            maxConcurrentOps: 2,
            maxMemoryMb: 64
          }
        }
      },
      `export async function register(api) {
  api.tool({
    name: 'echo-plugin.echo',
    description: 'Echo text',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  }, async (args) => ({ ok: true, content: String(args.text) }));
}
`
    )

    const installed = await registry.installFromPath(join(root, 'plugins', 'echo-plugin'))
    expect(installed.status).toBe('pending_activation')

    const before = registry.getToolSchemas().map(tool => tool.name)
    expect(before).not.toContain('echo-plugin.echo')

    await registry.activatePending()

    const after = registry.getToolSchemas().map(tool => tool.name)
    expect(after).toContain('echo-plugin.echo')

    const result = await registry.executeTool('echo-plugin.echo', { text: 'hello plugin' }, {
      runId: 'test-run',
      step: 1,
      projectPath: root,
      store,
      emit: async () => undefined
    })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('hello plugin')

    await registry.destroy()
  })

  it('blocks unauthorized host fs ops inside sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-foundry-thin-'))
    tempDirs.push(root)

    const store = new InMemoryStateStore()
    const registry = new PluginRegistry({
      projectPath: root,
      store,
      hookBus: new HookBus(),
      toolRunner: new ToolRunner()
    })

    await createPlugin(
      root,
      'denied-fs-plugin',
      {
        id: 'denied-fs-plugin',
        version: '0.1.0',
        capabilities: ['fs'],
        permissions: {
          limits: {
            timeoutMs: 10_000,
            maxConcurrentOps: 2,
            maxMemoryMb: 64
          }
        }
      },
      `export async function register(api) {
  api.tool({
    name: 'denied-fs-plugin.try-read',
    description: 'Try read file via host op',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }, async () => {
    const data = await api.ops.fs.read('README.md');
    return { ok: true, content: data.content };
  });
}
`
    )

    await registry.installFromPath(join(root, 'plugins', 'denied-fs-plugin'))
    await registry.activatePending()

    const result = await registry.executeTool('denied-fs-plugin.try-read', {}, {
      runId: 'test-run',
      step: 1,
      projectPath: root,
      store,
      emit: async () => undefined
    })

    expect(result.ok).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.content.toLowerCase()).toContain('denied')

    await registry.destroy()
  })
})
