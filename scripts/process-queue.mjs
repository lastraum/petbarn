#!/usr/bin/env node
/**
 * Process all pets/queue/<id>/meta.json entries serially.
 * Usage: node scripts/process-queue.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { listQueueIds, queueItemDir } from './lib.mjs'
import { deployQueueItem } from './deploy-queue-item.mjs'

async function main() {
  const ids = listQueueIds()
  if (ids.length === 0) {
    console.log('[petbarn] Queue empty — nothing to do')
    return
  }
  console.log(`[petbarn] Processing ${ids.length} queue item(s): ${ids.join(', ')}`)
  const results = []
  for (const id of ids) {
    try {
      const r = await deployQueueItem(id)
      results.push({ id, ok: true, ...r })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[petbarn] FAILED ${id}:`, message)
      const errPath = path.join(queueItemDir(id), 'error.json')
      fs.writeFileSync(
        errPath,
        JSON.stringify({ id, error: message, at: new Date().toISOString() }, null, 2) + '\n',
        'utf8'
      )
      results.push({ id, ok: false, error: message })
      // continue remaining? for open marketplace, fail one shouldn't block others
      // but parcel order: if we fail mid-way, next items still get next parcels from catalog
    }
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.error(`[petbarn] ${failed.length} failure(s)`)
    process.exit(1)
  }
  console.log('[petbarn] Queue processing complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
