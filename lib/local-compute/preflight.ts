/**
 * Preflight Assessment — fast checks BEFORE spawning any process.
 *
 * Shifts from reactive recovery to proactive prevention.
 * All checks are deterministic, no LLM calls. Each completes in < 5 seconds.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string
  status: 'passed' | 'warning' | 'failed'
  message: string
  durationMs: number
}

export interface PreflightResult {
  passed: boolean
  checks: PreflightCheck[]
  blockingIssues: string[]
  warnings: string[]
}

export interface PreflightOptions {
  command: string
  scriptPath?: string          // Absolute path to the main script
  workDir: string              // Absolute working directory
  pythonPath?: string          // Default: 'python3'
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkSyntax(
  scriptPath: string,
  pythonPath: string,
): Promise<PreflightCheck> {
  const start = Date.now()
  if (!scriptPath.endsWith('.py')) {
    return { name: 'syntax', status: 'passed', message: 'Not a Python script — skipped.', durationMs: Date.now() - start }
  }
  if (!fs.existsSync(scriptPath)) {
    return { name: 'syntax', status: 'failed', message: `Script not found: ${scriptPath}`, durationMs: Date.now() - start }
  }
  try {
    await execFileAsync(pythonPath, ['-m', 'py_compile', scriptPath], { timeout: 10_000 })
    return { name: 'syntax', status: 'passed', message: 'Python syntax OK.', durationMs: Date.now() - start }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Extract the actual syntax error from stderr
    const syntaxLine = msg.split('\n').find(l => /SyntaxError|IndentationError|TabError/i.test(l)) ?? msg.slice(0, 200)
    return { name: 'syntax', status: 'failed', message: `Syntax error: ${syntaxLine}`, durationMs: Date.now() - start }
  }
}

async function checkImports(
  scriptPath: string,
  pythonPath: string,
): Promise<PreflightCheck> {
  const start = Date.now()
  if (!scriptPath.endsWith('.py') || !fs.existsSync(scriptPath)) {
    return { name: 'imports', status: 'passed', message: 'Skipped.', durationMs: Date.now() - start }
  }

  // Parse top-level imports from the script
  const content = fs.readFileSync(scriptPath, 'utf-8')
  const imports = new Set<string>()
  for (const match of content.matchAll(/^\s*(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm)) {
    const mod = match[1]
    // Skip stdlib modules (best-effort list of common ones)
    if (STDLIB_MODULES.has(mod)) continue
    imports.add(mod)
  }

  if (imports.size === 0) {
    return { name: 'imports', status: 'passed', message: 'No third-party imports detected.', durationMs: Date.now() - start }
  }

  // Batch import test — single Python process instead of N sequential ones
  const importList = Array.from(imports)
  const testScript = importList.map(mod => `try:\n import ${mod}\nexcept ImportError:\n print("MISSING:" + "${mod}")`).join('\n')
  const missing: string[] = []
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', testScript], { timeout: 30_000 })
    for (const line of stdout.split('\n')) {
      if (line.startsWith('MISSING:')) missing.push(line.slice(8))
    }
  } catch {
    // If the batch test itself fails, fall back to reporting all as unknown
    return { name: 'imports', status: 'warning', message: `Could not verify imports: ${importList.join(', ')}`, durationMs: Date.now() - start }
  }

  if (missing.length === 0) {
    return { name: 'imports', status: 'passed', message: `All ${imports.size} imports available.`, durationMs: Date.now() - start }
  }
  return {
    name: 'imports',
    status: 'failed',
    message: `Missing modules: ${missing.join(', ')}. Add to requirements.txt or pip install.`,
    durationMs: Date.now() - start,
  }
}

function checkDataPaths(command: string, workDir: string): PreflightCheck {
  const start = Date.now()
  // Extract file paths from the command (quoted or unquoted, common data extensions)
  const pathPattern = /(?:["']([^"']+\.(?:csv|tsv|json|jsonl|xlsx|xls|parquet|feather|h5|hdf5|npy|npz|pkl|pickle|txt|dat))["']|(\S+\.(?:csv|tsv|json|jsonl|xlsx|xls|parquet|feather|h5|hdf5|npy|npz|pkl|pickle)))/gi
  const refs: string[] = []
  for (const m of command.matchAll(pathPattern)) {
    refs.push(m[1] ?? m[2])
  }

  if (refs.length === 0) {
    return { name: 'data_paths', status: 'passed', message: 'No data file references detected in command.', durationMs: Date.now() - start }
  }

  const missing: string[] = []
  for (const ref of refs) {
    const abs = path.isAbsolute(ref) ? ref : path.resolve(workDir, ref)
    if (!fs.existsSync(abs)) missing.push(ref)
  }

  if (missing.length === 0) {
    return { name: 'data_paths', status: 'passed', message: `All ${refs.length} data files found.`, durationMs: Date.now() - start }
  }
  return {
    name: 'data_paths',
    status: 'failed',
    message: `Data files not found: ${missing.join(', ')}`,
    durationMs: Date.now() - start,
  }
}

function checkDiskSpace(workDir: string): PreflightCheck {
  const start = Date.now()
  try {
    const output = execSync('df -m .', { cwd: workDir, encoding: 'utf-8', timeout: 3000 })
    const lines = output.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/)
      const availMb = parseInt(parts[3], 10)
      if (!isNaN(availMb)) {
        if (availMb < 500) {
          return { name: 'disk_space', status: 'failed', message: `Only ${availMb}MB free disk space. Need at least 500MB.`, durationMs: Date.now() - start }
        }
        if (availMb < 2000) {
          return { name: 'disk_space', status: 'warning', message: `${availMb}MB free disk space. May be tight for large outputs.`, durationMs: Date.now() - start }
        }
        return { name: 'disk_space', status: 'passed', message: `${availMb}MB free disk space.`, durationMs: Date.now() - start }
      }
    }
  } catch { /* fall through */ }
  return { name: 'disk_space', status: 'passed', message: 'Could not detect disk space — proceeding.', durationMs: Date.now() - start }
}

function checkOutputDir(workDir: string): PreflightCheck {
  const start = Date.now()
  try {
    // Test write to working directory
    const testFile = path.join(workDir, '.compute-preflight-test')
    fs.writeFileSync(testFile, 'test')
    fs.unlinkSync(testFile)
    return { name: 'output_dir', status: 'passed', message: 'Working directory is writable.', durationMs: Date.now() - start }
  } catch {
    return { name: 'output_dir', status: 'failed', message: `Working directory is not writable: ${workDir}`, durationMs: Date.now() - start }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run all preflight checks. Returns quickly (< 15s total).
 */
export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const pythonPath = opts.pythonPath ?? 'python3'
  const scriptPath = opts.scriptPath ?? extractScriptPath(opts.command, opts.workDir)

  // Run checks concurrently where possible
  const [syntax, imports, dataPaths, diskSpace, outputDir] = await Promise.all([
    scriptPath ? checkSyntax(scriptPath, pythonPath) : Promise.resolve(null),
    scriptPath ? checkImports(scriptPath, pythonPath) : Promise.resolve(null),
    Promise.resolve(checkDataPaths(opts.command, opts.workDir)),
    Promise.resolve(checkDiskSpace(opts.workDir)),
    Promise.resolve(checkOutputDir(opts.workDir)),
  ])

  const checks = [syntax, imports, dataPaths, diskSpace, outputDir].filter(Boolean) as PreflightCheck[]
  const blockingIssues = checks.filter(c => c.status === 'failed').map(c => c.message)
  const warnings = checks.filter(c => c.status === 'warning').map(c => c.message)

  return {
    passed: blockingIssues.length === 0,
    checks,
    blockingIssues,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract the Python script path from a command string.
 * e.g., "python3 train.py --epochs 10" → "train.py"
 */
function extractScriptPath(command: string, workDir: string): string | undefined {
  const match = command.match(/python3?\s+([^\s]+\.py)/)
  if (!match) return undefined
  const scriptRef = match[1]
  return path.isAbsolute(scriptRef) ? scriptRef : path.resolve(workDir, scriptRef)
}

/** Common Python stdlib module names to skip during import checks. */
const STDLIB_MODULES = new Set([
  'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
  'atexit', 'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
  'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code',
  'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent',
  'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile',
  'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm',
  'decimal', 'difflib', 'dis', 'distutils', 'doctest', 'email', 'encodings',
  'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext',
  'glob', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http',
  'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
  'mimetypes', 'mmap', 'modulefinder', 'multiprocessing', 'netrc', 'nis',
  'nntplib', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev',
  'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform',
  'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats',
  'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri',
  'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy',
  'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
  'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau',
  'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib',
  'tempfile', 'termios', 'test', 'textwrap', 'threading', 'time', 'timeit',
  'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback',
  'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings',
  'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref',
  'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
  // Common aliases / submodules
  'os', 'sys', 'typing', 'collections', '__future__',
])
