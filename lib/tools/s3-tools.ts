/**
 * S3 minimal tools — RFC-009 §4.3 narrowed.
 *
 * Phase 1 ships three read-side tools that let the agent retrieve EC2
 * job outputs from S3 (per the Phase 1 design note: EC2 writes outputs
 * to S3 from inside the user script; the agent / user retrieves them
 * via these tools — no SCP-back-of-artifacts is needed).
 *
 *   s3_download       — copy an object into the workspace
 *   s3_list           — list prefixes / keys under a bucket
 *   s3_presigned_url  — mint a time-limited HTTPS URL for a key
 *
 * Mutation tools (upload / copy / delete) are explicitly DEFERRED to
 * Phase 2 — the Phase 1 flow is "EC2 writes, agent reads".
 *
 * All three tools source credentials from AwsCredentialProvider so the
 * Settings UI is the single configuration surface (RFC-009 §3.1).
 * Per-call `region` override is supported on every tool because real
 * workflows are cross-region (bucket in eu-central-1, EC2 in
 * us-east-1, etc.) — see RFC-009 §3.2.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError } from './tool-utils.js'
import type { AwsCredentialProvider } from '../aws/credentials.js'
import { toSdkCredentials } from '../aws/credentials.js'

// ---------------------------------------------------------------------------
// Context — what the factory needs from the caller
// ---------------------------------------------------------------------------

export interface S3ToolsContext {
  workspacePath: string
  credentialProvider: AwsCredentialProvider
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an `s3://bucket/key` URI or accept already-split bucket+key
 * parameters. Returns the resolved pair, or throws on bad input.
 */
function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith('s3://')) {
    throw new Error('S3 URIs must start with "s3://"')
  }
  const rest = uri.slice('s3://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error('S3 URI must be "s3://<bucket>/<key>"')
  }
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) }
}

function resolveBucketKey(params: Record<string, unknown>): { bucket: string; key: string } {
  const uri = typeof params.uri === 'string' ? params.uri.trim() : ''
  if (uri) return parseS3Uri(uri)
  const bucket = typeof params.bucket === 'string' ? params.bucket.trim() : ''
  const key = typeof params.key === 'string' ? params.key.trim() : ''
  if (!bucket || !key) {
    throw new Error('Provide either "uri" (s3://bucket/key) or both "bucket" and "key".')
  }
  return { bucket, key }
}

function safeOutputPath(workspacePath: string, requested: string): string {
  // Resolve and ensure the destination stays inside the workspace.
  // Defensive: an agent-supplied path that escapes the workspace via
  // `..` is rejected up front. Absolute paths inside the workspace are
  // allowed; absolute paths outside it are not.
  const abs = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspacePath, requested)
  const wsAbs = path.resolve(workspacePath)
  const rel = path.relative(wsAbs, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Destination "${requested}" must stay inside the workspace (${wsAbs}).`)
  }
  return abs
}

async function streamToFile(body: unknown, destPath: string): Promise<number> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
  // S3 SDK v3's GetObject `Body` is a Readable in Node; in unit tests it
  // may be a Buffer. Accept both.
  if (body instanceof Uint8Array) {
    await fs.promises.writeFile(destPath, body)
    return body.byteLength
  }
  if (body && typeof (body as Readable).pipe === 'function') {
    const stream = body as Readable
    const out = fs.createWriteStream(destPath)
    let bytes = 0
    return await new Promise<number>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => { bytes += chunk.length })
      stream.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => resolve(bytes))
      stream.pipe(out)
    })
  }
  throw new Error('S3 GetObject returned an unexpected Body type')
}

function classifyAwsError(err: unknown): {
  code: 'AWS_AUTH_FAILED' | 'AWS_ACCESS_DENIED' | 'AWS_NOT_FOUND' | 'AWS_REGION_MISMATCH' | 'API_ERROR'
  message: string
} {
  const message = err instanceof Error ? err.message : String(err)
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'NoSuchKey' || name === 'NoSuchBucket' || /NotFound|does not exist/i.test(message)) {
    return { code: 'AWS_NOT_FOUND', message }
  }
  if (name === 'AccessDenied' || /AccessDenied|Forbidden/i.test(message)) {
    return { code: 'AWS_ACCESS_DENIED', message }
  }
  if (/PermanentRedirect|wrong region|wrong endpoint/i.test(message)) {
    return { code: 'AWS_REGION_MISMATCH', message }
  }
  if (name === 'InvalidAccessKeyId' || /SignatureDoesNotMatch|InvalidAccessKeyId|ExpiredToken/i.test(message)) {
    return { code: 'AWS_AUTH_FAILED', message }
  }
  return { code: 'API_ERROR', message }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const S3DownloadSchema = Type.Object({
  uri: Type.Optional(Type.String({ description: 'Full S3 URI in the form s3://bucket/key. Mutually exclusive with bucket+key.' })),
  bucket: Type.Optional(Type.String({ description: 'Bucket name. Required if uri is not given.' })),
  key: Type.Optional(Type.String({ description: 'Object key. Required if uri is not given.' })),
  output_path: Type.Optional(Type.String({ description: 'Workspace-relative destination path. Defaults to s3-downloads/<basename>.' })),
  region: Type.Optional(Type.String({ description: 'Override the default region for this call (e.g., the bucket lives elsewhere).' })),
})

const S3ListSchema = Type.Object({
  bucket: Type.String({ description: 'Bucket name to list.' }),
  prefix: Type.Optional(Type.String({ description: 'Prefix filter (e.g., "runs/2026-05-18/"). Empty lists the bucket root.' })),
  max_keys: Type.Optional(Type.Number({ description: 'Cap on objects returned (1-1000). Pagination via continuation_token.', minimum: 1, maximum: 1000 })),
  continuation_token: Type.Optional(Type.String({ description: 'Token returned by a prior call to fetch the next page.' })),
  delimiter: Type.Optional(Type.String({ description: 'Group keys by a separator (e.g., "/" to enumerate folders).' })),
  region: Type.Optional(Type.String({ description: 'Override the default region.' })),
})

const S3PresignedSchema = Type.Object({
  uri: Type.Optional(Type.String({ description: 'Full S3 URI s3://bucket/key. Mutually exclusive with bucket+key.' })),
  bucket: Type.Optional(Type.String({ description: 'Bucket name. Required if uri is not given.' })),
  key: Type.Optional(Type.String({ description: 'Object key. Required if uri is not given.' })),
  expires_in_seconds: Type.Optional(Type.Number({ description: 'URL lifetime, 60-604800 s (default 3600).', minimum: 60, maximum: 604_800 })),
  region: Type.Optional(Type.String({ description: 'Override the default region.' })),
})

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function buildS3Client(ctx: S3ToolsContext, regionOverride?: string) {
  const resolution = ctx.credentialProvider.resolve(regionOverride ? { region: regionOverride } : undefined)
  return {
    resolution,
    factory: async () => {
      const { S3Client } = await import('@aws-sdk/client-s3')
      return new S3Client({
        region: regionOverride ?? resolution.credentials.region,
        credentials: toSdkCredentials(resolution.credentials),
      })
    },
  }
}

export function createS3DownloadTool(ctx: S3ToolsContext): AgentTool {
  return {
    name: 's3_download',
    label: 'S3 Download',
    description:
      'Download an S3 object into the workspace. Use this to retrieve outputs an EC2 job uploaded to S3. ' +
      'Provide either "uri" (s3://bucket/key) or both "bucket" and "key". ' +
      'Set "output_path" to control the destination (workspace-relative); defaults to s3-downloads/<basename>.',
    parameters: S3DownloadSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      let bucket: string, key: string
      try {
        ({ bucket, key } = resolveBucketKey(params))
      } catch (err) {
        return toAgentResult('s3_download', toolError('MISSING_PARAMETER', err instanceof Error ? err.message : String(err), {
          suggestions: ['Pass "uri" like "s3://my-bucket/runs/abc/output.json", or pass both "bucket" and "key".'],
        }))
      }

      const outRequested =
        typeof params.output_path === 'string' && params.output_path.trim()
          ? params.output_path.trim()
          : path.join('s3-downloads', path.basename(key))
      let destPath: string
      try {
        destPath = safeOutputPath(ctx.workspacePath, outRequested)
      } catch (err) {
        return toAgentResult('s3_download', toolError('PATH_OUTSIDE_WORKSPACE', err instanceof Error ? err.message : String(err)))
      }

      try {
        const { factory } = buildS3Client(ctx, typeof params.region === 'string' ? params.region : undefined)
        const client = await factory()
        const { GetObjectCommand } = await import('@aws-sdk/client-s3')
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const bytes = await streamToFile(resp.Body, destPath)
        const rel = path.relative(ctx.workspacePath, destPath)
        return toAgentResult('s3_download', {
          success: true,
          data: {
            bucket,
            key,
            output_path: rel,
            absolute_path: destPath,
            bytes,
            content_type: resp.ContentType,
            etag: resp.ETag,
            last_modified: resp.LastModified?.toISOString(),
          },
        })
      } catch (err) {
        const classified = classifyAwsError(err)
        return toAgentResult('s3_download', toolError(
          classified.code === 'AWS_NOT_FOUND' ? 'NOT_FOUND' :
          classified.code === 'AWS_ACCESS_DENIED' ? 'API_ERROR' : 'API_ERROR',
          classified.message,
          {
            retryable: classified.code === 'API_ERROR',
            suggestions: suggestionFor(classified.code, bucket, key),
            context: { bucket, key, aws_error: classified.code },
          },
        ))
      }
    },
  }
}

export function createS3ListTool(ctx: S3ToolsContext): AgentTool {
  return {
    name: 's3_list',
    label: 'S3 List',
    description:
      'List objects in an S3 bucket under an optional prefix. Returns up to max_keys (default 100). ' +
      'When the response is truncated, use the returned continuation_token to fetch the next page. ' +
      'Pass delimiter="/" to enumerate "folders" instead of full keys.',
    parameters: S3ListSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const bucket = typeof params.bucket === 'string' ? params.bucket.trim() : ''
      if (!bucket) {
        return toAgentResult('s3_list', toolError('MISSING_PARAMETER', 'Missing bucket.', {
          suggestions: ['Pass "bucket" with the bucket name (no s3:// prefix).'],
        }))
      }
      const prefix = typeof params.prefix === 'string' ? params.prefix : ''
      const maxKeysRaw = typeof params.max_keys === 'number' && Number.isFinite(params.max_keys) ? params.max_keys : 100
      const maxKeys = Math.max(1, Math.min(1000, Math.floor(maxKeysRaw)))
      const continuationToken = typeof params.continuation_token === 'string' ? params.continuation_token : undefined
      const delimiter = typeof params.delimiter === 'string' ? params.delimiter : undefined

      try {
        const { factory } = buildS3Client(ctx, typeof params.region === 'string' ? params.region : undefined)
        const client = await factory()
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
        const resp = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken,
          Delimiter: delimiter,
        }))
        return toAgentResult('s3_list', {
          success: true,
          data: {
            bucket,
            prefix,
            delimiter,
            is_truncated: resp.IsTruncated ?? false,
            next_continuation_token: resp.NextContinuationToken,
            key_count: resp.KeyCount ?? 0,
            common_prefixes: (resp.CommonPrefixes ?? [])
              .map((p) => p.Prefix)
              .filter((p): p is string => !!p),
            objects: (resp.Contents ?? []).map((o) => ({
              key: o.Key,
              size: o.Size,
              last_modified: o.LastModified?.toISOString(),
              etag: o.ETag,
              storage_class: o.StorageClass,
            })),
          },
        })
      } catch (err) {
        const classified = classifyAwsError(err)
        return toAgentResult('s3_list', toolError(
          classified.code === 'AWS_NOT_FOUND' ? 'NOT_FOUND' : 'API_ERROR',
          classified.message,
          {
            retryable: classified.code === 'API_ERROR',
            suggestions: suggestionFor(classified.code, bucket, prefix),
            context: { bucket, prefix, aws_error: classified.code },
          },
        ))
      }
    },
  }
}

export function createS3PresignedUrlTool(ctx: S3ToolsContext): AgentTool {
  return {
    name: 's3_presigned_url',
    label: 'S3 Pre-signed URL',
    description:
      'Mint a time-limited HTTPS URL for an S3 object. Useful to hand a download link to a human or paste into a notebook. ' +
      'Default lifetime 1 hour, max 7 days. The URL works without AWS credentials until it expires.',
    parameters: S3PresignedSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      let bucket: string, key: string
      try {
        ({ bucket, key } = resolveBucketKey(params))
      } catch (err) {
        return toAgentResult('s3_presigned_url', toolError('MISSING_PARAMETER', err instanceof Error ? err.message : String(err)))
      }
      const expiresRaw =
        typeof params.expires_in_seconds === 'number' && Number.isFinite(params.expires_in_seconds)
          ? params.expires_in_seconds
          : 3600
      const expiresIn = Math.max(60, Math.min(604_800, Math.floor(expiresRaw)))

      try {
        const { factory } = buildS3Client(ctx, typeof params.region === 'string' ? params.region : undefined)
        const client = await factory()
        const { GetObjectCommand } = await import('@aws-sdk/client-s3')
        const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
        const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
        return toAgentResult('s3_presigned_url', {
          success: true,
          data: {
            bucket,
            key,
            url,
            expires_in_seconds: expiresIn,
            expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          },
        })
      } catch (err) {
        const classified = classifyAwsError(err)
        return toAgentResult('s3_presigned_url', toolError('API_ERROR', classified.message, {
          retryable: false,
          suggestions: suggestionFor(classified.code, bucket, key),
          context: { bucket, key, aws_error: classified.code },
        }))
      }
    },
  }
}

function suggestionFor(
  code: 'AWS_AUTH_FAILED' | 'AWS_ACCESS_DENIED' | 'AWS_NOT_FOUND' | 'AWS_REGION_MISMATCH' | 'API_ERROR',
  bucketOrKey1: string,
  bucketOrKey2: string,
): string[] {
  switch (code) {
    case 'AWS_AUTH_FAILED':
      return [
        'Open Settings → Compute → AWS and re-check the access key / secret.',
        'Verify the keys are not expired or rotated.',
      ]
    case 'AWS_ACCESS_DENIED':
      return [
        `The IAM principal can authenticate but lacks permission for "${bucketOrKey1}/${bucketOrKey2}".`,
        'Confirm the bucket policy or IAM policy grants s3:GetObject / s3:ListBucket on this resource.',
      ]
    case 'AWS_NOT_FOUND':
      return [
        `No such bucket or key — confirm "${bucketOrKey1}" and "${bucketOrKey2}" are spelled correctly.`,
        'Use s3_list to enumerate available keys under the prefix.',
      ]
    case 'AWS_REGION_MISMATCH':
      return [
        `Bucket "${bucketOrKey1}" is in a different region than the credentials default.`,
        'Pass an explicit "region" parameter matching the bucket location.',
      ]
    default:
      return ['Retry the call; if it persists, check the AWS Service Health Dashboard.']
  }
}

/**
 * Factory: assemble all S3 tools and return as an AgentTool[].
 * Mirrors createWebSearchTool / createWebFetchTool's calling convention.
 */
export function createS3Tools(ctx: S3ToolsContext): AgentTool[] {
  return [
    createS3DownloadTool(ctx),
    createS3ListTool(ctx),
    createS3PresignedUrlTool(ctx),
  ]
}
