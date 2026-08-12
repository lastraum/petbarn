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
import crypto from 'node:crypto'
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
  readMeta,
  rmrf,
  writeCatalog,
  worldName
} from './lib.mjs'
import { buildPetScene, buildTombstoneScene } from './build-pet-scene.mjs'
import { computeNextParcel, nextFreeAfter, parcelString } from './next-parcel.mjs'
import { verifyActionAuth } from './verify-action.mjs'

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

/** Locate a catalog entry by listing id, or throw. */
function requireTarget(catalog, targetId, action) {
  const target = (catalog.pets || []).find((p) => p.id === targetId)
  if (!target) throw new Error(`${action} target not in catalog: ${targetId}`)
  return target
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** Deploy a scene work dir (build + multi-scene deploy), honoring dry-run. */
function deploySceneDir(id, parcelStr, workDir, dryRun) {
  if (dryRun) {
    console.log(`[petbarn] DRY RUN — would deploy ${id} @ ${parcelStr}`)
    return
  }
  if (!process.env.DCL_PRIVATE_KEY) {
    throw new Error('DCL_PRIVATE_KEY is required for deploy (or set PETBARN_DRY_RUN=1)')
  }
  linkNodeModules(workDir)
  console.log(`[petbarn] Building scene for ${id} @ ${parcelStr}…`)
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
}

function archiveQueueItem(id, qDir, workDir, payload) {
  const archDir = path.join(ARCHIVE_DIR, id)
  ensureDir(archDir)
  copyFile(path.join(qDir, 'meta.json'), path.join(archDir, 'meta.json'))
  fs.writeFileSync(
    path.join(archDir, 'deploy.json'),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8'
  )
  rmrf(qDir)
  if (workDir) rmrf(workDir)
}

function parseParcel(parcelStr) {
  const [x, y] = String(parcelStr).split(',').map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Bad parcel string: ${parcelStr}`)
  }
  return { x, y }
}

/**
 * Replace an existing listing's assets in place: redeploy its parcel with the
 * new GLB/thumbnail, refresh the catalog entry (same id, parcel, wallet,
 * submittedAt). Requires meta.auth signed by the listing wallet or an admin.
 */
async function updateQueueItem(id, meta, dryRun) {
  const qDir = queueItemDir(id)
  const catalog = readCatalog()
  const target = requireTarget(catalog, meta.targetId, 'update')
  const signer = verifyActionAuth('update', meta, target)

  const glbPath = path.join(qDir, 'pet.glb')
  if (!fs.existsSync(glbPath)) throw new Error(`update requires pet.glb (${id})`)
  const actualSha = sha256File(glbPath)
  if ((meta.auth.glbSha256 || '').toLowerCase() !== actualSha) {
    throw new Error(`auth.glbSha256 does not match uploaded pet.glb (${actualSha})`)
  }

  const parcel = parseParcel(target.parcel)
  const workDir = path.join(WORK_ROOT, id)
  const built = await buildPetScene(id, parcel, workDir)

  const glbCid = await hashFile(path.join(workDir, built.glbFile))
  const thumbnailCid = await hashFile(path.join(workDir, built.thumbFile))

  deploySceneDir(id, built.parcel, workDir, dryRun)

  const now = new Date().toISOString()
  const entry = {
    ...target,
    petName: built.petName,
    creatorName: built.creatorName,
    type: built.type,
    animationCount: built.animationCount,
    clipNames: built.clipNames,
    glbFile: built.glbFile,
    glbCid,
    thumbnailFile: built.thumbFile,
    thumbnailCid,
    sizeBytes: built.glbSize,
    thumbnailSizeBytes: built.thumbSize,
    deployedAt: now,
    updatedAt: now
  }
  const nextCatalog = readCatalog()
  nextCatalog.pets = (nextCatalog.pets || []).map((p) => (p.id === target.id ? entry : p))
  nextCatalog.updatedAt = now
  writeCatalog(nextCatalog)

  archiveQueueItem(id, qDir, workDir, {
    action: 'update',
    targetId: target.id,
    authorizedBy: signer,
    entry,
    dryRun
  })
  console.log(`[petbarn] Updated ${target.id} in place @ ${target.parcel} (by ${signer})`)
  return { skipped: false, action: 'update', entry }
}

/**
 * Retire a listing: deploy an empty tombstone scene over its parcel, remove
 * the catalog entry, and point nextParcel at the freed cell so the hole is
 * refilled first.
 *
 * Auth:
 *   - meta.auth signed by the listing wallet or PETBARN_ADMIN_WALLETS, or
 *   - meta.force === true (operator force-delete via git-committed queue item;
 *     write access to main is the trust boundary — the Worker never sets force).
 */
async function deleteQueueItem(id, meta, dryRun) {
  const qDir = queueItemDir(id)
  const catalog = readCatalog()
  // Idempotent delete: a burst of submissions can queue several deletes of the
  // same listing (each push cancels the prior run, so entries accumulate and
  // are processed together later). The first delete wins; the duplicates must
  // archive as no-ops — throwing here fails the whole run, the commit step is
  // skipped, and every already-processed item in the run is rolled back.
  const target = (catalog.pets || []).find((p) => p.id === meta.targetId)
  if (!target) {
    console.warn(`[petbarn] delete ${meta.targetId}: not in catalog — archiving as no-op`)
    archiveQueueItem(id, qDir, null, {
      action: 'delete',
      targetId: meta.targetId,
      noop: true,
      dryRun
    })
    return { skipped: true, action: 'delete', noop: true, targetId: meta.targetId }
  }

  const force = meta.force === true
  let signer
  if (force) {
    // Operator-only: never accept force from the public Worker (it never sets force).
    signer = String(meta.wallet || meta.forcedBy || 'operator-force').trim() || 'operator-force'
    console.warn(
      `[petbarn] FORCE delete ${target.id} (${target.petName}) — skipping signature (by ${signer})`
    )
  } else {
    signer = verifyActionAuth('delete', meta, target)
  }

  const parcel = parseParcel(target.parcel)
  const workDir = path.join(WORK_ROOT, id)
  buildTombstoneScene(parcel, workDir)

  deploySceneDir(id, target.parcel, workDir, dryRun)

  const now = new Date().toISOString()
  const nextCatalog = readCatalog()
  nextCatalog.pets = (nextCatalog.pets || []).filter((p) => p.id !== target.id)
  // Freed cell becomes the next allocation target; further holes are found by
  // computeNextParcel's full scan when the hint is taken.
  nextCatalog.nextParcel = parcel
  nextCatalog.updatedAt = now
  writeCatalog(nextCatalog)

  archiveQueueItem(id, qDir, workDir, {
    action: 'delete',
    targetId: target.id,
    authorizedBy: signer,
    force,
    removedEntry: target,
    dryRun
  })
  console.log(
    `[petbarn] Deleted ${target.id}, freed parcel ${target.parcel} (by ${signer}${force ? ', force' : ''})`
  )
  return { skipped: false, action: 'delete', removed: target.id, force }
}

export async function deployQueueItem(id, options = {}) {
  const dryRun = options.dryRun === true || process.env.PETBARN_DRY_RUN === '1'
  const qDir = queueItemDir(id)
  if (!fs.existsSync(path.join(qDir, 'meta.json'))) {
    throw new Error(`Queue item not found: ${id}`)
  }
  const meta = readMeta(id)
  const action = String(meta.action || 'create')
  if (action === 'update') return updateQueueItem(id, meta, dryRun)
  if (action === 'delete') return deleteQueueItem(id, meta, dryRun)
  if (action !== 'create') throw new Error(`Unknown queue action: ${action}`)

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

  deploySceneDir(id, built.parcel, workDir, dryRun)

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
  archiveQueueItem(id, qDir, workDir, { action: 'create', entry, dryRun })

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
