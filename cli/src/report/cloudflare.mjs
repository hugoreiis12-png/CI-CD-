import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeFile, exists, join } from "../lib/fs-tools.mjs";
import { CATALOG, OPERATIONAL } from "./catalog.mjs";

/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").RunRecord} RunRecord */
/** @typedef {import("../types.js").AuditRecord} AuditRecord */
/** @typedef {import("../types.js").AuditFinding} AuditFinding */

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "cloudflare-security-audit");
const require = createRequire(import.meta.url);
/** @type {{ validateDocument: (doc: unknown, schema: unknown) => string[], isSafeRelativeSourcePath: (p: string) => boolean }} */
const validator = require(path.join(VENDOR, "validate-findings.cjs"));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(VENDOR, "report-schema.json"), "utf8"));

/** Stable, line-free fingerprint that satisfies the skill's pattern for any path. */
const fingerprintOf = (/** @type {string} */ kind, /** @type {string} */ key) =>
  `${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

/**
 * One record per (rule, file): several matching lines in the same file are one
 * root cause, with every line kept as evidence.
 * @param {Finding[]} findings
 */
function groupByRoot(findings) {
  /** @type {Map<string, Finding[]>} */
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.file}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}

/**
 * @param {Finding[]} group same rule, same file
 * @returns {object}
 */
function gateRecord(group) {
  const [first] = group;
  const meta = CATALOG[first.rule];
  const lines = [...new Set(group.map((f) => f.line ?? 1))].sort((a, b) => a - b);
  const where = `${first.file}:${lines.join(",")}`;
  const base = {
    fingerprint: fingerprintOf(`esteira-gate:${first.rule}`, first.file),
    title: `${first.rule} em ${first.file}`,
    description: `${first.message} (Esteira gate, ${meta.attackClass}).`,
    trace: [{ kind: "sink", file: first.file, line: lines[0], scope: first.rule, description: first.message }],
    evidence: lines.map((line) => ({ file: first.file, line, description: `A regra ${first.rule} bateu nesta linha da mudança staged.` })),
  };
  if (meta.verdict === "confirmed") {
    return {
      verdict: "confirmed", ...base,
      root_cause: meta.rootCause,
      intended_behavior: meta.intended,
      conditions: [{ kind: "authorization_role", description: "Acesso de leitura ao repositório, a um fork ou a um clone depois que a mudança for enviada." }],
      execution: {
        attacker_perspective: "Qualquer pessoa com acesso de leitura ao histórico do repositório.",
        payloads: ["gh esteira gate"],
        instructions: ["Coloque a mudança em stage e rode `gh esteira gate` na raiz do repositório.", `Observe o finding ${first.rule} em ${where}.`],
        observed_result: `O gate encontrou ${first.rule} em ${where}; o valor encontrado não é reproduzido neste relatório.`,
      },
      remediation: { strategy: meta.fix },
      severity: {
        likelihood: { score: "high", reason: "O conteúdo do repositório é copiado para todo clone, fork e runner de CI." },
        impact: { score: "high", reason: "Uma credencial vazada dá todo o acesso que o sistema emissor permite, até ser revogada." },
        overall_severity: "high",
      },
      confidence: { score: "medium", reason: "Formato de credencial reconhecido por padrão; se ela ainda está ativa é um fato do lado do dono." },
    };
  }
  return {
    verdict: "needs_validation", ...base,
    claimed_root_cause: meta.rootCause,
    blockers: [meta.blocker ?? "Uma coincidência estática não prova o resultado no limite de confiança."],
    validation_plan: { local: meta.plan ?? meta.fix },
  };
}

/** @param {AuditFinding} f */
function auditRecord(f) {
  const fix = f.fixed.length ? `atualize ${f.package} para >= ${f.fixed[f.fixed.length - 1]}` : `veja em ${f.id} a resolução suportada`;
  return {
    verdict: "needs_validation",
    fingerprint: fingerprintOf("osv", `${f.id}\u0000${f.ecosystem}/${f.package}`),
    title: `${f.id} em ${f.ecosystem}/${f.package}@${f.version}`,
    description: `${f.summary} (advisory do OSV.dev; ${fix}).`,
    claimed_root_cause: `${f.package}@${f.version} está numa faixa de versões afetada por ${f.id}.`,
    trace: [{ kind: "sink", file: f.source, line: 1, scope: `${f.ecosystem}/${f.package}`, description: `Dependência declarada em ${f.source}.` }],
    evidence: [{ file: f.source, line: 1, description: `${f.package}@${f.version} bateu com ${f.id} (rótulo de severidade: ${f.severity}).` }],
    blockers: ["Coincidir a versão não prova que este projeto chega ao trecho vulnerável (skill: dependência com vulnerabilidade conhecida não é, sozinha, um finding)."],
    validation_plan: { local: `Encontre onde ${f.package} usa a API afetada; depois ${fix} e rode a suíte de testes.` },
  };
}

/** Newest gate run record under .esteira/runs (by createdAt). @param {string} root @returns {RunRecord | null} */
export function latestRun(root) {
  if (!exists(root, ".esteira/runs")) return null;
  /** @type {RunRecord | null} */
  let latest = null;
  for (const name of fs.readdirSync(join(root, ".esteira/runs"))) {
    if (!name.endsWith(".json")) continue;
    const run = readJson(root, `.esteira/runs/${name}`);
    if (run?.createdAt && (!latest || run.createdAt > latest.createdAt)) latest = run;
  }
  return latest;
}

/**
 * Converts gate + audit results into the Cloudflare skill's findings.json and
 * validates it with the skill's own validator. Invalid output is never written.
 * @param {{ run: RunRecord | null, audit: AuditRecord | null }} input
 */
export function toCloudflareFindings({ run, audit }) {
  /** @type {string[]} */
  const skipped = [];
  const gateFindings = (run?.findings ?? []).filter((f) => {
    if (OPERATIONAL.test(f.rule)) return false;
    if (!CATALOG[f.rule] || !validator.isSafeRelativeSourcePath(f.file)) {
      skipped.push(`${f.rule} ${f.file}`);
      return false;
    }
    return true;
  });
  const auditFindings = (audit?.findings ?? []).filter((f) => validator.isSafeRelativeSourcePath(f.source));
  const records = [
    ...groupByRoot(gateFindings).map(gateRecord),
    ...dedupe(auditFindings).map(auditRecord),
  ].sort((a, b) => (/** @type {any} */ (a).fingerprint < /** @type {any} */ (b).fingerprint ? -1 : 1));
  return { records, errors: validator.validateDocument(records, SCHEMA), skipped };
}

/** One record per advisory+package (an audit can list the same pair twice). @param {AuditFinding[]} findings */
const dedupe = (findings) => [...new Map(findings.map((f) => [`${f.id}\u0000${f.ecosystem}/${f.package}`, f])).values()];

/**
 * `gh esteira report`: writes `.esteira/reports/findings.json` (Cloudflare
 * security-audit skill contract) from the latest gate run and CVE audit.
 * @param {{ root: string, out?: string, json?: boolean }} input
 */
export function runReport({ root, out = ".esteira/reports/findings.json", json = false }) {
  const { records, errors, skipped } = toCloudflareFindings({
    run: latestRun(root),
    audit: readJson(root, ".esteira/audits/latest.json"),
  });
  if (errors.length > 0) {
    process.stderr.write(`Esteira report — a saída não passou no contrato de findings da Cloudflare:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    return { exitCode: 1, records: [], errors };
  }
  writeFile(root, out, `${JSON.stringify(records, null, 2)}\n`);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const r of records) counts[/** @type {any} */ (r).verdict] = (counts[/** @type {any} */ (r).verdict] ?? 0) + 1;
  if (json) process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
  else {
    process.stdout.write(
      `Esteira report — contrato de findings da skill de security-audit da Cloudflare\n` +
      `Registros   : ${records.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nenhum"})\n` +
      (skipped.length ? `Ignorados   : ${skipped.length} (regra sem mapeamento ou caminho inseguro): ${skipped.join("; ")}\n` : "") +
      `Gravado     : ${out} (validado com vendor/cloudflare-security-audit)\n`,
    );
  }
  return { exitCode: 0, records, errors };
}
