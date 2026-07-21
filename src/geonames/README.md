# GeoNames gazetteer

Per-country GeoNames extracts used by the **hybrid geo-resolver**: the
signal geoparser (clear-pipeline) resolves a place name against this
gazetteer first — offline, transliteration-tolerant — and only falls back
to LocationIQ/Nominatim for landmarks/POIs the gazetteer lacks (airports,
stations). See `resolveGazetteerLocation` in the GraphQL schema.

## Why not in git

The raw `.txt` extracts total ~28 MB (AF alone is 16 MB) and are the
**seed** for the `geonames` / `geonames_name` Postgres tables — the tables
are the runtime source of truth, so the raw files are `.gitignore`d. Only
this README and the import script are tracked.

## Layout

```
src/geonames/
  SD/SD.txt   Sudan       (~27k rows)
  VE/VE.txt   Venezuela   (~71k rows)
  AF/AF.txt   Afghanistan (~76k rows)
```

Each `<CC>.txt` is the standard GeoNames tab-delimited dump (19 columns:
geonameid, name, asciiname, alternatenames, latitude, longitude,
feature_class, feature_code, country_code, …).

## Refresh the extracts

Country dumps come from GeoNames (CC-BY 4.0):

```bash
cd src/geonames
for cc in SD VE AF; do
  curl -sL "https://download.geonames.org/export/dump/$cc.zip" -o "$cc.zip"
  unzip -o "$cc.zip" -d "$cc" && rm "$cc.zip"
done
```

## Import into Postgres

```bash
bun run scripts/import-geonames.ts
```

Idempotent — truncates and reloads `geonames` + `geonames_name`. Run it
after refreshing the extracts or on a fresh database.
