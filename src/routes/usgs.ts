/**
 * GET /api/usgs/earthquakes?iso3=SDN
 *
 * Serves the map-ready **Seismic Signals** collection for one country — the slim
 * `SeismicMapCollection` clear-mvp's `/map` paints. Reads the per-country
 * `locationMetadata(type="usgs_earthquakes")` blob the Dagster ingest persists
 * every ~10 min (already filtered to the country's padded bbox and reduced from
 * the fat USGS FDSN payload) and injects the request-time `age_days` / `stale`
 * fields. Backend for Expo #465 — mirrors `routes/logie.ts`.
 *
 * REST, not GraphQL (by design — same as LogIE): this is a map-rendering payload,
 * not a queryable domain entity. A Mapbox/MapLibre `geojson` source consumes a
 * URL directly (`{ type: "geojson", data: "/api/usgs/earthquakes?iso3=SDN" }`), the
 * GET is HTTP-cacheable (`Cache-Control` below + CDN), and the FE needs the whole
 * FeatureCollection to paint — so field selection buys nothing. GraphQL stays the
 * surface for structured/queryable data; geo/binary payloads (this, LogIE, uploads)
 * are REST. The FE BFF proxies `/api/usgs/earthquakes`; prod must never call
 * `earthquake.usgs.gov` from the browser.
 *
 * Auth: any authenticated caller (session cookie or `Bearer sk_live_…`). App
 * data for logged-in users, never a public USGS proxy.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { resolveRequestAuth } from "../utils/request-auth.js";
import {
  toSeismicMapCollection,
  type StoredUsgsMetadata,
} from "../services/usgs/earthquakes.js";

const router = Router();

const USGS_TYPE = "usgs_earthquakes";
const DEFAULT_ISO3 = "SDN";

router.get("/earthquakes", async (req: Request, res: Response) => {
  const { user } = await resolveRequestAuth(req.headers);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Country selector — same convention as LogIE: `iso3` is primary; A0 pCodes in
  // CLEAR are ISO2, so we match on the leading 2 chars. `locationId` overrides.
  const iso3Raw = typeof req.query.iso3 === "string" ? req.query.iso3 : DEFAULT_ISO3;
  const iso3 = iso3Raw.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(iso3)) {
    res.status(400).json({ error: "Invalid iso3" });
    return;
  }
  const locationIdOverride =
    typeof req.query.locationId === "string" && req.query.locationId.trim()
      ? req.query.locationId.trim()
      : null;

  // Optional client-side magnitude floor above the stored ingest floor (M5.5+).
  let minMagnitude: number | null = null;
  if (typeof req.query.minmagnitude === "string" && req.query.minmagnitude.trim()) {
    const m = Number(req.query.minmagnitude);
    if (!Number.isFinite(m)) {
      res.status(400).json({ error: "Invalid minmagnitude" });
      return;
    }
    minMagnitude = m;
  }

  let locationId = locationIdOverride;
  if (!locationId) {
    const country = await prisma.locations.findFirst({
      where: { level: 0, pCode: iso3.slice(0, 2) },
      select: { id: true },
    });
    if (!country) {
      res.status(404).json({ error: `No A0 country for iso3=${iso3}` });
      return;
    }
    locationId = country.id;
  }

  const rows = (await prisma.locationMetadata.findMany({
    where: { locationId, type: USGS_TYPE, validTo: null },
    select: { type: true, data: true },
  })) as StoredUsgsMetadata[];

  const collection = toSeismicMapCollection(rows, { minMagnitude });

  // Frequent (~10-min) ingest; short private cache. `age_days`/`stale` are
  // computed per request, so a modest window keeps them fresh.
  res.setHeader("Cache-Control", "private, max-age=60");
  res.status(200).json(collection);
});

export const usgsRouter = router;
