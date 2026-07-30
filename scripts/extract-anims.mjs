#!/usr/bin/env node
/**
 * Extract animation clip count + names from a pet GLB.
 * Usage: node scripts/extract-anims.mjs <path-to.glb>
 * Prints JSON: { animationCount, clipNames }
 */
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'

export async function extractAnimsFromGlb(glbPath) {
  const io = new NodeIO()
  const bytes = fs.readFileSync(glbPath)
  const doc = await io.readBinary(new Uint8Array(bytes))
  const root = doc.getRoot()
  const animations = root.listAnimations()
  const clipNames = []
  for (const anim of animations) {
    const name = (anim.getName() || '').trim()
    if (name) clipNames.push(name)
    else clipNames.push(`clip_${clipNames.length}`)
  }
  // unique preserve order
  const seen = new Set()
  const unique = []
  for (const n of clipNames) {
    if (seen.has(n)) continue
    seen.add(n)
    unique.push(n)
  }
  return {
    animationCount: animations.length,
    clipNames: unique
  }
}

async function main() {
  const glbPath = process.argv[2]
  if (!glbPath) {
    console.error('Usage: node scripts/extract-anims.mjs <path-to.glb>')
    process.exit(1)
  }
  if (!fs.existsSync(glbPath)) {
    console.error('File not found:', glbPath)
    process.exit(1)
  }
  const result = await extractAnimsFromGlb(glbPath)
  console.log(JSON.stringify(result, null, 2))
}

const isMain = process.argv[1] && process.argv[1].endsWith('extract-anims.mjs')
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
