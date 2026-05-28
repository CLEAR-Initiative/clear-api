#!/usr/bin/env python3
"""
MSNA locationMetadata importer.

Reads a processed MSNA JSON file (output of process_msna.py) and upserts
one locationMetadata record per Admin2 locality into the CLEAR API using
upsertLocationMetadataBatch (type: msna_severity_082025).

Usage:
    python scripts/msna/import_msna.py                        # dry run (default)
    python scripts/msna/import_msna.py --execute              # write to API
    python scripts/msna/import_msna.py --input scripts/msna/outputs/msna_2026-05-19.json

Requires:
    - Python 3.10+
    - CLEAR_API_KEY and CLEAR_API_URL set in environment (or .env)
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

if sys.version_info < (3, 10):
    sys.exit("ERROR: Python 3.10+ required")

SCRIPT_DIR    = Path(__file__).parent
OUTPUT_DIR    = SCRIPT_DIR / "outputs"
METADATA_TYPE = "msna_severity_082025"
BATCH_SIZE    = 50


# ─── GraphQL ──────────────────────────────────────────────────────────────────

UPSERT_BATCH = """
mutation UpsertMsnaBatch($inputs: [UpsertLocationMetadataInput!]!) {
  upsertLocationMetadataBatch(inputs: $inputs) {
    id
    type
    location { id name pCode }
  }
}
"""


def get_api_key() -> str:
    key = os.environ.get("CLEAR_API_KEY", "").strip()
    if key:
        return key
    sys.exit(
        "ERROR: CLEAR_API_KEY environment variable not set.\n"
        "Export your CLEAR API key before running:\n"
        "  export CLEAR_API_KEY='sk_live_...'"
    )


def get_api_url() -> str:
    return os.environ.get("CLEAR_API_URL", "https://dev-api.clearinitiative.io/graphql").strip()


def graphql(query: str, variables: dict, api_key: str, api_url: str) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(
        api_url,
        data=payload,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"ERROR: HTTP {e.code} from API: {body[:300]}")
    except urllib.error.URLError as e:
        sys.exit(f"ERROR: Could not reach API ({api_url}): {e.reason}")


# ─── Payload builder ──────────────────────────────────────────────────────────

def build_payload(locality_name: str, entry: dict, meta: dict) -> dict | None:
    location_id = entry.get("location_id")
    if not location_id:
        return None

    data_collection = meta.get("data_collection", "")
    as_of = data_collection.split(" to ")[-1] if " to " in data_collection else data_collection

    source = {
        "pcode":               entry.get("pcode"),
        "locality_name":       locality_name,
        "match_method":        entry.get("match_method"),
        "source_title":        meta.get("source_title"),
        "led_by":              meta.get("led_by"),
        "data_collection":     data_collection,
        "scoring_version":     meta.get("scoring_version"),
        "fsl_formula_applied": meta.get("fsl_formula_applied"),
        "generated_at":        meta.get("generated_at"),
    }
    if "match_note" in entry:
        source["match_note"] = entry["match_note"]

    return {
        "locationId": location_id,
        "type":       METADATA_TYPE,
        "data": {
            "as_of":   as_of,
            "sectors": entry.get("sectors", {}),
            "raw":     entry.get("raw", {}),
            "_source": source,
        },
    }


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import MSNA scores into CLEAR locationMetadata")
    parser.add_argument("--input",   type=Path, default=None, help="Processed JSON (default: latest in outputs/)")
    parser.add_argument("--execute", action="store_true",     help="Write to API (default is dry run)")
    args = parser.parse_args()

    if args.input:
        json_path = args.input
    else:
        candidates = sorted(OUTPUT_DIR.glob("msna_*.json"), reverse=True)
        if not candidates:
            sys.exit(f"ERROR: No msna_*.json found in {OUTPUT_DIR}")
        json_path = candidates[0]

    print(f"Input:  {json_path}")
    print(f"Type:   {METADATA_TYPE}")
    print(f"Mode:   {'EXECUTE' if args.execute else 'DRY RUN (pass --execute to write)'}")
    print()

    with open(json_path, encoding="utf-8") as f:
        processed = json.load(f)

    meta       = processed["meta"]
    localities = processed["localities"]

    payloads, skipped = [], []
    for name, entry in localities.items():
        p = build_payload(name, entry, meta)
        if p:
            payloads.append(p)
        else:
            skipped.append(name)

    print(f"Localities: {len(localities)}")
    print(f"  Will upsert: {len(payloads)}")
    print(f"  Skipped (no location_id): {len(skipped)}")
    if skipped:
        for s in skipped:
            print(f"    - {s}")
    print()

    if not args.execute:
        sample = payloads[0]
        print("Sample payload (first locality):")
        print(f"  locationId:         {sample['locationId']}")
        print(f"  type:               {sample['type']}")
        print(f"  data.as_of:         {sample['data']['as_of']}")
        print(f"  data.sectors:       {list(sample['data']['sectors'].keys())}")
        print(f"  data._source.pcode: {sample['data']['_source']['pcode']}")
        print()
        print(f"Would upsert {len(payloads)} records in batches of {BATCH_SIZE}.")
        print("Run with --execute to write.")
        return

    api_key = get_api_key()
    api_url = get_api_url()
    print(f"API: {api_url}\n")

    total = 0
    for i in range(0, len(payloads), BATCH_SIZE):
        batch = payloads[i:i + BATCH_SIZE]
        result = graphql(UPSERT_BATCH, {"inputs": batch}, api_key, api_url)
        if result.get("errors"):
            sys.exit(f"ERROR: GraphQL errors on batch {i // BATCH_SIZE + 1}: {result['errors']}")
        written = result["data"]["upsertLocationMetadataBatch"]
        total += len(written)
        end = min(i + BATCH_SIZE, len(payloads))
        print(f"  Batch {i // BATCH_SIZE + 1}: wrote {len(written)} records ({i + 1}-{end})")

    print(f"\nDone. {total}/{len(payloads)} records written.")


if __name__ == "__main__":
    main()
