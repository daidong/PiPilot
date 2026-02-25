import readline from 'node:readline'
import { resolve } from 'node:path'
import {
  createAgent,
  fileStore,
  fsPlugin,
  execPlugin,
  memoryPlugin,
  reviewPlugin
} from '../../src/index.js'

async function main(): Promise<void> {
  const projectPath = resolve(process.argv[2] ?? process.cwd())
  const workspacePath = resolve(projectPath, '.agentfoundry', 'thin-core-workspace')

  const agent = createAgent({
    provider: 'openai',
    model: 'gpt-5.2',
    projectPath,
    store: fileStore(workspacePath),
    plugins: [fsPlugin(), execPlugin(), memoryPlugin(), reviewPlugin()],
    onStream: chunk => process.stdout.write(chunk)
  })

  await agent.ensureInit()

  process.stdout.write('\nThin Core REPL started.\n')
  process.stdout.write('Commands:\n')
  process.stdout.write('  /install <path>\n')
  process.stdout.write('  /reload <id>\n')
  process.stdout.write('  /test <path_or_id>\n')
  process.stdout.write('  /invoke <id> <tool> <jsonArgs?>\n')
  process.stdout.write('  /quit\n\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'thin> '
  })

  rl.prompt()

  rl.on('line', async (line: string) => {
    const text = line.trim()
    if (!text) {
      rl.prompt()
      return
    }

    if (text === '/quit' || text === '/exit') {
      await agent.destroy()
      rl.close()
      return
    }

    try {
      if (text.startsWith('/install ')) {
        const path = text.slice('/install '.length).trim()
        const result = await agent.installPlugin(path)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        rl.prompt()
        return
      }

      if (text.startsWith('/reload ')) {
        const id = text.slice('/reload '.length).trim()
        const result = await agent.reloadPlugin(id)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        rl.prompt()
        return
      }

      if (text.startsWith('/test ')) {
        const value = text.slice('/test '.length).trim()
        const maybePath = value.includes('/') || value.includes('\\') || value.startsWith('.')
        const result = await agent.testPlugin(maybePath ? { path: value } : { id: value })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        rl.prompt()
        return
      }

      if (text.startsWith('/invoke ')) {
        const rest = text.slice('/invoke '.length).trim()
        const [id, tool, ...argsParts] = rest.split(' ')
        const argsRaw = argsParts.join(' ').trim()
        const args = argsRaw ? JSON.parse(argsRaw) : {}
        const result = await agent.invokePlugin({ id, tool, args })
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        rl.prompt()
        return
      }

      process.stdout.write('assistant> ')
      const result = await agent.run(text)
      if (!result.output.endsWith('\n')) {
        process.stdout.write('\n')
      }
      rl.prompt()
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      rl.prompt()
    }
  })

  rl.on('close', async () => {
    await agent.destroy()
    process.stdout.write('bye\n')
    process.exit(0)
  })
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
