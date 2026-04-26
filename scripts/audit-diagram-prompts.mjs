#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SUSPECT_TERMS = [
  'dataset', 'datasets', 'training data', 'test set', 'validation set',
  'experiment', 'experiments', 'experimental setup', 'hyperparameter', 'hyperparameters',
  'accuracy', 'precision', 'recall', 'F1', 'AUC', 'PSNR', 'BLEU', 'ROUGE',
  'ablation', 'ablations',
  'baseline', 'baselines', 'SOTA', 'state-of-the-art', 'benchmark',
  'GPU', 'A100', 'V100', 'epochs', 'batch size', 'learning rate',
  'Table 1', 'Table 2', 'Figure 1', 'Figure 2',
  'outperforms', 'achieves', '%',
]

function findLogs(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(p)
      } else if (e.isFile() && e.name.endsWith('_review_log.json')) {
        out.push(p)
      }
    }
  }
  walk(root)
  return out
}

const root = resolve(process.argv[2] || process.cwd())
const logs = findLogs(root).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

if (logs.length === 0) {
  console.error(`No *_review_log.json under ${root}`)
  process.exit(1)
}

console.log(`# Prompt audit — ${logs.length} log file(s) under ${root}\n`)

for (const file of logs) {
  let data
  try { data = JSON.parse(readFileSync(file, 'utf-8')) } catch (e) {
    console.log(`## ${file}\nPARSE ERROR: ${e.message}\n`); continue
  }
  const prompt = String(data.prompt ?? '')
  const len = prompt.length
  const wordCount = prompt.split(/\s+/).filter(Boolean).length
  const lower = prompt.toLowerCase()
  const hits = SUSPECT_TERMS.filter(t => {
    const re = new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`)
    return re.test(lower)
  })
  const finalScore = data.iterations?.at(-1)?.review?.score ?? '—'
  const verdict = data.iterations?.at(-1)?.review?.verdict ?? '—'

  console.log(`## ${file.replace(root + '/', '')}`)
  console.log(`- length: ${len} chars / ${wordCount} words`)
  console.log(`- docType: ${data.docType} | diagramType: ${data.diagramType} | aspect: ${data.aspect}`)
  console.log(`- final: score=${finalScore} verdict=${verdict} stoppedReason=${data.stoppedReason ?? '—'}`)
  console.log(`- suspect terms (${hits.length}): ${hits.length ? hits.join(', ') : '—'}`)
  console.log(`\n### prompt verbatim\n\n\`\`\`\n${prompt}\n\`\`\`\n`)
}
