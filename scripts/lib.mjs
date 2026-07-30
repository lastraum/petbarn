import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CATALOG_PATH = path.join(ROOT, 'catalog.json')
export const QUEUE_DIR = path.join(ROOT, 'pets', 'queue')
export const ARCHIVE_DIR = path.join(ROOT, 'pets', 'archive')
export const TEMPLATE_DIR = path.join(ROOT, 'scene-template')
export const WORK_ROOT = path.join(ROOT, 'deploy-work')

export const MAX_GLB_BYTES = 2 * 1024 * 1024
export const MAX_THUMB_BYTES = 500 * 1024
export const VALID_TYPES = new Set(['walking', 'flying'])

export function readCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8')
  return JSON.parse(raw)
}

export function writeCatalog(catalog) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
}

export function queueItemDir(id) {
  return path.join(QUEUE_DIR, id)
}

export function readMeta(id) {
  const p = path.join(queueItemDir(id), 'meta.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function listQueueIds() {
  if (!fs.existsSync(QUEUE_DIR)) return []
  return fs
    .readdirSync(QUEUE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => fs.existsSync(path.join(QUEUE_DIR, id, 'meta.json')))
    .sort()
}

export function findThumbFile(dir) {
  const names = ['thumb.webp', 'thumb.jpg', 'thumb.jpeg', 'thumb.png']
  for (const name of names) {
    const full = path.join(dir, name)
    if (fs.existsSync(full)) return { name, full }
  }
  // any thumb.* image
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    if (/^thumb\.(webp|jpe?g|png)$/i.test(f)) {
      return { name: f.toLowerCase(), full: path.join(dir, f) }
    }
  }
  return null
}

export function assertFileSize(filePath, maxBytes, label) {
  const st = fs.statSync(filePath)
  if (st.size > maxBytes) {
    throw new Error(`${label} is ${st.size} bytes (max ${maxBytes})`)
  }
  return st.size
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function copyFile(src, dest) {
  ensureDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

export function worldName() {
  return process.env.PETBARN_WORLD_NAME || 'petbarn.dcl.eth'
}

export function contentServer() {
  return process.env.PETBARN_TARGET_CONTENT || 'https://worlds-content-server.decentraland.org'
}
