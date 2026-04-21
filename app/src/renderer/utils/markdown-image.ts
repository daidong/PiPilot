// Resolves a markdown <img src> to a URL the renderer can actually load.
//
// Markdown files routinely reference images by relative path
// (`![](./figures/a.png)`) or absolute disk path (`![](/Users/me/...)`).
// Neither works out of the box in Electron: relative paths have no valid
// base (the renderer is served over http:// in dev or file:// in prod,
// not the markdown file's directory), and file:// is blocked by
// webSecurity.
//
// Solution: rewrite the src to `workspace-asset://asset/<abs-path>`,
// a custom protocol the main process serves in main/index.ts. Remote
// URLs and data URLs are left untouched.
export function resolveMarkdownImageUrl(
  src: string | undefined | null,
  baseDir: string | undefined
): string {
  if (!src) return ''
  // Already a fetchable URL — leave it alone.
  if (/^(?:https?:|data:|blob:|workspace-asset:|file:)/i.test(src)) return src

  let absPath: string | null = null
  if (src.startsWith('/')) {
    absPath = src
  } else if (baseDir) {
    try {
      const normalizedBase = baseDir.endsWith('/') ? baseDir : baseDir + '/'
      const resolved = new URL(src, `file://${normalizedBase}`)
      absPath = decodeURIComponent(resolved.pathname)
    } catch {
      absPath = null
    }
  }

  if (!absPath) return src
  return `workspace-asset://asset${encodeURI(absPath)}`
}

/** Derive the directory of a file path. Uses POSIX slashes; handles
 *  both '/' and '\\' separators in the input. */
export function dirnameOf(filePath: string | undefined | null): string | undefined {
  if (!filePath) return undefined
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return undefined
  return normalized.slice(0, idx)
}
