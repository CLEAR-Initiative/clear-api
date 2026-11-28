#!/usr/bin/env python3
"""Build scripts/data/sudan-district-towns.json (Exponential #1709).

Many Sudan towns share a name with their district (locality): Al Koma, Al Lait,
Um Dafoug, Foro Baranga. GeoNames has only the district record for them (class
A, ADM2), so no lookup can pin the town. This builds one town point per such
district, with the spellings a post uses for it. The seed script
(`seed-sudan-district-town-aliases.ts`) loads each town as a level-4 location
and its spellings as place aliases.

Inputs (download them, then pass their paths; nothing is fetched here):

  --districts  TSV of CLEAR's Sudan districts with no same-spelling GeoNames
               town inside: group, state, district, geonames_town, sim,
               geonames_id. "A": no GeoNames town; "B": GeoNames has the town
               under another spelling (Al Fasher -> El Fasher).
  --pcodes     TSV of CLEAR's districts: id, p_code, state, name, ...
  --arabic     scripts/data/sudan-admin-arabic-names.json (OCHA COD-AB).
  --osm        HOT export "Populated Places of Sudan" (OSM, ODbL), GeoJSON:
               https://data.humdata.org/dataset/hotosm_sdn_populated_places
  --ocha       OCHA "Sudan: Settlements" (CC BY), XLSX:
               https://data.humdata.org/dataset/sudan-settlement-26-july-2020
  --geonames   TSV geonames_id, name, latitude, longitude, feature_code of the
               "B" towns (from the clear-api geonames table).

Source order for a town in group A: OSM first (current, often has the Arabic
name), then OCHA. A city or town beats a village. A name matches when its
Latin form equals the district's (articles and vowel spellings folded) or its
Arabic form equals the district's OCHA Arabic name. Group B takes the GeoNames
point. EXCLUDE and POINT below hold the hand decisions, each with its reason.

  uv run --no-project --with openpyxl python scripts/data/build-sudan-district-towns.py \\
      --districts gap.tsv --pcodes districts.tsv --arabic scripts/data/sudan-admin-arabic-names.json \\
      --osm populated_places.geojson --ocha sudan_settlement_26july20.xlsx --geonames gn.tsv \\
      --out scripts/data/sudan-district-towns.json
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path

# Districts left out, by name, and why.
EXCLUDE = {
    "Sheikan": "the seat is El Obeid; the village named Sheikan is a different place (OSM and OCHA put it 20 km apart)",
    "Abyei": "Abyei town is in the Abyei PCA area; the West Kordofan match is a village",
    "Karrari": "Karari is a part of Omdurman, not a town of its own",
    "As Serief": "OSM and OCHA put the town 26 km apart; needs a person to pick",
    "At Tawisha": "OSM and OCHA put the town 19 km apart; needs a person to pick",
    "Madeinat Kassala": "'Kassala' already resolves to the GeoNames town",
    "Nyala Janoub": "'Nyala' already resolves to the GeoNames town",
    "Reifi Aroma": "a rural district; 'Aroma' already resolves to the GeoNames town",
    "Reifi Khashm Elgirba": "a rural district; 'Khashm el Girba' already resolves to the GeoNames town",
    "Habila - WD": "'Habila' already resolves to the GeoNames town; OSM's other name is a different place",
}
# Spellings posts use that no source gives (judged sample of #1706).
EXTRA_SPELLINGS = {
    "Um Dafoug": ["Um Dafous", "Umm Dafous"],
    "Al Lait": ["Al La'it", "El La'it", "Al La'it Jar Al-Nabi", "Al Lait Jar Al Nabi", "اللعيت جار النبي", "اللعيت جارالنبي"],
}
# Spellings a source gives that are not this town's, and why.
DROP_SPELLINGS = {
    "Umm Kot": "OSM's English name on the Um Dam Haj Ahmed node; the Arabic name says Um Dam Haj Ahmed",
}
# Group B rows with a weak name match that a person checked (sim < 0.6).
B_CHECKED = {"Halfa Aj Jadeedah", "Al Malha", "Soudari", "Um Rawaba", "Ghubaish", "Aj Jabalain", "Tendalti",
             "Um Bada", "Halfa"}
RANK = {"city": 0, "town": 1, "village": 2, "hamlet": 3}
AR_FOLD = str.maketrans("أإآٱىیکةؤئ", "ااااييكهوي")
KIND_AR = ("مدينة", "محلية", "ريفي", "ريفى")


def ar_core(s: str) -> str:
    s = re.sub(r"[ً-ٰٟـ]", "", s or "").translate(AR_FOLD)
    s = re.sub(r"\s+-\s+.*$", "", s)
    s = re.sub(r"[^ء-ي]", "", s)
    return re.sub(r"^(مدينه|محليه|ريفي|ال)", "", s)


def lat_core(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[`'’ʼʻ‘‛]", "", s)
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"[^a-z]+", " ", s).strip()
    s = re.sub(r"^(al|el|ad|ed|ar|er|as|es|ash|esh|at|et|an|en|aj|ag|az)\s+", "", s)
    s = re.sub(r"^umm\b", "um", s).replace(" ", "")
    for a, b in [("ou", "u"), ("oo", "u"), ("ee", "i"), ("ei", "i"), ("ai", "i"), ("ay", "i"), ("aa", "a"),
                 ("o", "u"), ("e", "i"), ("q", "g"), ("kh", "k"), ("y", "i"), ("w", "u")]:
        s = s.replace(a, b)
    return re.sub(r"h$", "", re.sub(r"(.)\1+", r"\1", s))


def fix_mojibake(s: str | None) -> str | None:
    """OCHA's Arabic column is UTF-8 read twice as CP437."""
    if not s:
        return None
    try:
        return s.encode("cp437").decode("utf8").encode("cp437").decode("utf8")
    except (UnicodeError, ValueError):
        return None


def is_arabic(s: str) -> bool:
    return bool(re.search(r"[؀-ۿ]", s))


ARTICLE = re.compile(r"^(al|el|ad|ed|ar|er|as|es|ash|at|et|an|en|aj|ag|az)[\s-]+(.+)$", re.I)


def latin_spellings(*names: str) -> list[str]:
    """The Latin spellings a post may use: the name, and with 'Al' and 'El'
    for one written with an article ("Ad Damar" -> "Al Damar", "El Damar")."""
    out: list[str] = []
    for n in names:
        if not n or is_arabic(n):
            continue
        n = re.sub(r"\s*\(.*?\)\s*", " ", n)
        n = re.sub(r"\s+-\s+(SK|WD|BN|SD|WK)$", "", n).strip()
        n = re.sub(r"^Reifi\s+", "", n)
        if "@" in n or not re.search(r"[aeiou]", n.lower()):
            continue  # a transliteration code, not a spelling
        forms = [n]
        m = ARTICLE.match(n)
        # "Ed Al Fursan" is "عد الفرسان": "Ed" is a word there, not an article.
        if m and not ARTICLE.match(m.group(2)):
            forms += [f"Al {m.group(2)}", f"El {m.group(2)}"]
        for f in forms:
            if f not in out and len(re.sub(r"[^a-z]", "", f.lower())) >= 3:
                out.append(f)
    return out


def arabic_spellings(*names: str) -> list[str]:
    """Arabic spellings: each name as written, and without a kind word
    ("مدينة الضعين" -> "الضعين") or a state suffix ("التضامن - ج ك")."""
    out: list[str] = []
    for n in names:
        if not n or not is_arabic(n):
            continue
        n = re.sub(r"\s+-\s+.*$", "", re.sub(r"[A-Za-z]+", " ", n)).strip()
        forms = [n]
        words = n.split()
        if len(words) > 1 and words[0] in KIND_AR:
            forms.append(" ".join(words[1:]))
        for f in forms:
            if f and f not in out and len(ar_letters(f)) >= 3:
                out.append(f)
    return out


def ar_letters(s: str) -> str:
    return re.sub(r"[^\u0621-\u064A]", "", s)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    for name in ("districts", "pcodes", "arabic", "osm", "ocha", "geonames", "out"):
        ap.add_argument(f"--{name}", required=True, type=Path)
    a = ap.parse_args()
    import openpyxl  # noqa: PLC0415 — only this script needs it

    gaps = list(csv.DictReader(a.districts.open(), delimiter="\t"))
    pcodes = {r["name"]: r for r in csv.DictReader(a.pcodes.open(), delimiter="\t") if r.get("p_code")}
    arabic = {r["pCode"]: r["nameAr"] for r in json.loads(a.arabic.read_text())["rows"]}
    geonames = {r["geonames_id"]: r for r in csv.DictReader(a.geonames.open(), delimiter="\t")}

    cands: dict[str, list[dict]] = {}
    for f in json.loads(a.osm.read_text())["features"]:
        p, g = f["properties"], f["geometry"]
        if p.get("place") not in RANK or g["type"] != "Point" or not p.get("adm2_pcode"):
            continue
        # Not name_latin: a machine transliteration ("m lqry", "lsnwT").
        names = [n for n in (p.get("name"), p.get("name_en")) if n]
        ars = [n for n in (p.get("name_ar"), p.get("name")) if n and is_arabic(n)]
        cands.setdefault(p["adm2_pcode"], []).append(dict(
            source="osm", ref=p["id"], place=p["place"], lon=g["coordinates"][0], lat=g["coordinates"][1],
            names=[n for n in names if not is_arabic(n)], ar=list(dict.fromkeys(ars))))
    ws = openpyxl.load_workbook(a.ocha, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    ix = {h: i for i, h in enumerate(next(rows))}
    for r in rows:
        kind = (r[ix["Type_Text"]] or "").lower()
        place = "city" if ("capital" in kind or "principal" in kind) else "town" if ("town" in kind or "admin" in kind) else "village"
        ar = fix_mojibake(r[ix["feature_AR"]])
        cands.setdefault(r[ix["ADM2_PCODE"]], []).append(dict(
            source="ocha", ref=r[ix["feature_pc"]], place=place, lon=float(r[ix["X"]]), lat=float(r[ix["Y"]]),
            names=[n for n in {r[ix["featureNam"]], r[ix["featureRef"]]} if n], ar=[ar] if ar else []))

    towns, left_out = [], []
    for g in gaps:
        name, group = g["district"], g["group"]
        if group == "C":
            continue
        d = pcodes[name]
        pc, d_ar = d["p_code"], arabic.get(d["p_code"])
        if name in EXCLUDE:
            left_out.append({"pCode": pc, "district": name, "why": EXCLUDE[name]})
            continue
        if group.startswith("B"):
            if group == "B?" and name not in B_CHECKED:
                left_out.append({"pCode": pc, "district": name, "why": "weak name match to the GeoNames town, not checked"})
                continue
            gn = geonames.get(g["geonames_id"])
            if gn is None:
                left_out.append({"pCode": pc, "district": name, "why": "no GeoNames town"})
                continue
            osm_ar = [c for c in cands.get(pc, []) if c["source"] == "osm" and lat_core(gn["name"]) in map(lat_core, c["names"])]
            town = dict(name=gn["name"], lat=float(gn["latitude"]), lon=float(gn["longitude"]), source="geonames",
                        ref=int(gn["geonames_id"]), place=gn["feature_code"])
            names_lat, names_ar = [name], [d_ar] + [x for c in osm_ar for x in c["ar"]]
        else:
            core, acore = lat_core(re.sub(r"\s+-\s+\w+$", "", name)), ar_core(d_ar or "")
            hits = []
            for c in cands.get(pc, []):
                lat_hit = any(lat_core(n) == core for n in c["names"])
                ar_hit = bool(acore) and any(ar_core(x) == acore for x in c["ar"])
                if lat_hit or ar_hit:
                    hits.append((RANK[c["place"]], c["source"] != "osm", not (lat_hit and ar_hit), c))
            if not hits:
                left_out.append({"pCode": pc, "district": name, "why": "neither OSM nor OCHA has a town of this name in the district"})
                continue
            c = sorted(hits, key=lambda h: h[:3])[0][3]
            town = dict(name=(c["names"] or [name])[0], lat=c["lat"], lon=c["lon"], source=c["source"], ref=c["ref"],
                        place=c["place"])
            # The same place in the other source adds its spellings.
            same = [h[3] for h in hits if h[3] is not c and abs(h[3]["lat"] - c["lat"]) < 0.05 and abs(h[3]["lon"] - c["lon"]) < 0.05]
            names_lat = [name, *c["names"], *[n for s in same for n in s["names"]]]
            names_ar = [d_ar, *c["ar"], *[x for s in same for x in s["ar"]]]
        town["nameAr"] = next((x for x in names_ar if x and is_arabic(x)), None)
        towns.append({
            "pCode": pc, "district": name, "state": g["state"], "group": "A" if group == "A" else "B", "town": town,
            "spellings": [x for x in dict.fromkeys(latin_spellings(*names_lat) + arabic_spellings(*[x for x in names_ar if x])
                                                   + EXTRA_SPELLINGS.get(name, []))
                          if x not in DROP_SPELLINGS],
        })

    inputs = {k: {"file": getattr(a, k).name, "sha256": sha256(getattr(a, k))} for k in ("osm", "ocha", "arabic")}
    out = {
        "about": "Town points for Sudan districts whose town GeoNames lacks or spells differently (Exponential #1709)",
        "built_by": "scripts/data/build-sudan-district-towns.py",
        "sources": {
            "osm": {"name": "HOT export, Populated Places of Sudan (OpenStreetMap contributors)", "license": "ODbL 1.0",
                    "snapshot": "2026-11-05", "url": "https://data.humdata.org/dataset/hotosm_sdn_populated_places", **inputs["osm"]},
            "ocha": {"name": "OCHA Sudan: Settlements (26 July 2020)", "license": "CC BY 4.0",
                     "url": "https://data.humdata.org/dataset/sudan-settlement-26-july-2020", **inputs["ocha"]},
            "geonames": {"name": "GeoNames SD, as imported into clear-api", "license": "CC BY 4.0"},
        },
        "countryCode": "SD",
        "towns": towns,
        "leftOut": left_out,
    }
    a.out.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(towns)} towns ({sum(t['group'] == 'A' for t in towns)} A, {sum(t['group'] == 'B' for t in towns)} B), "
          f"{sum(len(t['spellings']) for t in towns)} spellings; {len(left_out)} left out")


if __name__ == "__main__":
    main()
