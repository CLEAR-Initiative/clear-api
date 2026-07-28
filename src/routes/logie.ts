/**
 * GET /api/logie/blockages?iso3=SDN
 *
 * Serves the map-ready **Blockages** FeatureCollection for one country — the
 * slim contract clear-mvp's `/map` paints (`BlockagesMapCollection`). Reads the
 * fat `locationMetadata(type="logie_roads" | "logie_bridges")` blobs that
 * clear-pipeline persists monthly and does the reduction server-side: keep only
 * blocked segments, RDP-simplify line geometry, derive label/reliability/
 * staleness. Result is ~10× smaller than the raw ArcGIS payload, so the browser
 * never loads full LogIE geometry (ticket #317, phase 2 · see
 * clear-mvp/docs/clear-api-logie-ingest.md).
 *
 * Not GraphQL because the FE fetches this as a plain GeoJSON URL
 * (`NEXT_PUBLIC_LOGIE_BLOCKAGES_URL` → `fetch(url)`), mirroring the LogIE spike
 * route it replaces.
 *
 * Auth: any authenticated caller (session cookie or `Bearer sk_live_…`). This is
 * app data for logged-in users, never a public ArcGIS proxy.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { resolveRequestAuth } from "../utils/request-auth.js";
import {
  toBlockagesMapCollection,
  type StoredLogieMetadata,
} from "../services/logie/blockages.js";

const router = Router();

const ROADS_TYPE = "logie_roads";
const BRIDGES_TYPE = "logie_bridges";
const DEFAULT_ISO3 = "SDN";

router.get("/blockages", async (req: Request, res: Response) => {
  const { user } = await resolveRequestAuth(req.headers);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Country selector. `iso3` is primary; A0 pCodes in CLEAR are ISO2, so we
  // match on the leading 2 chars (same ISO2/ISO3 drift the pipeline handles).
  // `locationId` is an optional direct override.
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
    where: {
      locationId,
      type: { in: [ROADS_TYPE, BRIDGES_TYPE] },
      validTo: null,
    },
    select: { type: true, data: true },
  })) as StoredLogieMetadata[];

  const collection = toBlockagesMapCollection(rows);

  // Monthly-refreshed source; short private cache is safe. Age/staleness is
  // computed relative to request time, so we keep the window modest.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).json(collection);
});

export const logieRouter = router;
