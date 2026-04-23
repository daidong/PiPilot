/**
 * SVG → PNG rasterizer using an offscreen Electron BrowserWindow.
 *
 * We deliberately reuse Chromium instead of pulling in @resvg/resvg-js or
 * sharp: the app is already Electron, so Chromium is already shipped, and
 * Chromium's SVG + CSS + text rendering is best-in-class (especially for
 * fonts that are available on the host system).
 *
 * Used by the diagram tool's SVG-fallback path when the reviewer is a
 * vision model — rasterize the generated SVG and send the PNG through the
 * normal OpenAI/Anthropic vision review pipeline instead of feeding the
 * SVG source as text. Source-level review cannot see overflow, overlap,
 * or layout collisions; a rendered image can.
 */

import { BrowserWindow } from 'electron'

export interface RasterizeOptions {
  /** Output width in px. Default 1200. */
  width?: number
  /** Output height in px. Default 900. */
  height?: number
}

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 900
// Give fonts and gradients a beat to settle after load before we snap.
const SETTLE_MS = 200

/**
 * Extract numeric width/height from an SVG's viewBox attribute. Returns
 * null when the viewBox is missing or unparsable — callers fall back to
 * the defaults from the tool's aspect preset.
 */
export function viewBoxDimensions(svg: string): { width: number; height: number } | null {
  const match = svg.match(/viewBox\s*=\s*"([^"]+)"/i)
  if (!match) return null
  const parts = match[1].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [, , w, h] = parts
  if (w <= 0 || h <= 0) return null
  return { width: Math.round(w), height: Math.round(h) }
}

function wrapHtml(svg: string, width: number, height: number): string {
  // Force exact canvas size and a white background. capturePage on a
  // BrowserWindow includes whatever the DOM draws, so the wrapper pins
  // dimensions and eliminates browser chrome/margins.
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    `html, body { margin: 0; padding: 0; background: #ffffff; width: ${width}px; height: ${height}px; overflow: hidden; }`,
    'svg { display: block; width: 100%; height: 100%; }',
    '</style></head><body>',
    svg,
    '</body></html>',
  ].join('')
}

export async function rasterizeSvg(
  svg: Buffer,
  options: RasterizeOptions = {}
): Promise<Buffer> {
  const svgStr = svg.toString('utf-8')
  const vb = viewBoxDimensions(svgStr)
  const width = options.width ?? vb?.width ?? DEFAULT_WIDTH
  const height = options.height ?? vb?.height ?? DEFAULT_HEIGHT

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Sanity: SVG content is produced by our own prompt; nothing is user-
      // supplied from a network. Still, disable remote resources to be safe.
      webSecurity: true,
    },
  })

  try {
    const html = wrapHtml(svgStr, width, height)
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)

    await win.loadURL(dataUrl)
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))

    const image = await win.webContents.capturePage()
    return image.toPNG()
  } finally {
    // Destroy, never close: the window is never visible, never has listeners;
    // destroy reclaims the renderer process immediately.
    if (!win.isDestroyed()) win.destroy()
  }
}
