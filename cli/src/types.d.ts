// Shared contracts for the Esteira CLI. Type-only: the runtime is plain .mjs
// checked by `tsc --noEmit` (checkJs). Import from JSDoc with
// `@typedef {import("../types.js").Finding} Finding` (path relative to the file).

export type Severity = "low" | "medium" | "high";
export type GateMode = "block" | "audit";
export type Verdict = "approved" | "reproved";

/** A static-check or playground result inside a gate run. */
export interface Finding {
  check: string;
  severity: Severity;
  rule: string;
  file: string;
  line: number | null;
  message: string;
}

/** One staged path as seen by the gate (gate/staged.mjs). */
export interface StagedFile {
  path: string;
  insertions: number | null;
  deletions: number | null;
  added: string[];
  addedLines: number[];
  blob: string | null;
  size: number | null;
  binary: boolean;
  /** Gitlink to an embedded repository (mode 160000): content not scanned here. */
  submodule: boolean;
}

export interface PatchFile {
  path: string;
  added: string[];
  addedLines: number[];
}

export interface PlaygroundSettings {
  enabled: boolean;
  baseline: boolean;
  timeoutMs: number;
}

export interface GateConfig {
  mode: GateMode;
  blockAt: Severity;
  maxFileBytes: number;
  playground: PlaygroundSettings;
}

/** Input every static check receives. */
export interface CheckContext {
  root: string;
  files: StagedFile[];
  config: GateConfig;
}
export type Check = (ctx: CheckContext) => Finding[];

export type CommandKey = "lint" | "typecheck" | "test" | "build";
export type Commands = Partial<Record<CommandKey, string | null>>;

/** Result of one playground command (playground/runner.mjs). */
export interface CommandResult {
  cmd: string;
  code: number | "timeout" | "error";
  ms: number;
  stdout: string;
}

export interface PlaygroundOutcome {
  ran: boolean;
  lines?: string[];
  results?: unknown[];
  reason?: string;
}

/** `.esteira/runs/<id>.json` — the gate's audit record and push attestation. */
export interface RunRecord {
  schemaVersion: 1;
  id: string;
  snapshot: string;
  tree: string | null;
  attested: boolean;
  tool: string;
  createdAt: string;
  root: string;
  verdict: Verdict;
  mode: GateMode;
  blockAt: Severity;
  stats: { files: number; insertions: number; deletions: number; findings: number };
  findings: Finding[];
  playground: PlaygroundOutcome | null;
  note: string | null;
  path?: string | null;
}

/** A blob listed by `git ls-files -s` / `git ls-tree -r`. */
export interface BlobEntry {
  path: string;
  blob: string | null;
}

// ---- project profile (lib/profile.mjs, detectors/*) ----

export interface LanguageFinding {
  type: "language";
  id: string;
  confidence: number;
  runtime?: Record<string, string>;
  packageManager?: string | null;
  frameworks?: string[];
  workspaces?: string | null;
  evidence?: string[];
  commands?: Commands;
}

export interface InfraProfile {
  containers: boolean;
  kubernetes: boolean;
  helm: boolean;
  terraform: boolean;
  ansible: boolean;
  argocd: boolean;
  ciProviders: string[];
  hasPipelines: boolean;
}

export interface InfraFinding {
  type: "infra";
  id: string;
  confidence: number;
  infra: InfraProfile;
  evidence?: string[];
  workspaces?: string | null;
}

export type DetectorFinding = LanguageFinding | InfraFinding;
export type Detector = (root: string, files: FileFingerprint) => DetectorFinding | null;

export interface FileFingerprint {
  total: number;
  counts: Record<string, number>;
}

export interface Language {
  id: string;
  confidence: number;
  runtime: Record<string, string>;
  packageManager: string | null;
  frameworks: string[];
  evidence: string[];
  commands: Commands;
}

export interface Gap {
  id: string;
  message: string;
}

/** A project found one folder below a root that has no manifest of its own. */
export interface Subproject {
  path: string;
  languages: { id: string; packageManager: string | null }[];
  /** The folder is its own git repository (not tracked by the parent). */
  gitRepo: boolean;
}

export interface Profile {
  schemaVersion: 1;
  root: string;
  generatedAt: string;
  files: { total: number; signatures: Record<string, number> };
  languages: Language[];
  monorepo: { isMonorepo: boolean; tool: string | null; layout: string[] };
  infra: InfraProfile;
  commands: Record<CommandKey, string | null>;
  gaps: Gap[];
  warnings: string[];
  subprojects: Subproject[];
}

/** `.esteira/project.json` as written by `init`; user-editable. */
export interface Manifest {
  schemaVersion?: number;
  profile?: Partial<Profile>;
  gate?: {
    mode?: unknown;
    blockAt?: unknown;
    maxFileBytes?: number;
    playground?: Partial<PlaygroundSettings>;
  };
  audit?: { failOn?: string; maxDetails?: number; sources?: string[] };
  gitops?: { repo?: string };
}

// ---- audit (audit/*) ----

export type Ecosystem = "npm" | "PyPI" | "Go" | "crates.io";
export type AuditSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface SbomItem {
  ecosystem: Ecosystem;
  name: string;
  /** Exact version when a lockfile pins it. */
  version: string | null;
  /** Declared range when no exact version is known. */
  range: string | null;
  source: string;
  direct?: boolean;
  kind?: "prod" | "dev";
}

export interface AuditFinding {
  id: string;
  package: string;
  version: string;
  source: string;
  severity: AuditSeverity;
  summary: string;
  fixed: string[];
  ecosystem: Ecosystem;
}

/** `.esteira/audits/latest.json`. */
export interface AuditRecord {
  schemaVersion: 1;
  tool: string;
  kind: "cve-audit";
  generatedAt: string;
  root: string;
  sources: string[];
  failOn: AuditSeverity;
  verdict: "reproved" | "clean";
  counts: Partial<Record<AuditSeverity, number>>;
  sbom: { total: number; byEcosystem: Record<string, number> };
  advisoryCount: number;
  blockers: number;
  findings: AuditFinding[];
  note: string | null;
  path?: string | null;
}

export interface AuditOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxDetails?: number;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Shape of the subset of the OSV.dev API the audit reads. */
export interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { events?: { introduced?: string; fixed?: string }[] }[];
  }[];
  unavailable?: boolean;
}

// ---- process helpers ----

/** Injectable `git`/`gh` runners (tests stay offline). */
export type ExecImpl = (cmd: string, args: string[]) => string | Promise<string>;
export type GhImpl = (args: string[]) => string | Promise<string>;
