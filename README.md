# petbarn

Public catalog + multi-scene Worlds pipeline for the **Pet Barn** marketplace (`petbarn.dcl.eth`).

Sibling of the Three.js client:

```text
sdk7/
  ThreejsClient/   # client UI + CF Worker dispatch
  petbarn/         # this repo
```

## What this repo does

| Piece | Role |
|---|---|
| `catalog.json` | Shop index (clients poll; **thumbnails + metadata only**) |
| `pets/queue/` | Incoming publish jobs (Worker writes here) |
| `scene-template/` | Minimal SDK7 scene shell per pet |
| `.github/workflows/deploy-pet.yml` | Auto multi-scene deploy → Worlds |

**1 pet = 1 scene = 1 parcel.** GLB ≤ 2 MB, thumbnail ≤ 500 KB.

### Parcel grid

Inclusive bounds: **`[-150, 150] × [-150, 150]`** (301×301 slots).

| | |
|---|---|
| First slot | `-150,-150` |
| Fill order | `x` left → right, then `y` up one row |
| Example | `-150,-150` → `-149,-150` → … → `150,-150` → `-150,-149` → … → `150,150` |

When the grid is full, deploy fails with a clear error (no wrap outside bounds).

Clients **never** bulk-download GLBs from the shop. They load thumbs from `thumbnailCid`, and download `glbCid` only when the user hits **Add**.

## Update / delete actions

Queue items may carry `action: "update" | "delete"` plus `targetId` (an existing
listing id). Both require `meta.auth` — the client wallet signs (personal_sign):

```text
petbarn:v1:<action>:<targetId>:<glbSha256|none>:<timestampMs>
```

The deploy Action verifies the signature recovers to the listing's `wallet`
(or an address in the `PETBARN_ADMIN_WALLETS` env, comma-separated) and that
the timestamp is within `PETBARN_AUTH_WINDOW_MS` (default 1h). For updates the
signed `glbSha256` must match the uploaded `pet.glb`, binding signature to
content.

Listings with **no `wallet` field** cannot be updated/deleted by an “owner”
signature — only `PETBARN_ADMIN_WALLETS`. Prefer backfilling `catalog.pets[].wallet`
when possible.

### Freshness windows (Worker vs Action)

| Layer | Env | Default | Role |
|-------|-----|---------|------|
| Cloudflare dispatch Worker | `PETBARN_AUTH_MAX_AGE_MS` | **10 min** | Reject stale POSTs before they hit GitHub |
| This deploy Action | `PETBARN_AUTH_WINDOW_MS` | **1 hour** | Allow queue → CI delay after a valid submit |

Keep Action ≥ Worker. If CI is always fast, you may tighten Action toward 10 min.

- **update** — redeploys the listing's existing parcel with the new GLB/thumb
  and rewrites the catalog entry in place (same id/parcel/wallet/submittedAt;
  fresh CIDs, clip data, `deployedAt`, `updatedAt`; `petName` may change).
- **delete** — deploys an empty tombstone scene over the parcel, removes the
  catalog entry, and points `nextParcel` at the freed cell so holes refill
  first (`computeNextParcel`'s full scan picks up any others).

### GitHub Actions env (optional)

| Name | Where | Purpose |
|------|--------|---------|
| `DCL_PRIVATE_KEY` | Secret | Worlds deploy (required for real deploys) |
| `PETBARN_ADMIN_WALLETS` | Variable or secret | Comma-separated `0x…` that may update/delete any listing |
| `PETBARN_AUTH_WINDOW_MS` | Variable | Max \|now − timestampMs\| (default `3600000`) |

## Catalog URL (clients)

```text
https://raw.githubusercontent.com/lastraum/petbarn/main/catalog.json
```

(Adjust owner/repo if different.)

## Local layout

```text
petbarn/
  catalog.json
  pets/queue/<id>/{pet.glb,thumb.webp,meta.json}
  pets/archive/
  scene-template/
  scripts/
  .github/workflows/deploy-pet.yml
```

## Secrets (GitHub Actions)

| Secret | Purpose |
|---|---|
| `DCL_PRIVATE_KEY` | Operator wallet private key with deploy rights on `petbarn.dcl.eth` |

Optional env in workflow:

| Var | Default |
|---|---|
| `PETBARN_WORLD_NAME` | `petbarn.dcl.eth` |
| `PETBARN_TARGET_CONTENT` | `https://worlds-content-server.decentraland.org` |

## Manual smoke test

1. Put files under `pets/queue/test-pet-001/`:
   - `pet.glb` (≤ 2 MB)
   - `thumb.webp` (≤ 500 KB)
   - `meta.json` (see below)
2. Push to `main` (or run `npm run process-queue` with `DCL_PRIVATE_KEY` set).
3. Confirm `catalog.json` gains an entry with `glbCid` + `thumbnailCid`.
4. Fetch:
   - `{contentBaseUrl}{thumbnailCid}`
   - `{contentBaseUrl}{glbCid}`

### `meta.json` example

```json
{
  "id": "test-pet-001",
  "petName": "Spark",
  "creatorName": "lastraum",
  "type": "walking",
  "submittedAt": "2026-07-30T12:00:00.000Z",
  "sizeBytes": 100000,
  "thumbnailSizeBytes": 40000
}
```

## Kill switches

- Disable the **deploy-pet** workflow
- Revoke / rotate `DCL_PRIVATE_KEY`
- Stop the CF publish Worker in the client repo (stops new queue writes)

## Scripts

```bash
npm install
npm run process-queue          # process all pets/queue/*/meta.json
npm run deploy-queue-item -- <id>
```

## Limits

- GLB: **2 MB**
- Thumbnail: **500 KB**
- World storage budget depends on NAME / LAND / MANA holdings (~100 MB base per NAME)
