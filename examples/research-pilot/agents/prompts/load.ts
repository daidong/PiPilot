import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function loadPrompt(name: string): string {
  return readFileSync(resolve(__dirname, `${name}.md`), 'utf-8')
}
