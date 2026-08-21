# Needs Assessment: from a static MSNA import to a living needs layer

**Status:** research / design proposal — no code changes yet.
**Question:** the needs assessment tab is currently fed by one MSNA report. How do we keep needs for a crisis / area current using the corpus of events, reports, and layers the platform already collects — and what could that look like through the API at `api.clearinitiative.io`?

---

## 1. Where the tab's data comes from today

The needs assessment tab reads one dataset: the **IOM/DTM Sudan 2025 MSNA** (data collected 7–31 Aug 2025, 188 localities across all 18 states, led by IOM DTM with OCHA, REACH, ICCG and AAWG), processed and imported by the scripts in `scripts/msna/`:

1. `process_msna.py` parses `IOM_MSNA_Admin2_Output_Tables.xlsx`, applies per-sector severity formulas, and matches each locality to a CLEAR admin-2 location (pCode) via the public API.
2. `import-msna.ts` upserts one bitemporal `locationMetadata` row per locality with `type = "msna_severity_082025"`.

The payload per locality is:

```jsonc
{
  "as_of": "31 August 2025",
  "sectors": {
    "FSL":        { "score": 47.3, "label": "Severe", "inputs": { /* FCS, rCSI, LCSI… */ } },
    "WASH":       { "score": 38.1, "label": "Stressed", "inputs": { /* JMP indicators */ } },
    "Health":     { "…": "…" },
    "Education":  { "…": "…" },
    "Shelter":    { "…": "…" },
    "Protection": { "…": "…" }
  },
  "raw": { /* every referenced xlsx column, per sheet */ },
  "_source": { "source_title": "IOM/DTM - Multi-Sector Needs Assessment - Sudan 2025", "…": "…" }
}
```

Scores are 0–100 with five labels — **Minimal / Stressed / Severe / Extreme / Catastrophic** — deliberately mirroring the 5-class humanitarian severity convention (JIAF / IPC-style). Formulas are documented per sector in `process_msna.py` and grounded in the sector standards (IPC three-pillar convergence for FSL, JMP ladders for WASH, Sphere for Shelter), with explicit "prototype pending expert validation" caveats.

**The structural problem:** an MSNA is a household survey snapshot. This one describes August 2025. It gets more wrong every week — especially in exactly the places CLEAR watches, where the situation moves fastest. The next nationwide round is ~a year away. Meanwhile the platform ingests conflict/hazard signals daily and extracts structured data from sitreps weekly. The tab should say *"here is the surveyed baseline, and here is what has changed since — with evidence."*

---

## 2. What an MSNA actually is (and whether there's a template)

> *This section summarises external research; sources inline. Glossary at the end of the section.*

### 2.1 The instrument

An MSNA is a coordinated, usually **annual household survey** measuring needs across all humanitarian sectors at once, for defined population groups (IDPs, returnees, non-displaced) at an agreed admin level. It exists to feed the annual **Humanitarian Programme Cycle**: MSNA indicators → per-sector composites → cluster People-in-Need (PiN) and severity per admin unit → the intersectoral **HNO/HNRP** ([FSC handbook §6.5.2](https://handbook.fscluster.org/docs/652-multi-sector-needs-assessment)). Two families dominate:

- **REACH / IMPACT Initiatives** — 100+ MSNAs in 20+ crises since 2016 ([programme page](https://www.impact-initiatives.org/programmes/multi-sectoral-needs-assessment-msna/)).
- **IOM DTM** — leads in Sudan and several other countries, sampling on its own population baselines ([DTM MSNA series](https://dtm.iom.int/data-product-series/multi-sectoral-needs-assessment)).

Both run under OCHA/inter-cluster governance (in Sudan: the AAWG's MSNA Technical Working Group, chaired by OCHA — [Shelter Cluster Sudan](https://www.sheltercluster.org/sudan/pages/msna-2024)). Fieldwork is typically mid-year so results land for Q4 HNO/HNRP drafting — which is precisely why the figures are stale for most of the plan year.

### 2.2 Yes, there are templates — and they're machine-readable

| Artifact | Where | Why it matters to us |
|---|---|---|
| **MSNA global indicator bank + Kobo (XLSForm) template** | IMPACT's open-source R packages [`humind`](https://github.com/impact-initiatives-hppu/humind) ([docs](https://impact-initiatives-hppu.github.io/humind/)) and [`humind.data`](https://github.com/impact-initiatives-hppu/humind.data) (dummy data from the 2024 global template) | **The canonical questions, response options, and scoring in code** — FCS, rCSI, HHS, LCSI, JMP WASH ladders, Washington Group set, every sectoral LSG, and the MSNI composition. The right source to replace `process_msna.py`'s prototype weights with validated formulas. |
| **Research ToR + Data Analysis Plan (DAP)** per country | [IMPACT Resource Centre](https://repository.impact-initiatives.org/) (e.g. [Ukraine MSNA 2023 ToR](https://repository.impact-initiatives.org/document/impact/0e63330d/REACH_UKR_MSNA_ToR_Ext_July_2023.pdf)) | The indicator ↔ sector ↔ severity mapping spreadsheet each MSNA publishes. |
| **JIAF 2.0 Technical Manual** | [jiaf.info](https://www.jiaf.info/wp-content/uploads/2023/09/JIAF-2.0-Technical-Manual-v03_Aug-31.pdf) / [OCHA July 2024 edition](https://www.unocha.org/publications/report/world/joint-and-intersectoral-analysis-framework-jiaf-2-technical-manual-july-2024) | The IASC-endorsed method behind HNO PiN/severity: Module 1 context/shock/impact scoping → Module 2 interoperable **sectoral** PiN + severity per unit → Module 3 intersectoral consolidation (preliminary intersectoral severity = **highest sectoral figure** per unit, then expert adjustment). Reference tables 2A (PiN) / 2B (Severity) are the output shapes to be compatible with. |
| **MSNA datasets + questionnaires** | HDX ([Sudan MSNA 2024](https://data.humdata.org/dataset/sudan-multisector-needs-assessment-msna-2024) + [analysis tables](https://data.humdata.org/dataset/sudan-2024-multisector-needs-assessment-msna-analysis-data)) | Microdata + codebooks for calibration/backtesting. |

The analytical core of a REACH-style MSNA is the **MSNI (Multi-Sector Needs Index)**: per sector, a household gets a **Living Standard Gap (LSG)** severity score (1–4+) composed from scored indicators; the household's MSNI is the **maximum** LSG across sectors; **≥3 = "in need"** ([Lebanon MSNI methodological note](https://reliefweb.int/report/lebanon/msna-2021-multi-sectoral-needs-index-methodological-note-june-2022)). Alongside LSGs sit **Capacity Gaps** (negative coping masking need) and pre-existing vulnerability.

### 2.3 The canonical severity scales (and where ours fits)

| Class | JIAF / HNO (area) | IPC food security (area) | MSNI/LSG (household) | Our MSNA import labels |
|---|---|---|---|---|
| 1 | None/Minimal | Minimal | 1 None/minimal | Minimal |
| 2 | Stress | Stressed | 2 Stress | Stressed |
| 3 | **Severe** (PiN threshold) | **Crisis** | **3 Severe (= has LSG)** | Severe |
| 4 | Extreme | Emergency | 4 / 4+ Extreme | Extreme |
| 5 | Catastrophic | Catastrophe/Famine | — | Catastrophic |

Our 0–100 score with five labels maps cleanly onto the 5-class convention; a nowcast layer should keep that mapping (and treat class 3+ as "in need") so it stays comparable with HNO severity maps and IPC phases.

### 2.4 How the sector updates needs *between* annual rounds today

There is **no standard intra-year refresh of admin-2, per-sector severity** — the HNRP figures typically stand for the whole plan year. What exists is a patchwork, which is both the gap and the design precedent:

- **Displacement**: IOM **DTM Mobility Tracking** (monthly rounds; ~13,000 locations in Sudan) and **Emergency Event Tracking** — event-triggered KI reports with 24–72h turnaround carrying cause, origin/arrival and priority needs ([DTM Sudan components](https://reliefweb.int/report/sudan/about-dtm-sudan-active-methodological-components-2024)); IDMC's **daily** Internal Displacement Updates compiled from public event reporting ([IDU](https://www.internal-displacement.org/internal-displacement-updates/)).
- **KI monitoring**: REACH **Humanitarian Situation Monitoring** — monthly key-informant panels (Area-of-Knowledge method) keeping a settlement-level needs picture alive between surveys ([HSM factsheet](https://www.impact-initiatives.org/wp-content/uploads/2021/01/REACH_HSM-SAO-ETH.pdf)); OCHA/cluster **IRNA** rapid assessments after shocks; cluster **5W** response monitoring for the capacity side.
- **Food security — the one sector with institutionalised updating**: **IPC** analyses ~2×/year plus projection updates and Famine Review verdicts ([Sudan IPC](https://www.ipcinfo.org/ipc-country-analysis/details-map/en/c/1159787/)); **FEWS NET** scenario-based outlooks with monthly updates; **WFP HungerMap LIVE** — daily remote surveys fused with conflict/climate/market data and **ML nowcasts for unsurveyed areas** ([hungermap.wfp.org](https://hungermap.wfp.org/)). HungerMap is the strongest operating precedent for exactly what we propose (survey anchor + live signals + model interpolation), albeit single-sector.
- **Cross-sector severity**: the **ACAPS/JRC INFORM Severity Index** — ~31 indicators, 1–5 per crisis, **updated monthly** by analysts from public sources *explicitly including ACLED fatality data* ([methodology](https://drmkc.jrc.ec.europa.eu/inform-index/Portals/0/InfoRM/Severity/INFORM%20Severity%20Methodology%20%2020201019%20online.pdf), [data manual](https://www.acaps.org/fileadmin/Dataset/Methodology_files/20240930_ACAPS_Severity_index_data_collection_manual.pdf)). Unit is the *crisis*, not the admin area — CLEAR can go finer.
- **Model-based inference precedents**: DRC **Foresight** displacement forecasts from 148 indicators incl. ACLED, peer-reviewed by OCHA's Centre for Humanitarian Data ([AI Magazine paper](https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.12133)); UNHCR **Project Jetson**; ML forecasting of **IPC phase transitions** with conflict features ([STOTEN 2021](https://www.sciencedirect.com/science/article/pii/S0048969721024372)); famine prediction from **news text** ([Balashankar et al.](https://arxiv.org/pdf/2111.15602)) — directly analogous to our sitrep corpus; and **DEEP/HumSet** (~47k sitrep excerpts tagged to humanitarian analysis frameworks — [paper](https://arxiv.org/pdf/2210.04573)), the closest existing artifact to our knowledgebase sector-tagging, and a candidate calibration corpus. OCHA/CERF **anticipatory action** frameworks are the institutional precedent for *acting* on model output between assessments.
- **Honesty precedent**: the Grand Bargain workstream on needs assessment exists because analysis lags events ([IASC](https://interagencystandingcommittee.org/improve-joint-and-impartial-needs-assessments)); UNHCR's [Needs Assessment Handbook](https://www.unhcr.org/handbooks/assessment/sites/assessment/files/2023-10/UNHCR%20Needs%20Assessment%20Handbook.pdf) prescribes assessment **plus** continuous situation monitoring as distinct things — which is exactly the baseline-vs-nowcast split in §5.

### 2.5 Sudan specifics (our current dataset)

- DTM has led the national MSNA annually since 2021 (2020 was REACH-led). The 2025 round — the one in `scripts/msna/` — collected data in **August 2025**, locality-representative across all 18 states, and feeds the **HNRP 2026** (33.7M PiN, the largest globally; [OCHA summary](https://www.unocha.org/publications/report/sudan/sudan-humanitarian-needs-and-response-plan-2026-summary)). Published artifacts: [report](https://reliefweb.int/report/sudan/sudan-multisector-needs-assessment-msna-august-2025), [dashboard](https://reliefweb.int/report/sudan/dtm-sudan-multi-sector-needs-assessment-2025-dashboard-16-october-2025), [dataset entry](https://dtm.iom.int/datasets/multi-sectoral-needs-assessment-msna-2025-hnrp-2026).
- Our "188 localities" is not incidental: **188 localities (Sudan minus Abyei) is the JIAF unit-of-analysis grid for the Sudan HNO/HNRP** ([humanitarianaction.info](https://humanitarianaction.info/article/12-analysis-shocks-risks-and-humanitarian-needs)) — i.e. the admin-2 grid our `locationMetadata` rows already live on is the same grid the official severity analysis uses.
- Don't confuse the national DTM MSNA with the **UNHCR refugee MSNA 2025** (12 states, 3,254 households, feeds the Refugee Response Plan) that appears on HDX/microdata catalogs under a similar name.
- Between-round machinery already live in Sudan that we can anchor/validate against: DTM monthly mobility updates + EET, IPC projection updates and famine reviews, OCHA IRNAs, REACH hard-to-reach rapid assessments, ACAPS Sudan Analysis Hub + monthly INFORM Severity.

### 2.6 Glossary

**MSNA** Multi-Sector Needs Assessment (annual HH survey) · **MSNI** Multi-Sector Needs Index (household max-of-LSG severity, 1–4+) · **LSG** Living Standard Gap (per-sector household composite) · **DAP** Data Analysis Plan (indicator↔sector↔severity mapping) · **JIAF** Joint and Intersectoral Analysis Framework (IASC method behind HNO PiN/severity; 2.0 = three modules) · **PiN** People in Need (severity class 3+) · **HNO/HNRP** Humanitarian Needs Overview / Needs and Response Plan (annual, OCHA) · **HPC** Humanitarian Programme Cycle · **IPC** Integrated Food Security Phase Classification (5 phases, area-level) · **INFORM Severity** ACAPS/JRC monthly crisis severity index (1–5) · **DTM/EET** IOM Displacement Tracking Matrix / Emergency Event Tracking · **HSM/AoK** REACH Humanitarian Situation Monitoring / Area of Knowledge · **5W** Who does What Where When for Whom (cluster response monitoring) · **ICCG/AAWG** Inter-Cluster Coordination Group / Assessment & Analysis Working Group.

---

## 3. Inventory: what the API already serves

`api.clearinitiative.io` is this repository's deployment: a single GraphQL endpoint (`POST /graphql`, API-key or session auth) with reference docs at [`/docs`](https://api.clearinitiative.io/docs) generated at startup from the schema in `src/schema/typeDefs/`. Everything below is live API surface today.

### 3.1 The event corpus (the "what happened" layer)

| Query | What it gives a needs model |
|---|---|
| `signalsPage(input: { locationId, sourceNames, severityMin, from, to })` | Raw ingested items from **ACLED, Dataminr, GDACS**, manual field reports, and reviewed WhatsApp ground intel. Each carries `severity` (1–5), `casualties`, geo (origin/destination/general + geoparsed landmark), `publishedAt`. |
| `eventsPage(input: { locationId, eventTypes, severityMin, from, to })` | Signals clustered into **events**: `types[]` (taxonomy below), `severity` 1–5, `casualties`, `populationAffected`, `populationDisplaced`, admin-2 binding, time bounds. |
| `entityStats(input: { entity: event, groupBy: type\|severity\|week, locationId, from, to })` | Cheap counts/trends for any location × window — the building block for "activity vs. baseline" deltas. |
| `crises` / `crisis(id)` | Analyst-curated groups of events with `severity`, `populationAffected`, `populationInArea`, LLM `scenarios`, and — important precedent — an LLM-generated **NRC SAF needs analysis** already stored in `needs` (`{ generalSummary[], sector{…6 sectors…} }`), regenerated whenever the crisis's event set changes (`enrichmentStatus` drain). |

Event/signal types use the 3-level `disasterTypeHierarchy`: **conflict** (protests, battles, riots, explosions/remote violence, violence against civilians, strategic developments — ACLED-shaped), **natural hazard** (flood, flash flood, drought, storm, quake…), **epidemic**, **economic crisis**, **famine**, **technological disaster**. This taxonomy is what makes a deterministic event→sector mapping possible (§5).

### 3.2 Report-derived structured data (the "what reports say" layer)

| Query | What it gives a needs model |
|---|---|
| `searchKnowledgebase(query, filters: { locationIds, eventTypes, needSectors, timeRange })` | Hybrid (vector + BM25) retrieval over chunked ReliefWeb PDFs. **Every chunk is already tagged with NRC SAF `needSectors`** (Shelter, WASH, Protection, Health, Food Security, Education), locations, event types, and the time window it describes — i.e. the corpus is pre-indexed for needs evidence lookup. |
| `reportDatapoint(reportId)` | Per-report structured extraction across six domains, one of which is **`needs_and_funding`** (plus `casualties`, `displacement`, `access_and_incidents`…). Every figure is a `NumericField` with value, unit, confidence, source quote, and page provenance. |
| `aggregatedDatapoint(locationId, windowStart, windowEnd, windowKind)` | Pre-computed roll-ups at **weekly × admin-2**, monthly × admin-1, yearly × country. Every field carries a quality envelope: source `reliability` (NATO Admiralty-style 1–4 grade on `dataSources`), `information_credibility`, recency, and a headline `data_quality` (0–10). Also `estimatedCurrentTotals` — a stock+flow **as-of-now displacement/returns estimate** (latest authoritative stock plus subsequent flows, dedup-safe). |
| `situationAnalysis(countryLocationId, year)` | Weekly-regenerated country snapshot whose `data.sectors` component is already a needs assessment at country level: **6 SAF sectors × severity + top_needs + interventions + info_coverage**, each with `source_report_ids` provenance. `situationAnalysesForCountry` gives the trend. |

### 3.3 Contextual baselines (the "who/where/how many" layer)

All served by `locationMetadata(locationId, type)` / `allLocationMetadata(type)` — bitemporal, so history is free (`locationMetadataHistory`):

| `type` | Content | Needs-assessment role |
|---|---|---|
| `msna_severity_082025` | MSNA sector severity + full raw indicator table per admin-2 | **Baseline** measured needs |
| `iom_dtm_displacement` | IOM DTM displacement per admin-2 | Displacement stock; already feeds `events.populationDisplaced` fallback |
| `worldpop_age_sex_2026` | WorldPop age/sex pyramids per admin-2 | Denominators; vulnerable-group shares |
| `ocha_3w` | OCHA 3W partner presence | **Response capacity** — who is already there (JIAF's "capacity" leg) |
| `logie_roads` | Roads/bridges | Physical access constraints |
| `locations.population` | WorldPop population per admin 0–2 | Denominator for per-capita rates |

### 3.4 Reading the inventory against the MSNA/JIAF stack

The platform already holds an unusually complete version of the analytical stack a needs assessment framework asks for:

| Framework component | CLEAR source |
|---|---|
| Context (population, demographics) | `locations.population`, `worldpop_age_sex_2026` |
| Event / shock | signals → events corpus (ACLED, GDACS, Dataminr, ground intel) |
| Impact (casualties, displacement) | `events.casualties` / `populationDisplaced`, `iom_dtm_displacement`, `aggregatedDatapoint.estimatedCurrentTotals` |
| Humanitarian conditions (sectoral needs) | **MSNA baseline** + `reportDatapoint.needs_and_funding` + KB chunks by `needSectors` |
| Response capacity | `ocha_3w` |
| Access | `logie_roads`, `access_and_incidents` datapoints |
| Severity grading + quality | 5-label scale (MSNA scoring), `dataQualityScore` machinery (ADR-0004/0005) |

What's missing is not data — it's **one derived layer that combines them per (area × sector × time)** and a place to serve it.

---

## 4. The gap, stated precisely

1. **Cadence** — MSNA: annual. Corpus: continuous. The tab shows August 2025 forever.
2. **Coverage** — MSNA: surveyed localities only (188 of ~189 admin-2s; some unmatched). Corpus: wherever signals occur, including areas enumerators can't reach — which are usually the worst-off areas.
3. **Directness** — this cuts the other way. The MSNA *measures* needs (households answered questions about consumption, water, shelter). Events are *proxies*: an air strike doesn't tell you the FCS distribution; it tells you needs likely worsened, in which sectors, and roughly for how many people. A credible design must keep this distinction visible rather than blending measured and inferred numbers into one indistinguishable score.
4. **Per-crisis vs. per-area** — crisis enrichment already produces a qualitative SAF needs analysis per *crisis*. The tab needs the *area* view (admin-2 grid), which is where the MSNA lives, and where response planning happens.

---

## 5. Proposal: a sector-severity **nowcast** layered on the MSNA baseline

**Unit of output:** (admin-2 location × SAF sector × week). Same six sectors, same 0–100 score + 5-label scale as the current tab — the UI keeps its mental model; each cell gains freshness, confidence, and evidence.

### 5.1 Layered scoring model

For each (location, sector, week):

```
severity_now = clamp(
    baseline                  // MSNA sector score, as_of Aug 2025
  + report_adjustment         // evidence from sitreps since baseline
  + event_adjustment          // corpus-inferred pressure since last report evidence
  + displacement_adjustment   // population-moved shock on receiving/losing areas
)
```

with each term separately reported, decayed, and provenance-tagged:

- **Baseline** — the MSNA score. Never mutated; always shown as "surveyed (IOM MSNA, Aug 2025)".
- **Report adjustment** — where `reportDatapoint.needs_and_funding` / sector-tagged KB chunks cover the area more recently than the baseline, they *re-anchor* the sector score (they are semi-measured: assessments, sitreps, cluster reports). The existing `aggregatedDatapoint` quality envelope (source reliability × credibility × recency → `data_quality` 0–10) is exactly the confidence weight to use.
- **Event adjustment** — deterministic mapping from the event corpus to sector pressure (below), scaled by event `severity`, `casualties`, and affected population vs. the area's population denominator, with time decay (e.g. half-life 4–8 weeks, sector-dependent).
- **Displacement adjustment** — `estimatedCurrentTotals.displacement` / DTM stock changes: inflows raise Shelter/WASH/Health pressure in *receiving* areas (per-capita against `locations.population`), large outflows mark *origin* areas' figures as unstable.

### 5.2 Event-type → sector pressure mapping (starting point)

Grounded in the `disasterTypeHierarchy` the corpus already uses:

| Event group (level 2) | FSL | WASH | Health | Shelter | Protection | Education |
|---|---|---|---|---|---|---|
| Battles / explosions & remote violence | ▲ | ▲ | ▲▲ | ▲▲ | ▲▲▲ | ▲▲ |
| Violence against civilians (attack, sexual violence, abduction) | – | – | ▲ | – | ▲▲▲ | ▲ |
| Riots / protests with force | – | – | ▲ | – | ▲▲ | ▲ |
| Looting / property destruction | ▲▲ | ▲ | – | ▲▲ | ▲▲ | – |
| Flood / flash flood | ▲ | ▲▲▲ | ▲▲ | ▲▲▲ | – | ▲ |
| Drought | ▲▲▲ | ▲▲ | ▲ | – | – | – |
| Epidemic | – | ▲ | ▲▲▲ | – | – | ▲ |
| Economic crisis | ▲▲▲ | – | ▲ | – | – | ▲ |
| Famine | ▲▲▲ | – | ▲▲ | – | – | – |

(▲ = weight tier, not a score; weights are a prototype design choice pending expert validation — the same honest framing `process_msna.py` already uses for its formulas.)

**Sector asymmetry (from §2.4):** food security is the one sector with institutionalised intra-year updating — IPC analyses/projection updates, FEWS NET outlooks, WFP HungerMap. For **FSL, ingest those area-level products directly** (a new `locationMetadata` type, e.g. `ipc_phase`, per locality) instead of inferring from events; reserve event-driven inference for the sectors that genuinely go stale between MSNAs (Shelter, WASH, Protection, Education, Health), where no incumbent update mechanism exists. That's also where CLEAR adds something the sector doesn't have.

### 5.3 Serving it: three options

**Option A — new `locationMetadata` type (recommended start).** A pipeline job writes `type = "needs_nowcast_v1"` rows per admin-2, weekly (and on-demand when a severe event lands). Zero schema migration; the tab already knows how to read `allLocationMetadata`; bitemporal history gives the trend view for free; `msna_severity_082025` remains untouched as the auditable baseline.

```jsonc
// locationMetadata(type: "needs_nowcast_v1").data
{
  "as_of": "2026-08-17",
  "baseline_ref": { "type": "msna_severity_082025", "as_of": "2025-08-31" },
  "sectors": {
    "WASH": {
      "score": 61.4, "label": "Extreme",
      "baseline_score": 38.1,
      "components": { "baseline": 38.1, "reports": +9.0, "events": +8.3, "displacement": +6.0 },
      "confidence": 6.8,            // 0–10, aggregatedDatapoint data_quality convention
      "basis": "inferred",          // "surveyed" | "reported" | "inferred"
      "drivers": [
        { "kind": "event",  "id": "evt_…", "types": ["ff"], "weight": 0.4 },
        { "kind": "report", "reportId": "rw_…", "quote_ref": "p.3", "weight": 0.35 },
        { "kind": "displacement", "inflow": 42000, "weight": 0.25 }
      ]
    }
    // … 5 more sectors
  }
}
```

**Option B — extend `situationAnalysis` below country level.** The weekly Dagster asset already produces `sectors` (severity + top_needs + interventions + info_coverage) per country; run the same component per admin-1 or for hotspot admin-2s. Best long-term home for the *narrative* layer (LLM-written "top needs" per area, reusing the exact machinery that writes `crisis.needs`), but heavier: more LLM spend, and the bucket model needs sub-national keys.

**Option C — first-class `needsAssessment(locationId, asOf)` query** that composes A (+B) with the MSNA baseline and evidence links at read time. Nicest developer experience for the tab and external consumers; do it once A exists, as a typed façade over the metadata rows rather than a new storage system.

### 5.4 What the tab could look like

Per admin-2 cell (map choropleth + drawer):

1. **Now**: sector score + label + trend arrow (this week vs. baseline), badge for basis: `surveyed / reported / inferred`.
2. **Baseline**: the MSNA figure and date, always visible ("Aug 2025 survey: Stressed (38)").
3. **What changed**: the drivers list — events (deep-link to `event(id)`), report quotes (deep-link via `searchKnowledgebase` hit → `sourceUrl` + page), displacement flows.
4. **Confidence + coverage**: the 0–10 confidence, `info_coverage`-style note when the area is dark (no signals ≠ no needs — flag "low information" separately from "low severity", the same distinction `situationAnalysis.sectors.info_coverage` already draws).
5. **Response context**: 3W partners present in that area/sector (`ocha_3w`) — needs vs. capacity side by side.

Phase 0 requires **no new backend at all**: the tab can already render baseline + "activity since baseline" per area from `allLocationMetadata(type: "msna_severity_082025")` + `entityStats(entity: event, locationId, from: baseline_as_of, groupBy: type)` + `searchKnowledgebase(filters: { locationIds, needSectors, timeRange })`. That's the cheapest way to validate the UX before building the scored nowcast.

### 5.5 Phasing

| Phase | Deliverable | New machinery |
|---|---|---|
| 0 | Tab shows MSNA baseline + since-baseline event activity + latest sector-tagged report evidence per area | none — existing queries |
| 1 | Deterministic nowcast rows (`needs_nowcast_v1`), weekly + event-triggered, with drivers/confidence; IPC phase ingested per locality as the FSL anchor | one pipeline job + mapping table + IPC importer |
| 2 | LLM sector narrative for hotspot areas (reuse crisis-needs / situation-analysis sector component at admin level) | prompt + drain, same pattern as `setCrisisNeedsAnalysis` |
| 3 | Validation: when the next MSNA round lands, score the nowcast against it per (area × sector); recalibrate weights | evaluation script |

Phase 3 is what makes this defensible: the annual MSNA stops being "the data" and becomes the **ground-truth instrument that calibrates the living layer**.

---

## 6. Honesty rules (non-negotiables)

1. **Never present inferred severity as measured.** The `basis` field and baseline row are permanent UI fixtures, not footnotes.
2. **Layer, don't overwrite.** MSNA rows are immutable baseline; nowcast is a separate type/rows. (Enforced already in spirit: `import-msna.ts` refuses to touch other importers' types.)
3. **Low information ≠ low need.** Dark areas get an explicit information-coverage flag; decay toward "unknown", not toward "fine".
4. **Provenance all the way down** — every score decomposes into drivers that link to real events/reports; the `NumericField`/quality-envelope pattern (clear-context-pipeline ADR-0004/0005) is the house style for this and should be reused, not reinvented.
5. **Prototype weights are labelled as such** and versioned (`scoring_version`, `schemaVersion`) so recalibration against MSNA 2026 is a version bump, not a silent change — the discipline `process_msna.py` and the datapoints pipeline already follow.
6. **This is not the official PiN.** HNO/HNRP People-in-Need and severity are inter-agency negotiated products (JIAF Module 3 + HCT sign-off); only the ICCG/HCT can revise them. CLEAR's nowcast is decision-support *alongside* the official figures — label it that way, and align its scale/grid (5 classes, 188-locality JIAF grid) so the two are comparable rather than confusable.
