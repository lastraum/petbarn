#!/usr/bin/env node
/**
 * Parcel allocator for petbarn multi-scene world.
 *
 * Bounds: inclusive [-150, 150] × [-150, 150]  (301 × 301 slots)
 * Order:  start -150,-150; fill x left→right, then y bottom→top
 *         (-150,-150) → (-149,-150) → … → (150,-150) → (-150,-149) → …
 *
 * Usage: node scripts/next-parcel.mjs
 */
import { readCatalog } from './lib.mjs'

/** Inclusive world parcel bounds (DCL Worlds multi-scene grid). */
export const PARCEL_MIN = -150
export const PARCEL_MAX = 150

export const FIRST_PARCEL = { x: PARCEL_MIN, y: PARCEL_MIN }

export function inBounds(parcel) {
  if (!parcel || typeof parcel.x !== 'number' || typeof parcel.y !== 'number') return false
  return (
    parcel.x >= PARCEL_MIN &&
    parcel.x <= PARCEL_MAX &&
    parcel.y >= PARCEL_MIN &&
    parcel.y <= PARCEL_MAX
  )
}

export function parcelString(parcel) {
  return `${parcel.x},${parcel.y}`
}

/**
 * Next cell after `parcel` in row-major order, or null if past the last cell.
 * Does not skip occupied parcels — use computeNextParcel for free slots.
 */
export function advanceNextParcel(parcel) {
  if (!inBounds(parcel)) return null
  let { x, y } = parcel
  x += 1
  if (x > PARCEL_MAX) {
    x = PARCEL_MIN
    y += 1
  }
  if (y > PARCEL_MAX) return null
  return { x, y }
}

function usedParcelSet(catalog) {
  return new Set((catalog.pets || []).map((p) => p.parcel).filter(Boolean))
}

/**
 * First free parcel in scan order, preferring catalog.nextParcel if free & in-bounds.
 */
export function computeNextParcel(catalog) {
  const used = usedParcelSet(catalog)

  // Fast path: catalog pointer is free and valid.
  const hinted = catalog.nextParcel
  if (
    hinted &&
    typeof hinted.x === 'number' &&
    typeof hinted.y === 'number' &&
    inBounds(hinted) &&
    !used.has(parcelString(hinted))
  ) {
    return { x: hinted.x | 0, y: hinted.y | 0 }
  }

  // Full scan from SW corner (handles holes after unpublish later).
  for (let y = PARCEL_MIN; y <= PARCEL_MAX; y++) {
    for (let x = PARCEL_MIN; x <= PARCEL_MAX; x++) {
      const key = `${x},${y}`
      if (!used.has(key)) return { x, y }
    }
  }

  throw new Error(
    `Pet Barn world is full: no free parcels in [${PARCEL_MIN},${PARCEL_MIN}]..[${PARCEL_MAX},${PARCEL_MAX}]`
  )
}

/**
 * Value to store as catalog.nextParcel after deploying at `deployed`.
 * Skips occupied slots so the pointer lands on the next free cell (or null if full).
 */
export function nextFreeAfter(deployed, catalog) {
  const used = usedParcelSet(catalog)
  // Treat the just-deployed parcel as occupied even if catalog not yet updated.
  used.add(parcelString(deployed))

  let cursor = advanceNextParcel(deployed)
  while (cursor) {
    if (!used.has(parcelString(cursor))) return cursor
    cursor = advanceNextParcel(cursor)
  }
  // Full — store a sentinel past the grid; computeNextParcel will throw on next publish.
  return { x: PARCEL_MAX + 1, y: PARCEL_MAX + 1 }
}

function main() {
  const catalog = readCatalog()
  const next = computeNextParcel(catalog)
  console.log(JSON.stringify(next))
}

const isMain = process.argv[1] && process.argv[1].endsWith('next-parcel.mjs')
if (isMain) main()
