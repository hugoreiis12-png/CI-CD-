/** @typedef {import("../types.js").AuditFinding} AuditFinding */
/** @typedef {import("../types.js").AuditOptions} AuditOptions */
/** @typedef {import("../types.js").AuditSeverity} AuditSeverity */
/** @typedef {import("../types.js").OsvVuln} OsvVuln */
/** @typedef {import("../types.js").SbomItem} SbomItem */
/** @param {SbomItem} item */
export function toOsvQuery(item) {
  /** @type {{ package: { name: string, ecosystem: string }, version?: string }} */
  const query = { package: { name: item.name, ecosystem: item.ecosystem } };
  const version = item.version ?? floorOf(item.range);
  if (version) query.version = version;
  return query;
}

/** Conservative query floor from a declared range (^1.2.3, ~1.2, >= 0.100). */
/** @param {string | null | undefined} range @returns {string | null} */
export function floorOf(range) {
  if (!range) return null;
  const floor = String(range).match(/\d[\w.]*\d|\d/)?.[0];
  return floor ?? null;
}

const BATCH_URL = "https://api.osv.dev/v1/querybatch";
const VULN_URL = "https://api.osv.dev/v1/vulns/";

/**
 * @param {string} url @param {RequestInit} init @param {AuditOptions} [options]
 * @returns {Promise<any>} parsed OSV JSON
 */
async function jsonFetch(url, init, { fetchImpl = (u, i) => fetch(u, i), timeoutMs = 10_000 } = {}) {
  // Hard timeout via race: injected/mocked fetch impls may ignore the signal.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`OSV request timed out: ${url} (${timeoutMs} ms)`)),
      timeoutMs,
    );
    // Not unref'd: it is cleared in `finally`, and it must keep the process
    // alive when the only pending work is a fetch that never settles.
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
/** @param {SbomItem[]} sbomItems @param {AuditOptions} [options] @returns {Promise<OsvVuln[][]>} */
export async function queryAdvisories(sbomItems, options = {}) {
  if (sbomItems.length === 0) return [];
  const body = JSON.stringify({ queries: sbomItems.map(toOsvQuery) });
  const payload = await jsonFetch(BATCH_URL, { method: "POST", body }, options);
  const results = payload?.results ?? [];
  return results.map((/** @type {{ vulns?: OsvVuln[] }} */ r) => r?.vulns ?? []);
}

/** Fetches advisory details for a bounded number of ids (oldest-first cap). */
/** @param {string[]} ids @param {AuditOptions} [options] @returns {Promise<Record<string, OsvVuln>>} */
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
/** @param {SbomItem[]} sbomItems @param {AuditOptions} [options] @returns {Promise<AuditFinding[]>} */
export async function collectCves(sbomItems, options = {}) {
  const maxDetails = options.maxDetails ?? 40;
  const batches = await queryAdvisories(sbomItems, options);
  /** @type {Map<string, number[]>} */
  const wanted = new Map();
  batches.forEach((vulns, index) => {
    for (const v of vulns) {
      if (!wanted.has(v.id)) wanted.set(v.id, []);
      wanted.get(v.id)?.push(index);
    }
  });

  const details = await fetchDetails([...wanted.keys()], options);

  /** @type {AuditFinding[]} */
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

  /** @type {Record<AuditSeverity, number>} */
  const order = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  findings.sort((a, b) =>
    (order[a.severity] - order[b.severity])
    || a.package.localeCompare(b.package)
    || a.id.localeCompare(b.id));
  return findings;
}

/** Severity of an OSV detail: GHSA database_specific, CVSS score, else UNKNOWN. */
/** @param {OsvVuln | undefined} detail @returns {AuditSeverity} */
export function severityOf(detail, id = "?") {
  const gh = detail?.database_specific?.severity;
  if (typeof gh === "string") {
    const upper = gh.toUpperCase();
    if (upper === "MODERATE") return "medium";
    if (upper === "CRITICAL" || upper === "HIGH" || upper === "MEDIUM" || upper === "LOW") {
      return /** @type {AuditSeverity} */ (upper.toLowerCase());
    }
  }
  const score = detail?.severity?.find((s) => s?.type === "CVSS_V3" || s?.type === "CVSS_V4")?.score;
  const numeric = typeof score === "string" && score.includes("/")
    ? null
    : Number.parseFloat(score ?? "");
  if (numeric !== null && Number.isFinite(numeric)) {
    if (numeric >= 9) return "critical";
    if (numeric >= 7) return "high";
    if (numeric >= 4) return "medium";
    return "low";
  }
  void id;
  return "unknown";
}

/** Fixed versions in the advisory for a given package (dedup, stable). */
/** @param {OsvVuln | undefined} detail @param {string} packageName @returns {string[]} */
export function fixedVersionsOf(detail, packageName) {
  if (!detail?.affected) return [];
  /** @type {string[]} */
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
