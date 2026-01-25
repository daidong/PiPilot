/**
 * Browser Tool - Web Browser Automation via agent-browser
 *
 * Provides browser automation capabilities for AI agents using agent-browser CLI.
 * Enables web scraping, form filling, clicking, and extracting content from
 * websites that don't have APIs.
 *
 * @see https://agent-browser.dev/
 * @see https://github.com/vercel-labs/agent-browser
 *
 * Prerequisites:
 * - Install agent-browser: `npm install -g agent-browser`
 * - Install Chromium: `agent-browser install`
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import { spawn } from 'child_process'

// Browser action types
export type BrowserAction =
  | 'open'        // Navigate to URL
  | 'snapshot'    // Get accessibility tree with refs
  | 'click'       // Click element
  | 'fill'        // Fill input field
  | 'type'        // Type text
  | 'press'       // Press key
  | 'scroll'      // Scroll page
  | 'screenshot'  // Take screenshot
  | 'getText'     // Get element text
  | 'getHtml'     // Get element HTML
  | 'getValue'    // Get input value
  | 'eval'        // Execute JavaScript
  | 'wait'        // Wait for element/condition
  | 'close'       // Close browser

export interface BrowserInput {
  /** Browser action to perform */
  action: BrowserAction
  /** URL for 'open' action */
  url?: string
  /** Element selector (ref like @e1, or CSS selector) */
  selector?: string
  /** Text for 'fill', 'type' actions */
  text?: string
  /** Key for 'press' action (e.g., 'Enter', 'Tab', 'Control+a') */
  key?: string
  /** Scroll direction for 'scroll' action */
  direction?: 'up' | 'down' | 'left' | 'right'
  /** Scroll pixels */
  pixels?: number
  /** Path for screenshot */
  path?: string
  /** Full page screenshot */
  fullPage?: boolean
  /** JavaScript code for 'eval' action */
  javascript?: string
  /** Wait timeout in milliseconds */
  timeout?: number
  /** Include interactive elements only in snapshot */
  interactive?: boolean
  /** Session name for isolated browser instances */
  session?: string
  /** Attribute name for 'getAttr' */
  attribute?: string
}

export interface BrowserOutput {
  /** Action performed */
  action: BrowserAction
  /** Raw output from agent-browser */
  output: string
  /** Parsed elements from snapshot (if applicable) */
  elements?: SnapshotElement[]
  /** Screenshot path (if applicable) */
  screenshotPath?: string
  /** Extracted text (if applicable) */
  text?: string
  /** Current URL */
  url?: string
}

export interface SnapshotElement {
  /** Element reference (e.g., @e1, @e2) */
  ref: string
  /** Element role (button, link, textbox, etc.) */
  role: string
  /** Element name/label */
  name?: string
  /** Element value (for inputs) */
  value?: string
  /** Whether element is focused */
  focused?: boolean
  /** Whether element is disabled */
  disabled?: boolean
}

/**
 * Execute agent-browser command
 */
async function executeAgentBrowser(
  args: string[],
  timeout: number = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('agent-browser', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0
      })
    })

    proc.on('error', (err) => {
      reject(err)
    })

    // Set timeout
    setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeout}ms`))
    }, timeout)
  })
}

/**
 * Parse snapshot output to extract elements
 */
function parseSnapshot(output: string): SnapshotElement[] {
  const elements: SnapshotElement[] = []

  // Match lines like: - link "Learn more" [ref=e1]
  // or: - textbox "Email" [ref=e2] value="test@example.com"
  // or: - button "Submit" [ref=e3] (disabled)
  const refPattern = /-\s+(\w+)\s+"([^"]*)"(?:\s+\[ref=(e\d+)\])(?:\s+value="([^"]*)")?(?:\s+\((focused|disabled)\))?/g

  let match
  while ((match = refPattern.exec(output)) !== null) {
    if (match[1] && match[3]) {
      elements.push({
        ref: `@${match[3]}`,  // Convert e1 to @e1 for consistency
        role: match[1],
        name: match[2],
        value: match[4],
        focused: match[5] === 'focused',
        disabled: match[5] === 'disabled'
      })
    }
  }

  return elements
}

/**
 * Browser automation tool using agent-browser CLI
 */
export const browser: Tool<BrowserInput, BrowserOutput> = defineTool({
  name: 'browser',
  description: `Automate web browser for scraping and interaction.
Uses agent-browser CLI for headless browser automation.

**Prerequisites**: Install with \`npm install -g agent-browser && agent-browser install\`

**Workflow**:
1. Use action='open' to navigate to a URL
2. Use action='snapshot' to see interactive elements (returns refs like @e1, @e2)
3. Use action='click'/'fill' with selector='@e1' to interact
4. Re-snapshot after page changes to get new refs

**Available actions**:
- open: Navigate to URL
- snapshot: Get accessibility tree with element refs
- click: Click element by ref (e.g., @e1)
- fill: Clear and fill input field
- type: Type text into element
- press: Press key (Enter, Tab, Escape, Control+a, etc.)
- scroll: Scroll page (up/down/left/right)
- screenshot: Capture page image
- getText: Extract text from element
- getHtml: Get element HTML
- getValue: Get input value
- eval: Execute JavaScript
- wait: Wait for element/condition
- close: Close browser session`,
  parameters: {
    action: {
      type: 'string',
      description: 'Browser action to perform',
      required: true,
      enum: ['open', 'snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'screenshot', 'getText', 'getHtml', 'getValue', 'eval', 'wait', 'close']
    },
    url: {
      type: 'string',
      description: 'URL for open action',
      required: false
    },
    selector: {
      type: 'string',
      description: 'Element selector (ref like @e1, or CSS selector)',
      required: false
    },
    text: {
      type: 'string',
      description: 'Text for fill/type actions',
      required: false
    },
    key: {
      type: 'string',
      description: 'Key for press action (Enter, Tab, Escape, Control+a)',
      required: false
    },
    direction: {
      type: 'string',
      description: 'Scroll direction',
      required: false,
      enum: ['up', 'down', 'left', 'right']
    },
    pixels: {
      type: 'number',
      description: 'Scroll pixels (default: 300)',
      required: false
    },
    path: {
      type: 'string',
      description: 'Screenshot file path',
      required: false
    },
    fullPage: {
      type: 'boolean',
      description: 'Capture full page screenshot',
      required: false
    },
    javascript: {
      type: 'string',
      description: 'JavaScript code for eval action',
      required: false
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (default: 30000)',
      required: false
    },
    interactive: {
      type: 'boolean',
      description: 'Only show interactive elements in snapshot',
      required: false,
      default: true
    },
    session: {
      type: 'string',
      description: 'Session name for isolated browser instances',
      required: false
    }
  },
  execute: async (input) => {
    const {
      action,
      url,
      selector,
      text,
      key,
      direction,
      pixels,
      path,
      fullPage,
      javascript,
      timeout = 30000,
      interactive = true,
      session
    } = input

    try {
      // Build command arguments
      const args: string[] = []

      // Add session if specified
      if (session) {
        args.push('--session', session)
      }

      // Build command based on action
      switch (action) {
        case 'open':
          if (!url) {
            return { success: false, error: 'URL is required for open action' }
          }
          args.push('open', url)
          break

        case 'snapshot':
          args.push('snapshot')
          if (interactive) {
            args.push('-i')
          }
          break

        case 'click':
          if (!selector) {
            return { success: false, error: 'Selector is required for click action' }
          }
          args.push('click', selector)
          break

        case 'fill':
          if (!selector || text === undefined) {
            return { success: false, error: 'Selector and text are required for fill action' }
          }
          args.push('fill', selector, text)
          break

        case 'type':
          if (!selector || text === undefined) {
            return { success: false, error: 'Selector and text are required for type action' }
          }
          args.push('type', selector, text)
          break

        case 'press':
          if (!key) {
            return { success: false, error: 'Key is required for press action' }
          }
          args.push('press', key)
          break

        case 'scroll':
          args.push('scroll', direction || 'down')
          if (pixels) {
            args.push(String(pixels))
          }
          break

        case 'screenshot':
          args.push('screenshot')
          if (path) {
            args.push(path)
          }
          if (fullPage) {
            args.push('--full')
          }
          break

        case 'getText':
          if (!selector) {
            return { success: false, error: 'Selector is required for getText action' }
          }
          args.push('get', 'text', selector)
          break

        case 'getHtml':
          if (!selector) {
            return { success: false, error: 'Selector is required for getHtml action' }
          }
          args.push('get', 'html', selector)
          break

        case 'getValue':
          if (!selector) {
            return { success: false, error: 'Selector is required for getValue action' }
          }
          args.push('get', 'value', selector)
          break

        case 'eval':
          if (!javascript) {
            return { success: false, error: 'JavaScript code is required for eval action' }
          }
          args.push('eval', javascript)
          break

        case 'wait':
          if (selector) {
            args.push('wait', selector)
          } else if (timeout) {
            args.push('wait', String(timeout))
          }
          break

        case 'close':
          args.push('close')
          break

        default:
          return { success: false, error: `Unknown action: ${action}` }
      }

      // Execute command
      const result = await executeAgentBrowser(args, timeout + 5000)

      if (result.exitCode !== 0 && result.stderr) {
        return {
          success: false,
          error: `Browser command failed: ${result.stderr}`
        }
      }

      // Build output
      const output: BrowserOutput = {
        action,
        output: result.stdout
      }

      // Parse snapshot elements
      if (action === 'snapshot') {
        output.elements = parseSnapshot(result.stdout)
      }

      // Add screenshot path
      if (action === 'screenshot' && path) {
        output.screenshotPath = path
      }

      // Add extracted text
      if (action === 'getText' || action === 'getValue' || action === 'getHtml') {
        output.text = result.stdout
      }

      return {
        success: true,
        data: output
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Check if agent-browser is not installed
      if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
        return {
          success: false,
          error: 'agent-browser is not installed. Install with: npm install -g agent-browser && agent-browser install'
        }
      }

      return {
        success: false,
        error: `Browser action failed: ${errorMessage}`
      }
    }
  }
})

/**
 * High-level browse tool for simple web scraping
 */
export interface BrowseInput {
  /** URL to browse */
  url: string
  /** What to extract: 'text', 'links', 'images', 'all' */
  extract?: 'text' | 'links' | 'images' | 'all'
  /** CSS selector to target specific content */
  selector?: string
  /** Wait for this selector before extracting */
  waitFor?: string
  /** Take a screenshot */
  screenshot?: boolean
  /** Screenshot path */
  screenshotPath?: string
}

export interface BrowseOutput {
  /** Page URL */
  url: string
  /** Page title */
  title?: string
  /** Extracted text content */
  text?: string
  /** Extracted links */
  links?: Array<{ text: string; href: string }>
  /** Interactive elements with refs */
  elements?: SnapshotElement[]
  /** Screenshot path if taken */
  screenshotPath?: string
}

/**
 * High-level browse tool for simple web content extraction
 */
export const browse: Tool<BrowseInput, BrowseOutput> = defineTool({
  name: 'browse',
  description: `Browse a web page and extract content.
Simplified interface for common web scraping tasks.

**Use cases**:
- Extract text content from a webpage
- Get all links on a page
- See interactive elements for further interaction
- Take screenshots

**Prerequisites**: Install with \`npm install -g agent-browser && agent-browser install\``,
  parameters: {
    url: {
      type: 'string',
      description: 'URL to browse',
      required: true
    },
    extract: {
      type: 'string',
      description: 'What to extract: text, links, images, or all',
      required: false,
      enum: ['text', 'links', 'images', 'all'],
      default: 'all'
    },
    selector: {
      type: 'string',
      description: 'CSS selector to target specific content',
      required: false
    },
    waitFor: {
      type: 'string',
      description: 'Wait for this selector before extracting',
      required: false
    },
    screenshot: {
      type: 'boolean',
      description: 'Take a screenshot',
      required: false,
      default: false
    },
    screenshotPath: {
      type: 'string',
      description: 'Screenshot file path',
      required: false
    }
  },
  execute: async (input) => {
    const {
      url,
      extract = 'all',
      selector,
      waitFor,
      screenshot,
      screenshotPath
    } = input

    try {
      const output: BrowseOutput = { url }

      // Open URL
      let result = await executeAgentBrowser(['open', url], 30000)
      if (result.exitCode !== 0) {
        return { success: false, error: `Failed to open URL: ${result.stderr}` }
      }

      // Wait for selector if specified
      if (waitFor) {
        result = await executeAgentBrowser(['wait', waitFor], 30000)
      }

      // Get page title
      result = await executeAgentBrowser(['get', 'title'], 5000)
      output.title = result.stdout

      // Get snapshot for interactive elements
      result = await executeAgentBrowser(['snapshot', '-i'], 10000)
      output.elements = parseSnapshot(result.stdout)

      // Extract text
      if (extract === 'text' || extract === 'all') {
        if (selector) {
          result = await executeAgentBrowser(['get', 'text', selector], 10000)
        } else {
          result = await executeAgentBrowser(['get', 'text', 'body'], 10000)
        }
        output.text = result.stdout
      }

      // Extract links
      if (extract === 'links' || extract === 'all') {
        result = await executeAgentBrowser([
          'eval',
          `JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(a => ({ text: a.textContent?.trim(), href: a.href })).filter(l => l.text && l.href))`
        ], 10000)
        try {
          output.links = JSON.parse(result.stdout)
        } catch {
          output.links = []
        }
      }

      // Take screenshot
      if (screenshot) {
        const path = screenshotPath || `/tmp/screenshot-${Date.now()}.png`
        await executeAgentBrowser(['screenshot', path, '--full'], 10000)
        output.screenshotPath = path
      }

      return {
        success: true,
        data: output
      }
    } catch (error) {
      return {
        success: false,
        error: `Browse failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    }
  }
})
