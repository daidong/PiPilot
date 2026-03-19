/**
 * Skill Installer — download and manage external skills.
 *
 * Supports installing from:
 * - GitHub repo paths: "owner/repo" or "owner/repo/path/to/skill-dir"
 * - Direct URLs to SKILL.md files or tar.gz archives
 *
 * Skills are installed to `.agentfoundry/skills/<skill-id>/`.
 * A `.source.json` provenance file is written alongside SKILL.md.
 */

import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillInstallResult {
  skillId: string
  skillDir: string
  source: 'github' | 'url'
  isNew: boolean
}

export interface InstalledSkillInfo {
  id: string
  name: string
  shortDescription: string
  dir: string
  source: 'project-local' | 'community-builtin' | 'github' | 'url' | 'unknown'
  sourceRef?: string
}

export interface SkillInstallerOptions {
  /** Root skills directory (e.g. .agentfoundry/skills/) */
  skillsDir: string
  /** Optional progress callback */
  onProgress?: (msg: string) => void
}

interface SourceMeta {
  type: 'github' | 'url'
  ref: string
  installedAt: string
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubContent {
  name: string
  path: string
  type: 'file' | 'dir'
  download_url: string | null
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AgentFoundry-SkillInstaller',
  }
  const token = process.env['GITHUB_TOKEN']
  if (token) {
    headers['Authorization'] = `token ${token}`
  }
  return headers
}

function parseGitHubPath(githubPath: string): { owner: string; repo: string; path: string } {
  const parts = githubPath.split('/')
  if (parts.length < 2) {
    throw new Error(`Invalid GitHub path: "${githubPath}". Expected "owner/repo" or "owner/repo/path".`)
  }
  return {
    owner: parts[0]!,
    repo: parts[1]!,
    path: parts.slice(2).join('/'),
  }
}

// ---------------------------------------------------------------------------
// SkillInstaller
// ---------------------------------------------------------------------------

export class SkillInstaller {
  private readonly skillsDir: string
  private readonly onProgress: (msg: string) => void

  constructor(options: SkillInstallerOptions) {
    this.skillsDir = path.resolve(options.skillsDir)
    this.onProgress = options.onProgress ?? (() => {})
  }

  /**
   * Install a skill from a GitHub repo path.
   *
   * Format: "owner/repo" (root of repo) or "owner/repo/path/to/skill-dir"
   * The target directory must contain a SKILL.md file.
   */
  async installFromGitHub(githubPath: string): Promise<SkillInstallResult> {
    const { owner, repo, path: dirPath } = parseGitHubPath(githubPath)

    this.onProgress(`Fetching skill from github:${githubPath}...`)

    // List directory contents via GitHub API
    const apiUrl = dirPath
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`
      : `https://api.github.com/repos/${owner}/${repo}/contents`

    const response = await fetch(apiUrl, { headers: getGitHubHeaders() })
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`GitHub path not found: ${githubPath}`)
      }
      if (response.status === 403) {
        throw new Error(`GitHub API rate limited. Set GITHUB_TOKEN env var to increase limit.`)
      }
      throw new Error(`GitHub API error ${response.status}: ${await response.text()}`)
    }

    const contents = await response.json() as GitHubContent[]
    if (!Array.isArray(contents)) {
      throw new Error(`GitHub path "${githubPath}" is not a directory`)
    }

    // Verify SKILL.md exists
    const skillMd = contents.find(c => c.name.toUpperCase() === 'SKILL.MD')
    if (!skillMd) {
      throw new Error(`No SKILL.md found in github:${githubPath}`)
    }

    // Derive skill ID from directory name
    const skillId = dirPath ? path.basename(dirPath) : repo
    const skillDir = path.join(this.skillsDir, skillId)
    const isNew = !existsSync(skillDir)

    // Clean and create target directory
    if (!isNew) {
      await fs.rm(skillDir, { recursive: true, force: true })
    }
    await fs.mkdir(skillDir, { recursive: true })

    // Download all files (recursively for scripts/)
    await this.downloadGitHubDir(contents, skillDir, owner, repo)

    // Write provenance
    await this.writeSourceMeta(skillDir, { type: 'github', ref: githubPath, installedAt: new Date().toISOString() })

    this.onProgress(`Installed skill "${skillId}" from github:${githubPath}`)

    return { skillId, skillDir, source: 'github', isNew }
  }

  /**
   * Install a skill from a URL.
   *
   * Supports:
   * - Direct SKILL.md file (Content-Type text/*)
   * - tar.gz archive containing a skill directory
   */
  async installFromURL(url: string, skillIdHint?: string): Promise<SkillInstallResult> {
    this.onProgress(`Fetching skill from ${url}...`)

    const response = await fetch(url, {
      headers: { 'User-Agent': 'AgentFoundry-SkillInstaller' },
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const body = Buffer.from(await response.arrayBuffer())

    // Detect if this is a markdown file or an archive
    if (contentType.includes('text/') || url.endsWith('.md') || url.endsWith('/SKILL.md')) {
      return this.installFromMarkdownContent(body.toString('utf-8'), url, skillIdHint)
    }

    if (contentType.includes('gzip') || contentType.includes('tar') || url.endsWith('.tar.gz') || url.endsWith('.tgz')) {
      return this.installFromTarball(body, url, skillIdHint)
    }

    // Try as markdown by default
    const text = body.toString('utf-8')
    if (text.includes('SKILL.md') || text.trimStart().startsWith('---') || text.includes('## Procedures')) {
      return this.installFromMarkdownContent(text, url, skillIdHint)
    }

    throw new Error(`Unsupported content type "${contentType}" from ${url}. Expected text/markdown or tar.gz.`)
  }

  /**
   * Remove an installed skill by ID.
   */
  async remove(skillId: string): Promise<boolean> {
    const skillDir = path.join(this.skillsDir, skillId)
    if (!existsSync(skillDir)) {
      return false
    }
    await fs.rm(skillDir, { recursive: true, force: true })
    return true
  }

  /**
   * List all installed skills (project-local + community-builtin sources).
   */
  async listInstalled(communityDir?: string): Promise<InstalledSkillInfo[]> {
    const results: InstalledSkillInfo[] = []

    // Project-local skills
    if (existsSync(this.skillsDir)) {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const info = await this.readSkillInfo(path.join(this.skillsDir, entry.name), 'project-local')
        if (info) results.push(info)
      }
    }

    // Community-builtin skills
    if (communityDir && existsSync(communityDir)) {
      const entries = await fs.readdir(communityDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const info = await this.readSkillInfo(path.join(communityDir, entry.name), 'community-builtin')
        if (info) results.push(info)
      }
    }

    return results.sort((a, b) => a.id.localeCompare(b.id))
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async readSkillInfo(
    dir: string,
    defaultSource: 'project-local' | 'community-builtin'
  ): Promise<InstalledSkillInfo | null> {
    const skillMdPath = path.join(dir, 'SKILL.md')
    if (!existsSync(skillMdPath)) return null

    try {
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { id, name, shortDescription } = this.parseFrontmatterQuick(content, path.basename(dir))

      // Read provenance
      let source: InstalledSkillInfo['source'] = defaultSource
      let sourceRef: string | undefined
      const sourceMetaPath = path.join(dir, '.source.json')
      if (existsSync(sourceMetaPath)) {
        try {
          const meta = JSON.parse(await fs.readFile(sourceMetaPath, 'utf-8')) as SourceMeta
          source = meta.type
          sourceRef = meta.ref
        } catch { /* ignore parse errors */ }
      }

      return { id, name, shortDescription, dir, source, sourceRef }
    } catch {
      return null
    }
  }

  /** Fast frontmatter extraction — just id, name, shortDescription. */
  private parseFrontmatterQuick(content: string, fallbackId: string): {
    id: string; name: string; shortDescription: string
  } {
    let id = fallbackId
    let name = fallbackId
    let shortDescription = ''

    // Extract YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = fmMatch[1]!
      const idMatch = fm.match(/^id:\s*["']?([^"'\n]+)["']?\s*$/m)
      if (idMatch) id = idMatch[1]!.trim()
      const nameMatch = fm.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)
      if (nameMatch) name = nameMatch[1]!.trim()
      const descMatch = fm.match(/^shortDescription:\s*["']?([^"'\n]+)["']?\s*$/m)
      if (descMatch) shortDescription = descMatch[1]!.trim()
    }

    // If no shortDescription in frontmatter, try first paragraph after frontmatter
    if (!shortDescription) {
      const bodyStart = fmMatch ? content.indexOf('---', 4) + 3 : 0
      const body = content.slice(bodyStart).trim()
      const firstPara = body.split('\n\n')[0]?.replace(/^#+\s.*\n?/, '').trim()
      if (firstPara && firstPara.length < 200) {
        shortDescription = firstPara
      }
    }

    return { id, name: name || id, shortDescription: shortDescription || `Skill: ${id}` }
  }

  private async downloadGitHubDir(
    contents: GitHubContent[],
    targetDir: string,
    owner: string,
    repo: string,
  ): Promise<void> {
    for (const item of contents) {
      const targetPath = path.join(targetDir, item.name)

      if (item.type === 'file' && item.download_url) {
        const fileResponse = await fetch(item.download_url, { headers: getGitHubHeaders() })
        if (!fileResponse.ok) {
          throw new Error(`Failed to download ${item.download_url}: ${fileResponse.status}`)
        }
        const fileContent = Buffer.from(await fileResponse.arrayBuffer())
        await fs.writeFile(targetPath, fileContent)

        // Make scripts executable
        if (targetPath.includes('/scripts/') || targetPath.includes('\\scripts\\')) {
          try { await fs.chmod(targetPath, 0o755) } catch { /* ignore on Windows */ }
        }
      } else if (item.type === 'dir') {
        await fs.mkdir(targetPath, { recursive: true })
        // Recursively fetch subdirectory
        const subUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`
        const subResponse = await fetch(subUrl, { headers: getGitHubHeaders() })
        if (subResponse.ok) {
          const subContents = await subResponse.json() as GitHubContent[]
          if (Array.isArray(subContents)) {
            await this.downloadGitHubDir(subContents, targetPath, owner, repo)
          }
        }
      }
    }
  }

  private async installFromMarkdownContent(
    content: string,
    sourceUrl: string,
    skillIdHint?: string,
  ): Promise<SkillInstallResult> {
    const { id } = this.parseFrontmatterQuick(content, skillIdHint ?? this.deriveIdFromUrl(sourceUrl))
    const skillId = skillIdHint ?? id
    const skillDir = path.join(this.skillsDir, skillId)
    const isNew = !existsSync(skillDir)

    if (!isNew) {
      await fs.rm(skillDir, { recursive: true, force: true })
    }
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
    await this.writeSourceMeta(skillDir, { type: 'url', ref: sourceUrl, installedAt: new Date().toISOString() })

    this.onProgress(`Installed skill "${skillId}" from ${sourceUrl}`)
    return { skillId, skillDir, source: 'url', isNew }
  }

  private async installFromTarball(
    buffer: Buffer,
    sourceUrl: string,
    skillIdHint?: string,
  ): Promise<SkillInstallResult> {
    // Extract to a temp directory, then find SKILL.md
    const tmpDir = path.join(this.skillsDir, `.tmp-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })

    try {
      // Write tarball and extract
      const tarPath = path.join(tmpDir, 'skill.tar.gz')
      await fs.writeFile(tarPath, buffer)
      execSync(`tar -xzf "${tarPath}" -C "${tmpDir}"`, { stdio: 'pipe' })
      await fs.unlink(tarPath)

      // Find SKILL.md in extracted contents
      const skillMdPath = await this.findFileRecursive(tmpDir, 'SKILL.md')
      if (!skillMdPath) {
        throw new Error(`No SKILL.md found in archive from ${sourceUrl}`)
      }

      const extractedSkillDir = path.dirname(skillMdPath)
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { id } = this.parseFrontmatterQuick(content, skillIdHint ?? this.deriveIdFromUrl(sourceUrl))
      const skillId = skillIdHint ?? id

      // Move to final location
      const finalDir = path.join(this.skillsDir, skillId)
      const isNew = !existsSync(finalDir)
      if (!isNew) {
        await fs.rm(finalDir, { recursive: true, force: true })
      }
      await fs.rename(extractedSkillDir, finalDir)
      await this.writeSourceMeta(finalDir, { type: 'url', ref: sourceUrl, installedAt: new Date().toISOString() })

      this.onProgress(`Installed skill "${skillId}" from ${sourceUrl}`)
      return { skillId, skillDir: finalDir, source: 'url', isNew }
    } finally {
      // Cleanup temp
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async findFileRecursive(dir: string, targetName: string): Promise<string | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toUpperCase() === targetName.toUpperCase()) {
        return fullPath
      }
      if (entry.isDirectory()) {
        const found = await this.findFileRecursive(fullPath, targetName)
        if (found) return found
      }
    }
    return null
  }

  private deriveIdFromUrl(url: string): string {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1] ?? 'skill'
    // Strip extension
    return last.replace(/\.(md|tar\.gz|tgz|zip)$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-')
  }

  private async writeSourceMeta(skillDir: string, meta: SourceMeta): Promise<void> {
    await fs.writeFile(
      path.join(skillDir, '.source.json'),
      JSON.stringify(meta, null, 2) + '\n',
      'utf-8',
    )
  }
}
