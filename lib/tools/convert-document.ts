/**
 * convert-document tool — converts PDF, DOCX, PPTX, XLSX and other document
 * formats into Markdown or plain text.
 *
 * Primary converter: markitdown CLI (pip install markitdown[all]).
 * Fallback: direct text extraction for text-like formats, pypdf for PDF page ranges.
 *
 * Migrated from myRAM-GCP with myRAM-specific dependencies removed:
 *   - No EvidenceManager, RoundManager, paper store, pointers, or globalEmitter.
 *   - Output stored under .research-pilot/cache/converted/ by default.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { toAgentResult, type ToolResult } from './tool-utils.js';
import type { ResearchToolContext } from './types.js';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Constants & defaults                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_OUTPUT_CHARS = 500_000;
const DEFAULT_PREVIEW_CHARS = 4_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

const SUPPORTED_FORMATS = new Set([
  'pdf', 'docx', 'pptx', 'xlsx', 'xls',
  'html', 'txt', 'md', 'csv', 'json', 'xml', 'epub', 'zip',
]);

const FALLBACK_FORMATS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html']);

const FORMAT_EXTENSIONS: Record<string, string> = {
  pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xls: 'xls',
  html: 'html', txt: 'txt', md: 'md', csv: 'csv', json: 'json',
  xml: 'xml', epub: 'epub', zip: 'zip',
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type OutputMode = 'markdown' | 'text';
type ConverterKind = 'markitdown' | 'fallback' | 'pypdf';
type ConvertStatus = 'completed' | 'partial' | 'failed';

type ConvertErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'DOWNLOAD_FAILED'
  | 'CONVERTER_NOT_FOUND'
  | 'CONVERSION_FAILED'
  | 'OUTPUT_TOO_LARGE'
  | 'PATH_OUTSIDE_WORKSPACE';

type PageRange = { raw: string; page_start: number; page_end: number };

type ExtractedPdfRange = { page_start: number; page_end: number; text: string };

type ContentPreviewSlice = {
  offset: number;
  length: number;
  line_start: number;
  line_end: number;
};

type ConvertPayload = {
  status: ConvertStatus;
  source: string;
  input_path?: string;
  downloaded_from_url?: string;
  output_path?: string;
  format_detected?: string;
  converter?: ConverterKind;
  output_chars?: number;
  truncated?: boolean;
  content_truncated?: boolean;
  slice?: ContentPreviewSlice;
  content?: string;
  page_count?: number;
  page_ranges?: string[];
  segments?: ConvertSegmentPayload[];
  error_code?: ConvertErrorCode;
  error?: string;
};

type ConvertSegmentPayload = {
  page_range: string;
  page_start: number;
  page_end: number;
  output_path: string;
  output_chars: number;
  truncated: boolean;
  content_truncated?: boolean;
  slice?: ContentPreviewSlice;
  content?: string;
};

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */

function resolveWithinProject(projectPath: string, targetPath: string): string {
  const root = path.resolve(projectPath);
  const resolved = targetPath.startsWith('/')
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project directory: ${targetPath}`);
  }
  return resolved;
}

function toProjectRelative(projectPath: string, absolutePath: string): string {
  return path.relative(path.resolve(projectPath), absolutePath);
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeBaseName(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'document';
}

function inferUrlBaseName(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    const candidate = path.parse(parsed.pathname).name || parsed.hostname;
    return sanitizeBaseName(candidate);
  } catch {
    return sanitizeBaseName(sourceUrl);
  }
}

function outputExtensionForMode(mode: OutputMode): '.md' | '.txt' {
  return mode === 'text' ? '.txt' : '.md';
}

function extensionFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return ext || undefined;
}

function normalizeMode(value: unknown): OutputMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'text'
    ? 'text'
    : 'markdown';
}

/* ------------------------------------------------------------------ */
/*  Format detection                                                   */
/* ------------------------------------------------------------------ */

function detectFormatFromContentType(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase().split(';')[0]?.trim() || '';
  if (!normalized) return undefined;
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xlsx',
    'text/html': 'html',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'application/epub+zip': 'epub',
    'application/zip': 'zip',
  };
  return map[normalized];
}

/* ------------------------------------------------------------------ */
/*  Text strippers                                                     */
/* ------------------------------------------------------------------ */

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/?(h[1-6]|p|div|section|article|main|header|footer|li|tr|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Binary-file sniff                                                  */
/* ------------------------------------------------------------------ */

async function detectTextLikeFile(filePath: string): Promise<boolean> {
  try {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
      if (bytesRead === 0) return true;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0) return false;
      }
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Shell command runners                                              */
/* ------------------------------------------------------------------ */

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; notFound: boolean; error: string }> {
  try {
    await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = err as { code?: string | number; stderr?: string; stdout?: string };
    const stderr = typeof details.stderr === 'string' ? details.stderr.trim() : '';
    const stdout = typeof details.stdout === 'string' ? details.stdout.trim() : '';
    const combined = [stderr, stdout, message].filter(Boolean).join('\n').slice(0, 4000);
    return {
      ok: false,
      notFound: details.code === 'ENOENT',
      error: combined || message,
    };
  }
}

async function runMarkitdown(
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<{ ok: true; method: string } | { ok: false; code: ConvertErrorCode; error: string }> {
  const attempts: Array<{ command: string; args: string[]; label: string }> = [
    { command: 'markitdown', args: [inputPath, '-o', outputPath], label: 'markitdown' },
    { command: 'python3', args: ['-m', 'markitdown', inputPath, '-o', outputPath], label: 'python3 -m markitdown' },
    { command: 'python', args: ['-m', 'markitdown', inputPath, '-o', outputPath], label: 'python -m markitdown' },
    { command: 'uvx', args: ['--from', 'markitdown[all]', 'markitdown', inputPath, '-o', outputPath], label: 'uvx markitdown' },
  ];

  let foundAnyRuntime = false;
  const errors: string[] = [];

  for (const attempt of attempts) {
    const result = await runCommand(attempt.command, attempt.args, timeoutMs);
    if (result.ok) {
      return { ok: true, method: attempt.label };
    }
    if (!result.notFound) {
      foundAnyRuntime = true;
      errors.push(`[${attempt.label}] ${result.error}`);
    }
  }

  if (!foundAnyRuntime) {
    return {
      ok: false,
      code: 'CONVERTER_NOT_FOUND',
      error:
        'markitdown is not installed or not reachable. ' +
        'Install it with: pip install "markitdown[all]"  — or ensure python3 / uvx is on PATH.',
    };
  }

  return {
    ok: false,
    code: 'CONVERSION_FAILED',
    error: errors.join('\n\n').slice(0, 8000),
  };
}

/* ------------------------------------------------------------------ */
/*  PDF page-range extraction via pypdf                                */
/* ------------------------------------------------------------------ */

async function extractPdfPageRanges(
  inputPath: string,
  ranges: PageRange[],
  timeoutMs: number,
): Promise<
  | { ok: true; pageCount: number; ranges: ExtractedPdfRange[] }
  | { ok: false; code: ConvertErrorCode; error: string }
> {
  const script = `
import json
import sys

try:
    from pypdf import PdfReader
except ImportError:
    from PyPDF2 import PdfReader

reader = PdfReader(sys.argv[1])
ranges = json.loads(sys.argv[2])
page_count = len(reader.pages)
result = {"page_count": page_count, "ranges": []}

for item in ranges:
    start = int(item["page_start"])
    end = int(item["page_end"])
    if start < 1 or end < start or end > page_count:
        raise ValueError(f"Requested page range {start}-{end} outside document page count {page_count}")
    blocks = []
    for page_num in range(start, end + 1):
        text = reader.pages[page_num - 1].extract_text() or ""
        text = text.strip()
        blocks.append(f"[Page {page_num}]\\n{text}" if text else f"[Page {page_num}]")
    result["ranges"].append({
        "page_start": start,
        "page_end": end,
        "text": "\\n\\n".join(blocks),
    })

print(json.dumps(result, ensure_ascii=False))
`.trim();

  const attempts = [
    { command: 'python3', label: 'python3' },
    { command: 'python', label: 'python' },
  ];
  const errors: string[] = [];
  let foundAnyRuntime = false;

  for (const attempt of attempts) {
    try {
      const { stdout } = await execFileAsync(
        attempt.command,
        ['-c', script, inputPath, JSON.stringify(ranges)],
        { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
      );
      const parsed = JSON.parse(stdout) as { page_count?: unknown; ranges?: unknown };
      if (typeof parsed.page_count !== 'number' || !Array.isArray(parsed.ranges)) {
        throw new Error(`Unexpected ${attempt.label} extraction payload`);
      }
      const extractedRanges = parsed.ranges.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error(`Unexpected ${attempt.label} extraction range payload`);
        }
        const raw = entry as Record<string, unknown>;
        const pageStart = typeof raw.page_start === 'number' ? Math.floor(raw.page_start) : NaN;
        const pageEnd = typeof raw.page_end === 'number' ? Math.floor(raw.page_end) : NaN;
        const text = typeof raw.text === 'string' ? raw.text : '';
        if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd) || pageStart < 1 || pageEnd < pageStart) {
          throw new Error(`Unexpected ${attempt.label} extraction range payload`);
        }
        return { page_start: pageStart, page_end: pageEnd, text };
      });
      return { ok: true, pageCount: Math.floor(parsed.page_count), ranges: extractedRanges };
    } catch (err) {
      const details = err as { code?: string | number; stderr?: string; stdout?: string };
      if (details.code === 'ENOENT') continue;
      foundAnyRuntime = true;
      const message = err instanceof Error ? err.message : String(err);
      const stderr = typeof details.stderr === 'string' ? details.stderr.trim() : '';
      const stdout = typeof details.stdout === 'string' ? details.stdout.trim() : '';
      errors.push(`[${attempt.label}] ${[stderr, stdout, message].filter(Boolean).join('\n').slice(0, 4000)}`);
    }
  }

  if (!foundAnyRuntime) {
    return {
      ok: false,
      code: 'CONVERTER_NOT_FOUND',
      error: 'python runtime with pypdf/PyPDF2 not found for PDF page-range extraction.',
    };
  }

  return {
    ok: false,
    code: 'CONVERSION_FAILED',
    error: errors.join('\n\n').slice(0, 8000),
  };
}

/* ------------------------------------------------------------------ */
/*  Fallback conversion (text-like formats)                            */
/* ------------------------------------------------------------------ */

async function runFallbackConversion(
  inputPath: string,
  format: string,
  mode: OutputMode,
): Promise<string> {
  const raw = await fsp.readFile(inputPath, 'utf8');
  if (mode === 'markdown') {
    if (format === 'html') return `# Extracted Text\n\n${htmlToText(raw)}`;
    if (format === 'md' || format === 'txt') return raw;
    const lang = format === 'json' ? 'json' : format === 'xml' ? 'xml' : format === 'csv' ? 'csv' : '';
    return lang ? `\`\`\`${lang}\n${raw}\n\`\`\`` : raw;
  }
  if (format === 'html') return htmlToText(raw);
  if (format === 'md') return markdownToText(raw);
  return raw;
}

/* ------------------------------------------------------------------ */
/*  URL download                                                       */
/* ------------------------------------------------------------------ */

async function downloadToProject(
  projectPath: string,
  sourceUrl: string,
): Promise<
  | {
      ok: true;
      inputPath: string;
      inputRelativePath: string;
      contentType: string | null;
      formatFromContentType?: string;
      formatFromUrlExt?: string;
    }
  | { ok: false; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'research-pilot-convert/0.1' },
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Download request failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      error: `Download failed (${response.status}). ${body.slice(0, 400)}`.trim(),
    };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > DEFAULT_MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `Downloaded file too large (${bytes.length} bytes > ${DEFAULT_MAX_DOWNLOAD_BYTES} bytes)` };
  }

  const downloadDir = path.join(path.resolve(projectPath), '.research-pilot', 'cache', 'downloads');
  await fsp.mkdir(downloadDir, { recursive: true });

  const urlObj = new URL(sourceUrl);
  const fromExt = extensionFromPath(urlObj.pathname);
  const fromContentType = detectFormatFromContentType(response.headers.get('content-type'));
  const chosenExt = FORMAT_EXTENSIONS[fromContentType || ''] || FORMAT_EXTENSIONS[fromExt || ''] || 'bin';

  const hash = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 12);
  const fileName = `${isoStamp()}-${hash}.${chosenExt}`;
  const inputPath = path.join(downloadDir, fileName);
  await fsp.writeFile(inputPath, bytes);

  return {
    ok: true,
    inputPath,
    inputRelativePath: toProjectRelative(projectPath, inputPath),
    contentType: response.headers.get('content-type'),
    formatFromContentType: fromContentType,
    formatFromUrlExt: fromExt,
  };
}

/* ------------------------------------------------------------------ */
/*  Page-range helpers                                                 */
/* ------------------------------------------------------------------ */

function parsePageRanges(value: unknown): PageRange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('page_ranges must be an array of strings like ["7-9", "12"]');
  }
  const ranges = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('page_ranges entries must be non-empty strings like "7-9" or "12"');
    }
    const normalized = entry.trim();
    const match = normalized.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`Invalid page range: ${normalized}`);
    const pageStart = Number.parseInt(match[1], 10);
    const pageEnd = Number.parseInt(match[2] || match[1], 10);
    if (pageStart < 1 || pageEnd < pageStart) throw new Error(`Invalid page range: ${normalized}`);
    return {
      raw: pageStart === pageEnd ? String(pageStart) : `${pageStart}-${pageEnd}`,
      page_start: pageStart,
      page_end: pageEnd,
    };
  });
  if (ranges.length === 0) throw new Error('page_ranges cannot be empty');
  return ranges;
}

function pageRangeLabel(range: Pick<PageRange, 'page_start' | 'page_end'>): string {
  return range.page_start === range.page_end
    ? `Page ${range.page_start}`
    : `Pages ${range.page_start}-${range.page_end}`;
}

function rangeFileToken(range: Pick<PageRange, 'page_start' | 'page_end'>): string {
  const s = String(range.page_start).padStart(4, '0');
  const e = String(range.page_end).padStart(4, '0');
  return range.page_start === range.page_end ? `p${s}` : `p${s}-${e}`;
}

function buildPdfRangeDocument(range: ExtractedPdfRange, mode: OutputMode): string {
  const body = range.text.trim() || `[No extractable text found in ${pageRangeLabel(range)}]`;
  if (mode === 'text') {
    const underline = '='.repeat(pageRangeLabel(range).length + 14);
    return `Extracted PDF ${pageRangeLabel(range)}\n${underline}\n\n${body}\n`;
  }
  return `# Extracted PDF ${pageRangeLabel(range)}\n\n${body}\n`;
}

function buildPdfRangesDocument(ranges: ExtractedPdfRange[], mode: OutputMode): string {
  if (ranges.length === 1) return buildPdfRangeDocument(ranges[0], mode);
  if (mode === 'text') {
    const sections = ranges
      .map((r) => `${pageRangeLabel(r)}\n${'-'.repeat(pageRangeLabel(r).length)}\n\n${r.text.trim() || `[No extractable text found in ${pageRangeLabel(r)}]`}`)
      .join('\n\n');
    return `Extracted PDF Page Ranges\n=========================\n\n${sections}\n`;
  }
  const sections = ranges
    .map((r) => `## ${pageRangeLabel(r)}\n\n${r.text.trim() || `[No extractable text found in ${pageRangeLabel(r)}]`}`)
    .join('\n\n');
  return `# Extracted PDF Page Ranges\n\n${sections}\n`;
}

function buildPerRangeOutputPath(
  baseAbsolutePath: string,
  range: Pick<PageRange, 'page_start' | 'page_end'>,
  mode: OutputMode,
): string {
  const parsed = path.parse(baseAbsolutePath);
  const ext = parsed.ext || outputExtensionForMode(mode);
  return path.join(parsed.dir, `${parsed.name}-${rangeFileToken(range)}${ext}`);
}

/* ------------------------------------------------------------------ */
/*  Preview builder                                                    */
/* ------------------------------------------------------------------ */

function buildPreview(
  text: string,
  maxPreviewChars: number = DEFAULT_PREVIEW_CHARS,
): {
  content: string;
  content_truncated: boolean;
  slice: ContentPreviewSlice;
} {
  const content = text.slice(0, maxPreviewChars);
  const lineEnd = 1 + (content.match(/\n/g)?.length ?? 0);
  return {
    content,
    content_truncated: content.length < text.length,
    slice: { offset: 0, length: content.length, line_start: 1, line_end: lineEnd },
  };
}

/* ------------------------------------------------------------------ */
/*  Default output path                                                */
/* ------------------------------------------------------------------ */

function defaultOutputPath(args: {
  projectPath: string;
  inputPath?: string;
  sourceRaw: string;
  isUrl: boolean;
  mode: OutputMode;
}): string {
  const outputDir = path.join(
    path.resolve(args.projectPath),
    '.research-pilot',
    'cache',
    'converted',
  );
  const baseName = args.isUrl
    ? inferUrlBaseName(args.sourceRaw)
    : sanitizeBaseName(path.parse(args.inputPath || 'document').name || 'document');
  return path.join(outputDir, `${baseName}-${isoStamp()}${outputExtensionForMode(args.mode)}`);
}

/* ------------------------------------------------------------------ */
/*  Result helpers                                                     */
/* ------------------------------------------------------------------ */

function failure(payload: ConvertPayload) {
  return toAgentResult('convert_document', { success: false, error: payload.error, data: payload });
}

function success(payload: ConvertPayload) {
  return toAgentResult('convert_document', { success: true, data: payload });
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

const ConvertDocumentSchema = Type.Object({
  source: Type.String({
    description: 'File path (relative to project root) or http(s) URL of the document to convert.',
  }),
  output_path: Type.Optional(
    Type.String({
      description: 'Where to save converted output (relative to project root). Defaults to .research-pilot/cache/converted/<name>.md',
    }),
  ),
  mode: Type.Optional(
    Type.String({ description: "'markdown' (default) or 'text'" }),
  ),
  max_chars: Type.Optional(
    Type.Number({ minimum: 100, description: 'Maximum output characters. Truncates if exceeded.' }),
  ),
  format_hint: Type.Optional(
    Type.String({ description: 'Force format detection: pdf, docx, pptx, xlsx, html, etc.' }),
  ),
  page_ranges: Type.Optional(
    Type.Array(
      Type.String({ description: 'PDF page ranges like "7-9" or "12".' }),
    ),
  ),
});

/* ------------------------------------------------------------------ */
/*  Tool factory                                                       */
/* ------------------------------------------------------------------ */

export function createConvertDocumentTool(ctx: ResearchToolContext): AgentTool {
  const { projectPath } = ctx;

  return {
    name: 'convert_document',
    label: 'Convert Document',
    description:
      'Convert a local file (PDF, DOCX, PPTX, XLSX, HTML, etc.) or a URL into Markdown or ' +
      'plain text. Uses markitdown CLI as primary converter with fallback text extraction. ' +
      'For PDFs, supports page_ranges to extract specific pages via pypdf.',
    parameters: ConvertDocumentSchema,

    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>;
      const sourceRaw = typeof params.source === 'string' ? params.source.trim() : '';
      if (!sourceRaw) {
        return failure({
          status: 'failed',
          source: sourceRaw,
          error_code: 'CONVERSION_FAILED',
          error: 'Missing required parameter: source',
        });
      }

      const mode = normalizeMode(params.mode);
      const formatHint = typeof params.format_hint === 'string' && params.format_hint.trim()
        ? params.format_hint.trim().toLowerCase()
        : undefined;
      if (formatHint && formatHint !== 'auto' && !SUPPORTED_FORMATS.has(formatHint)) {
        return failure({
          status: 'failed',
          source: sourceRaw,
          error_code: 'UNSUPPORTED_FORMAT',
          error: `Unsupported format_hint: ${formatHint}`,
        });
      }

      let pageRanges: PageRange[];
      try {
        pageRanges = parsePageRanges(params.page_ranges);
      } catch (err) {
        return failure({
          status: 'failed',
          source: sourceRaw,
          error_code: 'CONVERSION_FAILED',
          error: String(err),
        });
      }

      const maxCharsRaw = typeof params.max_chars === 'number' && Number.isFinite(params.max_chars)
        ? Math.floor(params.max_chars)
        : undefined;
      const maxChars = typeof maxCharsRaw === 'number'
        ? Math.max(100, Math.min(DEFAULT_MAX_OUTPUT_CHARS, maxCharsRaw))
        : undefined;

      const isUrl = isHttpUrl(sourceRaw);
      let inputPath = '';
      let inputRelativePath = '';
      let downloadedFromUrl: string | undefined = isUrl ? sourceRaw : undefined;
      let formatFromSource: string | undefined;

      // ── Resolve source ──────────────────────────────────────────
      if (isUrl) {
        try {
          const parsed = new URL(sourceRaw);
          formatFromSource = extensionFromPath(parsed.pathname);
        } catch {
          formatFromSource = undefined;
        }
      } else {
        let resolvedPath: string;
        try {
          resolvedPath = resolveWithinProject(projectPath, sourceRaw);
        } catch {
          return failure({
            status: 'failed',
            source: sourceRaw,
            error_code: 'PATH_OUTSIDE_WORKSPACE',
            error: `Path escapes project directory: ${sourceRaw}`,
          });
        }
        if (!fs.existsSync(resolvedPath)) {
          return failure({
            status: 'failed',
            source: sourceRaw,
            error_code: 'CONVERSION_FAILED',
            error: `Source file not found: ${sourceRaw}`,
          });
        }
        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) {
          return failure({
            status: 'failed',
            source: sourceRaw,
            error_code: 'CONVERSION_FAILED',
            error: `Source path is not a file: ${sourceRaw}`,
          });
        }
        inputPath = resolvedPath;
        inputRelativePath = toProjectRelative(projectPath, resolvedPath);
        formatFromSource = extensionFromPath(resolvedPath);
        if (!formatFromSource && await detectTextLikeFile(resolvedPath)) {
          formatFromSource = 'txt';
        }
      }

      // ── Download URL source ─────────────────────────────────────
      let formatDetected = (formatHint && formatHint !== 'auto') ? formatHint : formatFromSource;

      if (isUrl) {
        const downloaded = await downloadToProject(projectPath, sourceRaw);
        if (!downloaded.ok) {
          return failure({
            status: 'failed',
            source: sourceRaw,
            downloaded_from_url: sourceRaw,
            error_code: 'DOWNLOAD_FAILED',
            error: downloaded.error,
          });
        }
        inputPath = downloaded.inputPath;
        inputRelativePath = downloaded.inputRelativePath;
        formatFromSource = downloaded.formatFromContentType || downloaded.formatFromUrlExt;
        formatDetected = (formatHint && formatHint !== 'auto') ? formatHint : formatFromSource;
      }

      // ── Format validation ───────────────────────────────────────
      if (!formatDetected || !SUPPORTED_FORMATS.has(formatDetected)) {
        return failure({
          status: 'failed',
          source: sourceRaw,
          input_path: inputRelativePath || undefined,
          downloaded_from_url: downloadedFromUrl,
          error_code: 'UNSUPPORTED_FORMAT',
          error: formatDetected
            ? `Unsupported format detected: ${formatDetected}`
            : 'Unable to detect document format from source. Provide format_hint.',
        });
      }
      if (pageRanges.length > 0 && formatDetected !== 'pdf') {
        return failure({
          status: 'failed',
          source: sourceRaw,
          input_path: inputRelativePath,
          downloaded_from_url: downloadedFromUrl,
          format_detected: formatDetected,
          error_code: 'UNSUPPORTED_FORMAT',
          error: 'page_ranges is currently supported only for PDF sources.',
        });
      }

      // ── Determine output path ───────────────────────────────────
      let outputAbsolutePath = '';
      if (typeof params.output_path === 'string' && params.output_path.trim()) {
        try {
          outputAbsolutePath = resolveWithinProject(projectPath, params.output_path.trim());
        } catch {
          return failure({
            status: 'failed',
            source: sourceRaw,
            input_path: inputRelativePath,
            downloaded_from_url: downloadedFromUrl,
            format_detected: formatDetected,
            error_code: 'PATH_OUTSIDE_WORKSPACE',
            error: `Output path escapes project directory: ${params.output_path}`,
          });
        }
      } else {
        outputAbsolutePath = defaultOutputPath({
          projectPath,
          inputPath,
          sourceRaw,
          isUrl,
          mode,
        });
      }
      await fsp.mkdir(path.dirname(outputAbsolutePath), { recursive: true });

      // ── Convert ─────────────────────────────────────────────────
      let converter: ConverterKind;
      let producedText = '';
      let pageCount: number | undefined;
      let segmentPayloads: ConvertSegmentPayload[] | undefined;

      if (pageRanges.length > 0) {
        // PDF page-range extraction via pypdf
        const extractResult = await extractPdfPageRanges(inputPath, pageRanges, DEFAULT_COMMAND_TIMEOUT_MS);
        if (!extractResult.ok) {
          return failure({
            status: 'failed',
            source: sourceRaw,
            input_path: inputRelativePath,
            downloaded_from_url: downloadedFromUrl,
            format_detected: formatDetected,
            converter: 'pypdf',
            error_code: extractResult.code,
            error: extractResult.error,
          });
        }
        converter = 'pypdf';
        pageCount = extractResult.pageCount;

        // Per-range splitting: write each range to a separate file
        if (pageRanges.length > 1) {
          const segmentLimit = maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
          const segments: ConvertSegmentPayload[] = [];
          let anyTruncated = false;

          for (const range of extractResult.ranges) {
            let segmentText = buildPdfRangeDocument(range, mode);
            const truncated = segmentText.length > segmentLimit;
            if (truncated) {
              segmentText = segmentText.slice(0, segmentLimit);
              anyTruncated = true;
            }

            const segmentAbsPath = buildPerRangeOutputPath(outputAbsolutePath, range, mode);
            await fsp.mkdir(path.dirname(segmentAbsPath), { recursive: true });
            await fsp.writeFile(segmentAbsPath, segmentText, 'utf8');
            const segmentRelPath = toProjectRelative(projectPath, segmentAbsPath);
            const segmentPreview = buildPreview(segmentText);

            segments.push({
              page_range: range.page_start === range.page_end
                ? String(range.page_start)
                : `${range.page_start}-${range.page_end}`,
              page_start: range.page_start,
              page_end: range.page_end,
              output_path: segmentRelPath,
              output_chars: segmentText.length,
              truncated,
              content_truncated: segmentPreview.content_truncated,
              slice: segmentPreview.slice,
              content: segmentPreview.content,
            });
          }

          segmentPayloads = segments;
          const totalChars = segments.reduce((sum, s) => sum + s.output_chars, 0);
          return success({
            status: anyTruncated ? 'partial' : 'completed',
            source: sourceRaw,
            input_path: inputRelativePath,
            downloaded_from_url: downloadedFromUrl,
            format_detected: formatDetected,
            converter,
            output_chars: totalChars,
            truncated: anyTruncated,
            page_count: pageCount,
            page_ranges: pageRanges.map((r) => r.raw),
            segments: segmentPayloads,
          });
        }

        // Single combined document for all requested ranges
        producedText = buildPdfRangesDocument(extractResult.ranges, mode);
      } else if (FALLBACK_FORMATS.has(formatDetected)) {
        converter = 'fallback';
        producedText = await runFallbackConversion(inputPath, formatDetected, mode);
      } else {
        // markitdown for PDF, DOCX, PPTX, XLSX, EPUB, etc.
        const convertResult = await runMarkitdown(inputPath, outputAbsolutePath, DEFAULT_COMMAND_TIMEOUT_MS);
        if (!convertResult.ok) {
          return failure({
            status: 'failed',
            source: sourceRaw,
            input_path: inputRelativePath,
            downloaded_from_url: downloadedFromUrl,
            output_path: toProjectRelative(projectPath, outputAbsolutePath),
            format_detected: formatDetected,
            converter: 'markitdown',
            error_code: convertResult.code,
            error: convertResult.error,
          });
        }
        converter = 'markitdown';
        const extractedMarkdown = await fsp.readFile(outputAbsolutePath, 'utf8');
        producedText = mode === 'text' ? markdownToText(extractedMarkdown) : extractedMarkdown;
      }

      // ── Size check & truncation ─────────────────────────────────
      const hardLimit = maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      if (producedText.length > DEFAULT_MAX_OUTPUT_CHARS && maxChars === undefined) {
        return failure({
          status: 'failed',
          source: sourceRaw,
          input_path: inputRelativePath,
          downloaded_from_url: downloadedFromUrl,
          output_path: toProjectRelative(projectPath, outputAbsolutePath),
          format_detected: formatDetected,
          converter,
          error_code: 'OUTPUT_TOO_LARGE',
          error: `Converted output exceeds max allowed chars (${producedText.length} > ${DEFAULT_MAX_OUTPUT_CHARS}). ` +
            'Set max_chars to truncate, or use page_ranges to convert specific pages.',
        });
      }

      const truncated = producedText.length > hardLimit;
      if (truncated) {
        producedText = producedText.slice(0, hardLimit);
      }

      // ── Write output & build preview ────────────────────────────
      await fsp.writeFile(outputAbsolutePath, producedText, 'utf8');
      const outputRelativePath = toProjectRelative(projectPath, outputAbsolutePath);
      const preview = buildPreview(producedText);

      const payload: ConvertPayload = {
        status: truncated ? 'partial' : 'completed',
        source: sourceRaw,
        input_path: inputRelativePath || undefined,
        downloaded_from_url: downloadedFromUrl,
        output_path: outputRelativePath,
        format_detected: formatDetected,
        converter,
        output_chars: producedText.length,
        truncated,
        content_truncated: preview.content_truncated,
        slice: preview.slice,
        content: preview.content,
        page_count: pageCount,
        page_ranges: pageRanges.length > 0 ? pageRanges.map((r) => r.raw) : undefined,
      };

      return success(payload);
    },
  };
}
