#!/usr/bin/env node
/**
 * Materialize a deployable scene folder for one queue item.
 * Usage: node scripts/build-pet-scene.mjs <queue-id> <parcelX> <parcelY> [out-dir]
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_GLB_BYTES,
  MAX_THUMB_BYTES,
  TEMPLATE_DIR,
  VALID_TYPES,
  WORK_ROOT,
  assertFileSize,
  copyFile,
  ensureDir,
  findThumbFile,
  queueItemDir,
  readMeta,
  rmrf,
  worldName
} from './lib.mjs'
import { extractAnimsFromGlb } from './extract-anims.mjs'
import { parcelString } from './next-parcel.mjs'

export async function buildPetScene(id, parcel, outDir) {
  const qDir = queueItemDir(id)
  const meta = readMeta(id)
  const glbPath = path.join(qDir, 'pet.glb')
  if (!fs.existsSync(glbPath)) throw new Error(`Missing pet.glb for ${id}`)

  const thumb = findThumbFile(qDir)
  if (!thumb) throw new Error(`Missing thumbnail (thumb.webp|jpg|png) for ${id}`)

  const glbSize = assertFileSize(glbPath, MAX_GLB_BYTES, 'pet.glb')
  const thumbSize = assertFileSize(thumb.full, MAX_THUMB_BYTES, thumb.name)

  const petName = String(meta.petName || '').trim()
  const creatorName = String(meta.creatorName || '').trim()
  const type = String(meta.type || 'walking').trim()
  if (!petName) throw new Error('meta.petName required')
  if (!creatorName) throw new Error('meta.creatorName required')
  if (!VALID_TYPES.has(type)) throw new Error(`meta.type must be walking|flying, got ${type}`)

  const anims = await extractAnimsFromGlb(glbPath)
  const parcelStr = parcelString(parcel)

  rmrf(outDir)
  ensureDir(outDir)

  // copy template (except node_modules / bin)
  copyTree(TEMPLATE_DIR, outDir, new Set(['node_modules', 'bin', '.decentraland']))

  const modelsDir = path.join(outDir, 'models')
  ensureDir(modelsDir)
  copyFile(glbPath, path.join(modelsDir, 'pet.glb'))
  const thumbDestName = thumb.name.toLowerCase().startsWith('thumb.')
    ? thumb.name.toLowerCase()
    : 'thumb.webp'
  copyFile(thumb.full, path.join(modelsDir, thumbDestName))

  const scenePath = path.join(outDir, 'scene.json')
  const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'))
  scene.display = scene.display || {}
  scene.display.title = `Pet: ${petName}`
  scene.display.description = `${petName} by ${creatorName} (${type})`
  scene.display.navmapThumbnail = `models/${thumbDestName}`
  scene.scene = { parcels: [parcelStr], base: parcelStr }
  scene.worldConfiguration = {
    name: worldName(),
    placesConfig: { optOut: true }
  }
  scene.petBarn = {
    id: meta.id || id,
    petName,
    creatorName,
    type,
    animationCount: anims.animationCount,
    clipNames: anims.clipNames
  }
  fs.writeFileSync(scenePath, JSON.stringify(scene, null, 2) + '\n', 'utf8')

  // symlink or note: consumer should npm install in outDir or reuse template node_modules
  return {
    outDir,
    id: meta.id || id,
    petName,
    creatorName,
    type,
    parcel: parcelStr,
    parcelObj: parcel,
    glbSize,
    thumbSize,
    thumbFile: `models/${thumbDestName}`,
    glbFile: 'models/pet.glb',
    animationCount: anims.animationCount,
    clipNames: anims.clipNames,
    meta
  }
}

function copyTree(src, dest, skipNames) {
  ensureDir(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    if (entry.name === '.DS_Store') continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to, skipNames)
    else copyFile(from, to)
  }
}

async function main() {
  const id = process.argv[2]
  const x = Number(process.argv[3])
  const y = Number(process.argv[4] ?? 0)
  const out = process.argv[5] || path.join(WORK_ROOT, id)
  if (!id || Number.isNaN(x)) {
    console.error('Usage: node scripts/build-pet-scene.mjs <queue-id> <x> [y] [out-dir]')
    process.exit(1)
  }
  const built = await buildPetScene(id, { x, y }, out)
  console.log(JSON.stringify(built, null, 2))
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-pet-scene.mjs')
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
