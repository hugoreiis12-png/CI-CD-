export function toOsvQuery(item) {
  const query = { package: { name: item.name, ecosystem: item.ecosystem } };
  const version = item.version ?? floorOf(item.range);
  if (version) query.version = version;
  return query;
}

/** Conservative query floor from a declared range (^1.2.3, ~1.2, >= 0.100). */
export function floorOf(range) {
  if (!range) return null;
  const floor = String(range).match(/\d[\w.]*\d|\d/)?.[0];
  return floor ?? null;
}

const BATCH_URL = "https://api.osv.dev/v1/querybatch";
const VULN_URL = "https://api.osv.dev/v1/vulns/";

async function jsonFetch(url, init, { fetchImpl = (u, i) => fetch(u, i), timeoutMs = 10_000 } = {}) {
  // Hard timeout via race: injected/mocked fetch impls may ignore the signal.
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`OSV request timed out: ${url} (${timeoutMs} ms)`)),
      timeoutMs,
    );
    handle?.unref?.();
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeout,
    ]);
    if (response?.ok === false) {
      throw new Error(`OSV request failed: ${url} -> ${response?.status ?? "network"}`);
    }
    return response.json();
  } finally {
    clearTimeout(handle);
  }
}

/**
 * Asks OSV.dev in one batch for known advisories of every dependency.
 * Returns raw results aligned with sbom items (by index).
 */
export async function queryAdvisories(sbomItems, options = {}) {
  if (sbomItems.length === 0) return [];
  const body = JSON.stringify({ queries: sbomItems.map(toOsvQuery) });
  const payload = await jsonFetch(BATCH_URL, { method: "POST", body }, options);
  const results = payload?.results ?? [];
  return results.map((r) => r?.vulns ?? []);
}

/** Fetches advisory details for a bounded number of ids (oldest-first cap). */
export async function fetchDetails(ids, options = {}) {
  const maxDetails = options.maxDetails ?? 40;
  const uniqIds = [...new Set(ids)].slice(0, maxDetails);
  const details = await Promise.all(
    uniqIds.map(async (id) => {
      try {
        return await jsonFetch(`${VULN_URL}${id}`, {}, options);
      } catch {
        return { id, unavailable: true };
      }
    }),
  );
  return Object.fromEntries(details.filter(Boolean).map((d) => [d.id, d]));
}

/**
 * Full advisory pass: batch query + limited detail fetch.
 * Returns normalized findings sorted by severity (desc), package, id.
 * Pure given the network is encapsulated in fetchImpl (tests inject fakes).
 */
export async function collectCves(sbomItems, options = {}) {
  const maxDetails = options.maxDetails ?? 40;
  const batches = await queryAdvisories(sbomItems, options);
  const wanted = new Map();
  batches.forEach((vulns, index) => {
    for (const v of vulns) {
      if (!wanted.has(v.id)) wanted.set(v.id, []);
      wanted.get(v.id).push(index);
    }
  });

  const details = await fetchDetails([...wanted.keys()], options);

  const findings = [];
  for (const [id, indexes] of wanted) {
    const detail = details[id];
    for (const index of indexes) {
      const item = sbomItems[index];
      if (!item) continue;
      const fixed = fixedVersionsOf(detail, item.name);
      findings.push({
        id,
        package: item.name,
        version: item.version ?? floorOf(item.range) ?? "?",
        source: item.source,
        severity: severityOf(detail, id),
        summary: detail?.summary ?? "advisory (details unavailable)",
        fixed,
        ecosystem: item.ecosystem,
      });
    }
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  findings.sort((a, b) =>
    (order[a.severity] - order[b.severity])
    || a.package.localeCompare(b.package)
    || a.id.localeCompare(b.id));
  return findings;
}

/** Severity of an OSV detail: GHSA database_specific, CVSS score, else UNKNOWN. */
export function severityOf(detail, id = "?") {
  const gh = detail?.database_specific?.severity;
  if (typeof gh === "string") {
    const upper = gh.toUpperCase();
    if (upper === "MODERATE") return "medium";
    if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(upper)) return upper.toLowerCase();
  }
  const score = detail?.severity?.find((s) => s?.type === "CVSS_V3" || s?.type === "CVSS_V4")?.score;
  const numeric = typeof score === "string" && score.includes("/")
    ? null
    : Number.parseFloat(score ?? "");
  if (Number.isFinite(numeric)) {
    if (numeric >= 9) return "critical";
    if (numeric >= 7) return "high";
    if (numeric >= 4) return "medium";
    return "low";
  }
  void id;
  return "unknown";
}

/** Fixed versions in the advisory for a given package (dedup, stable). */
export function fixedVersionsOf(detail, packageName) {
  if (!detail?.affected) return [];
  const fixed = [];
  for (const affected of detail.affected) {
    if (affected?.package?.name !== packageName) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        const value = event?.fixed;
        if (value && !fixed.includes(value)) fixed.push(value);
      }
    }
  }
  return fixed;
}
