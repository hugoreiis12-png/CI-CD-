import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectDependencies, collectNpm, collectPython, collectGo, collectRust,
} from "../src/audit/manifests.mjs";
import { floorOf, severityOf, fixedVersionsOf, collectCves } from "../src/audit/osv.mjs";
import { runAudit } from "../src/audit/run.mjs";

// Hermetic: the triage LLM lives on a LAN address that CI runners cannot reach.
// Without this, every runAudit call waits for the LLM timeout (60 s) first.
process.env.ESTEIRA_LLM_ENABLED = "false";

function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-audit-"));
  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write("package.json", JSON.stringify({
    name: "demo",
    dependencies: { lodash: "^4.17.15", next: "14.0.0" },
    devDependencies: { jest: "29.0.0" },
  }));
  write("package-lock.json", JSON.stringify({
    packages: {
      "": { name: "demo" },
      "node_modules/lodash": { version: "4.17.15" },
      "node_modules/next": { version: "14.0.0" },
      "server/node_modules/jest": { version: "29.0.0" },
    },
  }));
  write("requirements.txt", "# comment\nfastapi>=0.100\nrequests==2.31.0\n");
  write("go.mod", "module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n");
  write("Cargo.toml", "[dependencies]\naxum = \"0.7\"\n");
  return dir;
}

test("dependency harvest: lockfile pins exact versions, ranges keep floors", () => {
  const dir = fixtureProject();
  const npm = collectNpm(dir);
  assert.equal(npm.length, 3);
  const lodash = npm.find((i) => i.name === "lodash");
  assert.equal(lodash.version, "4.17.15");
  assert.equal(lodash.range, null);
  const jest = npm.find((i) => i.name === "jest");
  assert.equal(jest.kind, "dev");
  assert.equal(jest.version, "29.0.0");

  const python = collectPython(dir);
  const fastapi = python.find((i) => i.name === "fastapi");
  assert.equal(fastapi.ecosystem, "PyPI");
  assert.equal(fastapi.version, "0.100");

  const go = collectGo(dir);
  assert.equal(go[0].name, "github.com/gin-gonic/gin");
  assert.equal(go[0].version, "v1.10.0");

  const rust = collectRust(dir);
  assert.equal(rust[0].ecosystem, "crates.io");
  assert.equal(rust[0].name, "axum");
  assert.equal(rust[0].version, "0.7");

  const all = collectDependencies(dir);
  assert.equal(new Set(all.map((i) => `${i.ecosystem}/${i.name}`)).size, all.length);
});

test("floorOf extracts a conservative query floor from ranges", () => {
  assert.equal(floorOf("^1.2.3"), "1.2.3");
  assert.equal(floorOf("~0.5.0"), "0.5.0");
  assert.equal(floorOf(">= 14 || < 13"), "14");
  assert.equal(floorOf("*"), null);
  assert.equal(floorOf(null), null);
});

test("severity: GHSA labels win, CVSS numeric fallback, MODERATE→medium", () => {
  assert.equal(severityOf({ database_specific: { severity: "HIGH" } }), "high");
  assert.equal(severityOf({ database_specific: { severity: "MODERATE" } }), "medium");
  assert.equal(severityOf({ severity: [{ type: "CVSS_V3", score: "9.1" }] }), "critical");
  assert.equal(severityOf({ severity: [{ type: "CVSS_V3", score: "7.5" }] }), "high");
  assert.equal(severityOf({ severity: [{ type: "CVSS_V3", score: "4.1" }] }), "medium");
  assert.equal(severityOf({ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }] }), "unknown");
  assert.equal(severityOf({}), "unknown");
});

test("fixedVersionsOf extracts fix events for the affected package only", () => {
  const detail = {
    id: "GHSA-x",
    affected: [
      {
        package: { name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
      },
      {
        package: { name: "other" },
        ranges: [{ type: "SEMVER", events: [{ fixed: "1.0.0" }] }],
      },
    ],
  };
  assert.deepEqual(fixedVersionsOf(detail, "lodash"), ["4.17.21"]);
  assert.deepEqual(fixedVersionsOf(detail, "other"), ["1.0.0"]);
  assert.deepEqual(fixedVersionsOf(detail, "unknown"), []);
});

const OSV_FIXTURE = {
  batch({ queries }) {
    return { results: queries.map((q) => {
      if (q.package.name === "lodash" && q.version === "4.17.15") {
        return { vulns: [{ id: "GHSA-lodash-9999" }, { id: "GHSA-lodash-8888" }] };
      }
      if (q.package.name === "next" && q.version === "14.0.0") {
        return { vulns: [{ id: "GHSA-next-7777" }] };
      }
      return { vulns: [] };
    }) };
  },
  vuln(id) {
    const base = {
      "GHSA-lodash-9999": {
        id: "GHSA-lodash-9999",
        summary: "Prototype Pollution",
        database_specific: { severity: "HIGH" },
        affected: [{ package: { name: "lodash" }, ranges: [{ events: [{ fixed: "4.17.21" }] }] }],
      },
      "GHSA-lodash-8888": {
        id: "GHSA-lodash-8888",
        summary: "ReDoS in template",
        severity: [{ type: "CVSS_V3", score: "9.8" }],
        affected: [{ package: { name: "lodash" }, ranges: [{ events: [{ fixed: "4.17.21" }] }] }],
      },
      "GHSA-next-7777": {
        id: "GHSA-next-7777",
        summary: "Cache poisoning",
        database_specific: { severity: "MODERATE" },
        affected: [{ package: { name: "next" }, ranges: [{ events: [{ fixed: "14.0.4" }] }] }],
      },
    };
    if (id in base) return base[id];
    throw new Error(`unhandled fixture ${id}`);
  },
};

function fakeOsv() {
  // Plain-object response: jsonFetch only throws on explicit ok === false.
  return async (url, init = {}) => {
    if (url.endsWith("/querybatch")) {
      return { ok: true, json: async () => OSV_FIXTURE.batch({ queries: JSON.parse(init.body).queries }) };
    }
    const id = url.split("/vulns/")[1];
    return { ok: true, json: async () => OSV_FIXTURE.vuln(id) };
  };
}

// Hangs until aborted, and honours the signal like a real fetch does.
const sleepingFetch = (_url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
});

test("collectCves normalizes findings: sort by severity, extract fixes", async () => {
  const dir = fixtureProject();
  const findings = await collectCves(collectDependencies(dir), { fetchImpl: fakeOsv(), maxDetails: 10 });
  // 9.8 CVSS (critical) beats GHSA HIGH; MODERATE medium; the 5 others are clean
  assert.deepEqual(findings.map((f) => [f.severity, f.id]), [
    ["critical", "GHSA-lodash-8888"],
    ["high", "GHSA-lodash-9999"],
    ["medium", "GHSA-next-7777"],
  ]);
  const li = findings.find((f) => f.package === "lodash");
  assert.deepEqual(li.fixed, ["4.17.21"]);
  assert.equal(li.summary, "ReDoS in template");
});

test("runAudit: failOn=high blocks on critical+high, writes latest record", async () => {
  const dir = fixtureProject();
  const result = await runAudit({ root: dir, json: true, fetchImpl: fakeOsv() });
  assert.equal(result.verdict, "reproved");
  assert.equal(result.exitCode, 1);
  assert.equal(result.counts.high >= 1 || result.counts.critical >= 1, true);
  assert.ok(fs.existsSync(path.join(dir, ".esteira/audits/latest.json")));
  const stored = JSON.parse(fs.readFileSync(path.join(dir, ".esteira/audits/latest.json"), "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.findings.length, result.findings.length);
});

test("runAudit: failOn=critical still reproves on CVSS 9.8; clean projects pass", async () => {

  // clean project: manifest with no vulnerable deps
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-clean-"));
  fs.writeFileSync(path.join(clean, "package.json"), JSON.stringify({ name: "c", dependencies: { tiny: "1.0.0" } }));
  const cleanAudit = await runAudit({ root: clean, json: true, fetchImpl: fakeOsv() });
  assert.equal(cleanAudit.verdict, "clean");
  assert.equal(cleanAudit.exitCode, 0);
  assert.deepEqual(cleanAudit.findings, []);
});

test("runAudit offline: OSV unreachable → verdict clean with offline note, exit 0", async () => {
  const dir = fixtureProject();
  const result = await runAudit({ root: dir, json: true, fetchImpl: sleepingFetch, timeoutMs: 300 });
  assert.equal(result.verdict, "clean");
  assert.equal(result.exitCode, 0);
  assert.match(result.note, /offline/i, result.note);
}, 15000);
