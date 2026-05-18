/**
 * Unit tests for normalizeImageInspection.
 *
 * The full runPlanAgent flow needs a working sub-agent; that's covered
 * by integration tests in §8.2 of RFC-008. Here we pin the normalization
 * logic that maps the LLM's JSON output into the typed
 * ModalImageInspection shape — the boundary where a malformed LLM
 * response would otherwise crash downstream rendering.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageInspection } from '../plan-agent.js'

test('normalize: default-image case adds the missing warning automatically', () => {
  const img = normalizeImageInspection({ source: 'modal_default' })
  assert.equal(img.source, 'modal_default')
  assert.equal(img.baseImage, 'Modal default image')
  assert.equal(img.pythonVersion, null)
  assert.deepEqual(img.pythonPackages, [])
  assert.deepEqual(img.pythonPackageInstallers, [])
  assert.deepEqual(img.systemPackages, [])
  assert.deepEqual(img.envVars, [])
  assert.deepEqual(img.localDirs, [])
  assert.equal(img.gpuType, null)
  assert.equal(img.runtimeGpuType, null)
  assert.equal(img.buildGpuType, null)
  assert.equal(img.forceBuild, false)
  assert.ok(img.warnings.some(w => w.includes('No explicit Modal image')))
})

test('normalize: unknown source maps to "unknown" baseImage', () => {
  const img = normalizeImageInspection({ source: 'something-bad' })
  assert.equal(img.source, 'unknown')
  assert.equal(img.baseImage, 'unknown')
})

test('normalize: missing input becomes safe defaults (no crash on undefined)', () => {
  const img = normalizeImageInspection(undefined)
  assert.equal(img.source, 'unknown')
  assert.equal(img.baseImage, 'unknown')
  assert.deepEqual(img.pythonPackages, [])
  assert.deepEqual(img.warnings, [])
  assert.equal(img.forceBuild, false)
})

test('normalize: preserves package specifiers exactly', () => {
  const img = normalizeImageInspection({
    source: 'script',
    baseImage: 'modal.Image.debian_slim(python_version="3.11")',
    pythonPackages: ['torch==2.8.0', 'pandas>=2', 'numpy~=1.26'],
  })
  assert.deepEqual(img.pythonPackages, ['torch==2.8.0', 'pandas>=2', 'numpy~=1.26'])
})

test('normalize: filters out non-string entries from arrays', () => {
  const img = normalizeImageInspection({
    source: 'script',
    pythonPackages: ['torch', 42, null, undefined, { not: 'a string' }, 'numpy'],
  })
  assert.deepEqual(img.pythonPackages, ['torch', 'numpy'])
})

test('normalize: only accepts known package installer values', () => {
  const img = normalizeImageInspection({
    source: 'script',
    pythonPackageInstallers: ['uv_pip_install', 'pip_install', 'unknown_installer', 'micromamba_install'],
  })
  assert.deepEqual(img.pythonPackageInstallers, ['uv_pip_install', 'pip_install', 'micromamba_install'])
})

test('normalize: forceBuild requires strict-equal true (no truthy values)', () => {
  assert.equal(normalizeImageInspection({ forceBuild: true }).forceBuild, true)
  assert.equal(normalizeImageInspection({ forceBuild: 'true' }).forceBuild, false)
  assert.equal(normalizeImageInspection({ forceBuild: 1 }).forceBuild, false)
  assert.equal(normalizeImageInspection({ forceBuild: undefined }).forceBuild, false)
})

test('normalize: GPU type is nullable string (empty → null)', () => {
  const img = normalizeImageInspection({
    source: 'script',
    gpuType: 'A100',
    runtimeGpuType: '   ',
    buildGpuType: '',
  })
  assert.equal(img.gpuType, 'A100')
  assert.equal(img.runtimeGpuType, null)
  assert.equal(img.buildGpuType, null)
})

test('normalize: reasoning defaults to empty string when missing', () => {
  assert.equal(normalizeImageInspection({}).reasoning, '')
  assert.equal(normalizeImageInspection({ reasoning: 'because' }).reasoning, 'because')
})

test('normalize: existing warnings are preserved, not duplicated by the default-image branch', () => {
  const img = normalizeImageInspection({
    source: 'modal_default',
    warnings: ['user already noted this', 'and this'],
  })
  // Default-image-warning was NOT added because warnings is non-empty.
  assert.equal(img.warnings.length, 2)
})
