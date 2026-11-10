/**
 * Check the admin location tree of a clear-api environment (read only).
 *
 * It reads levels 0, 1 and 2 through the public `locations` query and reports,
 * per country:
 *   - level-1 and level-2 rows with no parent
 *   - rows whose `ancestorIds` name a location that does not exist
 *   - rows whose first ancestor is not their parent
 *
 * A row with no parent is invisible to anything that walks the tree from the
 * country (the pipeline's text locator does). This is how Sudan's Gezira state
 * went missing on dev: the state row was deleted and its 8 districts stayed
 * behind with no parent (ticket #1413).
 *
 * Usage:
 *   bun run scripts/check-location-tree.ts https://dev-api.clearinitiative.io/graphql
 *   bun run scripts/check-location-tree.ts <url> --countries SD,AF,VE
 *
 * Exits 1 when it finds a problem, so it can gate a data fix.
 */

interface Row {
  id: string;
  name: string;
  level: number;
  pCode: string | null;
  ancestorIds: string[];
  parent: { id: string } | null;
}

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const countriesFlag = args.indexOf("--countries");
const wanted = (countriesFlag >= 0 ? args[countriesFlag + 1] ?? "" : "SD,AF,VE")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

if (!url) {
  console.error("Usage: bun run scripts/check-location-tree.ts <graphql-url> [--countries SD,AF,VE]");
  process.exit(2);
}

async function level(n: number): Promise<Row[]> {
  const res = await fetch(url!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ locations(level: ${n}) { id name level pCode ancestorIds parent { id } } }`,
    }),
  });
  const body = (await res.json()) as { data?: { locations: Row[] }; errors?: { message: string }[] };
  if (!body.data) throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`);
  return body.data.locations;
}

const [countries, states, districts] = await Promise.all([level(0), level(1), level(2)]);
const rows = [...states, ...districts];
const known = new Set([...countries, ...rows].map((r) => r.id));
const describe = (r: Row) => `level ${r.level} ${r.pCode ?? "(no pCode)"} ${r.name} [${r.id}]`;

let problems = 0;
for (const code of wanted) {
  const country = countries.find((c) => c.pCode?.toUpperCase() === code);
  if (!country) {
    console.log(`${code}: no level-0 row with this pCode`);
    problems += 1;
    continue;
  }
  // A row belongs to the country by its ancestor chain or, when that is
  // broken, by its pCode prefix.
  const mine = rows.filter(
    (r) => r.ancestorIds.includes(country.id) || r.pCode?.toUpperCase().startsWith(code),
  );
  const noParent = mine.filter((r) => !r.parent);
  const deadAncestor = mine.filter((r) => r.ancestorIds.some((id) => !known.has(id)));
  const wrongChain = mine.filter((r) => r.parent && r.ancestorIds[0] !== r.parent.id);
  const count = (lvl: number) => mine.filter((r) => r.level === lvl).length;

  console.log(
    `${code} ${country.name}: ${count(1)} level-1, ${count(2)} level-2; ` +
      `${noParent.length} without a parent, ${deadAncestor.length} with a dead ancestor id, ` +
      `${wrongChain.length} with a first ancestor that is not the parent`,
  );
  for (const r of noParent) console.log(`  no parent: ${describe(r)}`);
  for (const r of deadAncestor) console.log(`  dead ancestor: ${describe(r)}`);
  for (const r of wrongChain) console.log(`  wrong chain: ${describe(r)}`);
  problems += noParent.length + deadAncestor.length + wrongChain.length;
}

process.exit(problems > 0 ? 1 : 0);
