#!/usr/bin/env node
/**
 * Read catalog.json and print next free parcel JSON: { "x": n, "y": 0 }
 * Usage: node scripts/next-parcel.mjs
 */
import { readCatalog } from './lib.mjs'

export function computeNextParcel(catalog) {
  if (catalog.nextParcel && typeof catalog.nextParcel.x === 'number') {
    return {
      x: catalog.nextParcel.x | 0,
      y: (catalog.nextParcel.y | 0) || 0
    }
  }
  const used = new Set((catalog.pets || []).map((p) => p.parcel).filter(Boolean))
  let x = 0
  while (used.has(`${x},0`)) x += 1
  return { x, y: 0 }
}

export function advanceNextParcel(parcel) {
  return { x: parcel.x + 1, y: parcel.y }
}

export function parcelString(parcel) {
  return `${parcel.x},${parcel.y}`
}

function main() {
  const catalog = readCatalog()
  const next = computeNextParcel(catalog)
  console.log(JSON.stringify(next))
}

const isMain = process.argv[1] && process.argv[1].endsWith('next-parcel.mjs')
if (isMain) main()
