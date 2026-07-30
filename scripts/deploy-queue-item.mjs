#!/usr/bin/env node
/**
 * Build + deploy one queue item to petbarn.dcl.eth, then update catalog.json.
 *
 * Requires:
 *   DCL_PRIVATE_KEY — operator wallet
 *   scene-template dependencies installed (or installs into deploy-work)
 *
 * Usage: node scripts/deploy-queue-item.mjs <queue-id>
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { hashV1 } from '@dcl/hashing'
import {
  ARCHIVE_DIR,
  CATALOG_PATH,
  TEMPLATE_DIR,
  WORK_ROOT,
  contentServer,
  copyFile,
  ensureDir,
  queueItemDir,
  readCatalog,
  rmrf,
  writeCatalog,
  worldName
} from './lib.mjs'
import { buildPetScene } from './build-pet-scene.mjs'
import { computeNextParcel, nextFreeAfter, parcelString } from './next-parcel.mjs'

async function hashFile(filePath) {
  const buf = fs.readFileSync(filePath)
  // hashV1 expects a readable stream or buffer depending on version — use Blob/stream
  const { Readable } = await import('node:stream')
  const stream = Readable.from(buf)
  return hashV1(stream)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim()
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${err}`)
  }
  return res.stdout
}

function ensureTemplateDeps() {
  const nm = path.join(TEMPLATE_DIR, 'node_modules', '@dcl', 'sdk')
  if (fs.existsSync(nm)) return
  console.log('[petbarn] Installing scene-template dependencies…')
  run('npm', ['install'], { cwd: TEMPLATE_DIR, stdio: 'inherit' })
}

function linkNodeModules(workDir) {
  const target = path.join(workDir, 'node_modules')
  const source = path.join(TEMPLATE_DIR, 'node_modules')
  if (fs.existsSync(target)) return
  ensureTemplateDeps()
  fs.symlinkSync(source, target, 'junction')
}

export async function deployQueueItem(id, options = {}) {
  const dryRun = options.dryRun === true || process.env.PETBARN_DRY_RUN === '1'
  const qDir = queueItemDir(id)
  if (!fs.existsSync(path.join(qDir, 'meta.json'))) {
    throw new Error(`Queue item not found: ${id}`)
  }

  const catalog = readCatalog()
  if ((catalog.pets || []).some((p) => p.id === id)) {
    console.log(`[petbarn] ${id} already in catalog — skipping deploy`)
    return { skipped: true, id }
  }

  let parcel
  try {
    parcel = computeNextParcel(catalog)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  console.log(`[petbarn] Allocating parcel ${parcelString(parcel)} for ${id}`)
  const workDir = path.join(WORK_ROOT, id)
  const built = await buildPetScene(id, parcel, workDir)

  const glbAbs = path.join(workDir, built.glbFile)
  const thumbAbs = path.join(workDir, built.thumbFile)
  const glbCid = await hashFile(glbAbs)
  const thumbnailCid = await hashFile(thumbAbs)

  if (!dryRun) {
    if (!process.env.DCL_PRIVATE_KEY) {
      throw new Error('DCL_PRIVATE_KEY is required for deploy (or set PETBARN_DRY_RUN=1)')
    }
    linkNodeModules(workDir)
    console.log(`[petbarn] Building scene for ${id} @ ${built.parcel}…`)
    run('npx', ['sdk-commands', 'build'], { cwd: workDir, stdio: 'inherit', env: process.env })
    console.log(`[petbarn] Deploying ${id} → ${worldName()} (${contentServer()})…`)
    run(
      'npx',
      [
        'sdk-commands',
        'deploy',
        '--skip-validations',
        '--skip-build',
        '--yes',
        '--multi-scene',
        '--target-content',
        contentServer()
      ],
      { cwd: workDir, stdio: 'inherit', env: process.env }
    )
  } else {
    console.log(`[petbarn] DRY RUN — would deploy ${id} @ ${built.parcel}`)
  }

  const now = new Date().toISOString()
  const entry = {
    id: built.id,
    petName: built.petName,
    creatorName: built.creatorName,
    type: built.type,
    animationCount: built.animationCount,
    clipNames: built.clipNames,
    parcel: built.parcel,
    glbFile: built.glbFile,
    glbCid,
    thumbnailFile: built.thumbFile,
    thumbnailCid,
    sizeBytes: built.glbSize,
    thumbnailSizeBytes: built.thumbSize,
    submittedAt: built.meta.submittedAt || now,
    deployedAt: now,
    wallet: built.meta.wallet || undefined
  }

  const nextCatalog = readCatalog()
  nextCatalog.pets = [...(nextCatalog.pets || []).filter((p) => p.id !== entry.id), entry]
  // After adding this pet, point at the next free cell within [-150,150]²
  nextCatalog.nextParcel = nextFreeAfter(parcel, nextCatalog)
  nextCatalog.updatedAt = now
  nextCatalog.world = worldName()
  nextCatalog.contentBaseUrl =
    nextCatalog.contentBaseUrl || `${contentServer().replace(/\/$/, '')}/contents/`
  writeCatalog(nextCatalog)

  // archive meta (keep small); drop binaries from queue
  const archDir = path.join(ARCHIVE_DIR, id)
  ensureDir(archDir)
  copyFile(path.join(qDir, 'meta.json'), path.join(archDir, 'meta.json'))
  fs.writeFileSync(
    path.join(archDir, 'deploy.json'),
    JSON.stringify({ entry, dryRun }, null, 2) + '\n',
    'utf8'
  )
  rmrf(qDir)
  rmrf(workDir)

  console.log(`[petbarn] Catalog updated: ${entry.id} parcel=${entry.parcel}`)
  console.log(`  glbCid=${glbCid}`)
  console.log(`  thumbnailCid=${thumbnailCid}`)
  console.log(`  catalog: ${CATALOG_PATH}`)
  return { skipped: false, entry }
}

async function main() {
  const id = process.argv[2]
  if (!id) {
    console.error('Usage: node scripts/deploy-queue-item.mjs <queue-id>')
    process.exit(1)
  }
  await deployQueueItem(id)
}

const isMain = process.argv[1] && process.argv[1].endsWith('deploy-queue-item.mjs')
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
