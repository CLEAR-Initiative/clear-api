# USGS seismic ingest — `GET /api/usgs/earthquakes`

> **Expo #465** (`cmsq40vy00001ju048zgfdci7`) · Related **#466** (ShakeMap intensity)  
> Adapted from [clear-mvp `docs/clear-api-usgs-seismic-ingest.md`](https://github.com/CLEAR-Initiative/clear-mvp/blob/dev/docs/clear-api-usgs-seismic-ingest.md) (shipped in [clear-mvp #181](https://github.com/CLEAR-Initiative/clear-mvp/pull/181)).  
> **This file is the contract.** Cron, Prisma models, and the Express handler are follow-up work — not this PR.

**Not GraphQL.** Same pattern as LogIE: authenticated **GET** of slim GeoJSON ([clear-api #101](https://github.com/CLEAR-Initiative/clear-api/pull/101) `GET /api/logie/blockages`). The FE BFF is already wired: production map calls same-origin `GET /api/usgs/earthquakes`, which proxies to this route. Prod must **never** call `earthquake.usgs.gov` from the browser.

Frontend contract (source of truth for types and slim transform):
[`clear-mvp/src/lib/map/usgs-earthquakes.ts`](https://github.com/CLEAR-Initiative/clear-mvp/blob/dev/src/lib/map/usgs-earthquakes.ts).

---

## Must ship

1. **Cron ~10 min** (5–15 ok). Pull USGS FDSN Event GeoJSON:
   - `format=geojson`
   - `eventtype=earthquake`
   - `minmagnitude=5.5`
   - upsert by USGS event **`id`** (top-level Feature.id, e.g. `us6000tjl2` — **not** `properties.id`)
   - incremental `updatedafter` after the first backfill
2. **`GET /api/usgs/earthquakes`** — session cookie **or** API key (`Bearer sk_live_…`), same `resolveRequestAuth` as LogIE. Optional query: `bbox`, `minmagnitude`. Response: slim `SeismicMapCollection` + `meta.pulled_at` with `source: "usgs-ingest"`.
3. **Persist ShakeMap `cont_mmi.json` contours** when `has_shakemap`. Do **not** invent polygons. Do **not** drop stale events (FE demotes `age_days >= 30`).

---

## Must not

- GraphQL mutation / query for this payload. The map fetches a GeoJSON URL.
- Call USGS from the browser or from Next.js on the production path (BFF → this route only).
- Drop events server-side because they are “stale.” FE demotes them visually (`stale: 1`) and still paints them.
- Invent intensity polygons, re-grid MMI, or approximate shake radius. Contour **shape and MMI `value`** come only from USGS `cont_mmi.json` (`MultiLineString` / `LineString` isoseismals).
- Require real-time USGS streaming. Scheduled pull is enough.
- Require satellite imagery cross-check or camp detection for v1.

---

## Endpoint

**`GET /api/usgs/earthquakes`**

Auth: any authenticated caller — Better Auth session cookie **or** `Bearer sk_live_…` via `resolveRequestAuth`. 401 otherwise. Not a public USGS proxy.

Optional query:

| Param | Notes |
|-------|--------|
| `minmagnitude` | Default **5.5** |
| `bbox` | Comma-separated `minLng,minLat,maxLng,maxLat` (map country padded bbox). Omit for worldwide M5.5+ |

Response headers (LogIE-style, match the FE BFF): `Cache-Control: private, max-age=60`.

FE already proxies this from [`clear-mvp/src/app/api/usgs/earthquakes/route.ts`](https://github.com/CLEAR-Initiative/clear-mvp/blob/dev/src/app/api/usgs/earthquakes/route.ts) (merged in #181). Swapping the map off the live USGS spike is URL-only once this route exists.

---

## Response shape

See `SeismicMapCollection` in
[`clear-mvp/src/lib/map/usgs-earthquakes.ts`](https://github.com/CLEAR-Initiative/clear-mvp/blob/dev/src/lib/map/usgs-earthquakes.ts).
Ingest **must** set `meta.source` to `"usgs-ingest"` (the FE spike uses `"usgs-spike"`).

```typescript
type SeismicMapCollection = {
  type: "FeatureCollection";
  features: SeismicMapFeature[];
  shakemaps?: ShakeMapContours[];
  meta: {
    source: "usgs-ingest";
    feature_count: number;
    min_magnitude: number | null;
    window_days: number | null;
    bbox: [number, number, number, number] | null; // minLng, minLat, maxLng, maxLat
    pulled_at: string; // ISO — when CLEAR last synced from USGS
    bytes_in: number;
    bytes_out: number;
    reduction_ratio: number;
  };
};

type SeismicMapFeature = {
  type: "Feature";
  id?: string; // USGS event id
  geometry: { type: "Point"; coordinates: [number, number, number] } | null; // lng, lat, depth_km
  properties: {
    id: string;
    mag: number | null;
    mag_type: string | null;
    place: string | null;
    title: string | null;
    time: number | null;    // ms epoch
    updated: number | null; // ms epoch
    depth_km: number | null;
    alert: "green" | "yellow" | "orange" | "red" | null;
    mmi: number | null;
    url: string | null;
    has_shakemap: boolean;
    status: "automatic" | "reviewed" | null;
    age_days: number | null;
    stale: 0 | 1;
  };
};

type ShakeMapContours = {
  eventId: string; // links to SeismicMapFeature.properties.id
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "MultiLineString" | "LineString"; coordinates: unknown };
    properties: { value: number; units: string };
  }>;
};
```

---

## Pipeline

```
USGS FDSN Event API          USGS ShakeMap product (optional per event)
  (epicenter FeatureCollection)   detail/{id}.geojson → download/cont_mmi.json
           │                                    │
           ▼                                    ▼
   clear-api scheduled job (cron ~10 min)
           │
           ├─ slim + upsert epicenters by USGS id
           ├─ attach/refresh MMI contours when has_shakemap
           └─ store meta.pulled_at
           │
           ▼
   GET /api/usgs/earthquakes  →  SeismicMapCollection (slim GeoJSON)
           │
           ▼
   clear-mvp BFF /api/usgs/earthquakes  →  Map Hazards → Seismic Signals
```

**FE never polls USGS.** Continuity is this job. The map fetches the slim collection once when the layer is toggled on.

---

## Aggregation (what CLEAR derives vs what USGS owns)

| Step | Input | Output / rule | Notes |
|------|-------|---------------|-------|
| 1. Query | FDSN `format=geojson`, `eventtype=earthquake`, `minmagnitude`, `starttime` or `updatedafter`, optional bbox | Fat FeatureCollection | USGS is source of truth |
| 2. Identity | Feature **top-level** `id` (e.g. `us6000tjl2`) | Primary key | Not `properties.id` (often missing) |
| 3. Geometry | `Point` `[lng, lat, depth_km]` | Keep as Point; `depth_km` = coord[2] | Reject non-Point / null geometry |
| 4. Slim properties | Fat USGS `properties` | Keep only map fields (see slim table) | Drop `detail`, `nst`, `rms`, `gap`, etc. |
| 5. `has_shakemap` | `properties.types` string contains `shakemap` | boolean | Gate for contour fetch |
| 6. `age_days` | `floor((now - time) / 86400000)` from `properties.time` (ms) | number \| null | FE demotes when ≥ 30 |
| 7. `stale` | `age_days >= 30` | `0` \| `1` | Mapbox-friendly; **do not drop** in API |
| 8. Upsert | Existing row with same `id` | Replace iff USGS `updated` is newer | Incremental `updatedafter` keeps runs small |
| 9. ShakeMap attach | Detail product `contents["download/cont_mmi.json"]` | `shakemaps[]` entry keyed by `eventId` | Contours are **USGS isoseismals** — do not invent polygons |
| 10. Serve | Persisted slim rows + optional contours | `SeismicMapCollection` | Same contract as FE spike |

**What we do *not* aggregate:** we do not synthesize intensity zones, re-grid MMI,
or approximate shake radius.

### Slim feature properties

Keep only what paint/popup need — drop `detail`, `ids`, `sources`, `nst`, `dmin`, `rms`, `gap`, `sig`, `net`, `code`, etc.

| Prop | Notes |
|------|--------|
| `id` | USGS event id (also Feature.id) |
| `mag` / `mag_type` | sizing + label |
| `place` / `title` | popup |
| `time` / `updated` | ms epoch → also derive `age_days`, `stale` (0\|1) |
| `depth_km` | from geometry[2] |
| `alert` | PAGER green/yellow/orange/red \| null |
| `mmi` | optional; foreshadows #466 intensity overlay |
| `url` | USGS eventpage link |
| `has_shakemap` | boolean — derived from `types` containing `shakemap` |
| `status` | automatic/reviewed \| null |
| `age_days` | whole days since `time` (null if unknown) |
| `stale` | 0 when `age_days` < 30; 1 when ≥ 30 |

`meta`: `source` (`usgs-ingest`), `feature_count`, `pulled_at`, `min_magnitude`, `window_days`, `bbox`, `bytes_in` / `bytes_out`.

### Trust / precision

| Field | Meaning |
|-------|---------|
| `pulled_at` | When CLEAR last synced from USGS (ingest job) |
| `time` / `updated` | When USGS recorded / last updated the event |

USGS FDSN is the **source of truth** for significant earthquakes (prod: M5.5+). Scheduled
re-pull keeps CLEAR's copy current; it does **not** invent fresher event data than
upstream.

---

## USGS FDSN Event API

- Base: `https://earthquake.usgs.gov/fdsnws/event/1/query`
- Method: `query` with `format=geojson`
- Required params: `format=geojson`, `eventtype=earthquake`, `minmagnitude=5.5`, `starttime=<ISO>` or `updatedafter=<ISO>`, optional bbox
- Optional: `orderby=time`, `limit=20000` (hard USGS max; use `count` + `offset` for pagination if needed)

### Query example (Sudan + adjacent)

```
GET https://earthquake.usgs.gov/fdsnws/event/1/query
  ?format=geojson
  &eventtype=earthquake
  &minmagnitude=5.5
  &starttime=2026-07-13T00:00:00Z
  &minlatitude=3&maxlatitude=23
  &minlongitude=20&maxlongitude=50
  &orderby=time
  &limit=20000
```

Incremental after the first backfill:

```
  &updatedafter=2026-08-12T12:00:00Z
```

### Upstream feature shape

- `type: "Feature"`
- `id: string` (e.g. `"us6000tk74"`)
- `geometry: { type: "Point", coordinates: [lng, lat, depth_km] }`
- `properties: Record<string, unknown>` — `mag`, `magType`, `place`, `title`, `time`, `updated`, `alert`, `mmi`, `url`, `types`, `status`, etc.

---

## Continuous fetch playbook

The FE does **not** poll USGS; it loads once when Hazards → Seismic Signals is toggled on. Continuity belongs here (scheduled ingest), same pattern as LogIE.

| Job | Cadence | USGS params | Purpose |
|-----|---------|-------------|---------|
| **Backfill** (once / on deploy) | Manual or first cron | `starttime=NOW-30d`, `minmagnitude=5.5`, focus+adjacent bbox (or omit bbox for global) | Seed store |
| **Incremental epicenters** | Every **10 minutes** (acceptable range **5–15 min**) | `updatedafter=<last_pulled_at>`, same filters | New / revised quakes |
| **ShakeMap attach** | Same run, only for events with `has_shakemap` | Detail → `download/cont_mmi.json` | Intensity bands |

**Why ~10 minutes (not real-time):** USGS catalog updates are typically minutes-scale, not
seconds. Faster than 5 minutes is usually overkill; slower than 15–30 minutes risks
missing a significant event between analyst shifts.

```
every 10 minutes:
  1. last = stored pulled_at (or NOW-30d on first run)
  2. GET FDSN ?format=geojson&eventtype=earthquake
       &minmagnitude=5.5
       &updatedafter=<last>
       &bbox=<focus+adjacent>   # or omit bbox for global
  3. upsert each feature by USGS id (replace if properties.updated is newer)
  4. for each upserted feature where has_shakemap:
       fetch detail + cont_mmi.json (skip if contour hash/url unchanged)
  5. set pulled_at = now; emit meta.pulled_at on GET /api/usgs/earthquakes
```

Idempotent upserts + `updatedafter` keep each run small (often **0–few events**).

### Geography

The spike (and this API) takes `bbox=minLng,minLat,maxLng,maxLat` from the map
country switcher — padded ~2.5° past borders so adjacent-plate events still paint.

| Map selection | USGS query | Magnitude |
|---------------|------------|-----------|
| Afghanistan, Venezuela, Sudan, … | That country's padded bbox | M4.0+ on the spike; **prod default M5.5+** |
| All Countries | No bbox (worldwide) | M5.5+ |

**Recommendation:** Ship **regional bbox ingest** (CLEAR focus + adjacent) at M5.5+ on a
10-minute cron. Add **optional global M5.5+ epicenters** when product needs “All countries”
without per-country bbox — still cheap (~200–300 points/month). Do **not** pull global
M4.0+ + all ShakeMaps unless DS confirms need; contour payloads are the scale risk, not
point epicenters.

USGS only publishes ShakeMap products for some events. Epicenter dots without yellow/orange
bands are upstream coverage, not a missing country filter.

### Pagination

USGS hard limit is 20,000 events per query. If the result set exceeds this:

1. Call `GET /query?...&limit=1` with `format=geojson` to get `metadata.count`
2. If `count > 20000`, paginate with `offset=0`, `offset=20000`, etc.
3. Merge all pages before persisting.

For a focus + adjacent bbox at M5.5+, 30-day count is typically **< 50 events**.

### Performance

- **Point volume:** M5.5+ globally is ~200–300 events/month. Focus + adjacent ~10–50/month.
  No vector tiles or clustering server-side needed yet.
- **Reduction ratio:** Slim transform typically drops ~60–70% of upstream JSON.
- **Future:** If global coverage or lower magnitudes push event count > 10k, consider vector tiles, edge cache, or a spatial index for bbox queries.

---

## ShakeMap intensity (`cont_mmi.json`)

**Source:** `https://earthquake.usgs.gov/fdsnws/event/1/detail/{event_id}.geojson`

- Check `properties.products.shakemap[0]` (if exists)
- Fetch `contents["download/cont_mmi.json"].url` for MMI contours
- Persist those features; do **not** convert lines to polygons

**Contour structure:**

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "MultiLineString",
        "coordinates": [[[lng, lat], [lng, lat]]]
      },
      "properties": {
        "value": 5.0,
        "units": "intensity"
      }
    }
  ]
}
```

- `value`: MMI intensity (1–10, may include half-steps like 4.5)
- Contours are **boundaries** of equal intensity (isoseismals)
- Higher MMI values = closer to epicenter

Typical payload: 5–15 contour lines, ~10–50 KB slim per event. Do **not** ingest USGS
`grid.xml` (~28 MB+ per event).

**When ShakeMaps exist:** typically M4.5+, near populated areas; generated 2–20 minutes
after the quake. Event `updated` changes when a ShakeMap product is added — incremental
`updatedafter` picks that up.

**Coverage:** well-covered USA / Japan / Taiwan / Turkey / New Zealand; partial Latin
America / Mediterranean / Middle East; limited Africa / Central Asia / remote regions.

### Why not other representations (v1)

| Approach | Decision |
|----------|----------|
| Grid raster (`grid.xml`) | ❌ Not scalable (28 MB/event) |
| Contour polygons (filled) | Out of scope — do not invent |
| Thick overlapping USGS isoseismals | ✅ FE paints these as bands |

---

## FE acceptance (after implementation lands)

- Toggle on → `GET /api/usgs/earthquakes` returns slim collection + optional `shakemaps[]`
- `meta.source === "usgs-ingest"` and `meta.pulled_at` within ~15 minutes of wall clock under normal cron health
- No browser calls to `earthquake.usgs.gov`
- Stale events (`age_days` ≥ 30) still returned but visually demoted

---

## Out of scope (future)

- Filled polygon zones (instead of thick contour lines)
- Peak Ground Acceleration (PGA) / Peak Ground Velocity (PGV) overlays
- Auto-ingest of Seismic Signals into the Detection **Signal** pipeline
- Historical archive beyond 30 days
- Real-time streaming
- Satellite imagery cross-check for damage correlation

---

## References

- Expo #465: Map: Seismic Signals epicenters from USGS FDSN GeoJSON (`cmsq40vy00001ju048zgfdci7`)
- Expo #466: Map: Seismic Intensity overlay from USGS ShakeMap
- FE contract: [clear-mvp `src/lib/map/usgs-earthquakes.ts`](https://github.com/CLEAR-Initiative/clear-mvp/blob/dev/src/lib/map/usgs-earthquakes.ts)
- FE spike (dev-only live FDSN): `src/app/api/dev/usgs-earthquakes/route.ts` in clear-mvp
- FE BFF (prod proxy → this route): `src/app/api/usgs/earthquakes/route.ts` in clear-mvp — [clear-mvp #181](https://github.com/CLEAR-Initiative/clear-mvp/pull/181)
- Pattern to follow: [clear-api #101](https://github.com/CLEAR-Initiative/clear-api/pull/101) `GET /api/logie/blockages` (`src/routes/logie.ts`, `resolveRequestAuth`)
- USGS FDSN Event Web Service: https://earthquake.usgs.gov/fdsnws/event/1/
- USGS ShakeMap Documentation: https://earthquake.usgs.gov/data/shakemap/
