# Esteira — secure adaptive CI/CD & vulnerability-audit pipeline

**Esteira** is a security-first CI/CD system that integrates into *any* local project with a single command and no prior infrastructure required:

```bash
gh esteira init
```

It analyzes the project's stack and architecture, wires an adaptive CI/CD pipeline around it, and installs a **reinforced pre-commit security gate**: every commit is validated, tested in an isolated playground, and cryptographically bound to its approval before it is allowed to reach the remote repository. It also continuously audits the project for exposed CVEs — locally and on GitHub — and reports each vulnerability with a concise fix path.

> This project is security-oriented by design, not a drop-in deployment. Replace example names, registries, repo URLs, and policy thresholds before production use.

---

## 1. Vision & core guarantees

| Guarantee | Meaning |
|---|---|
| **Zero-infrastructure onboarding** | The user does not need to build or own CI/CD infra. One command detects and adapts. |
| **Nothing lands unvalidated** | A commit only reaches the Git remote after passing the security pipeline + gate matrix. |
| **The repo is never touched during testing** | All gates run against an isolated copy (playground), never against the working tree or remote. |
| **Regressions block pushes** | If a commit breaks existing code (bad refactor, impacted functions/classes/methods), the push is blocked with a precise report. |
| **Reinforced integrity (security SHA)** | The approved snapshot is content-addressed: push is only permitted when the tree exactly matches the attested SHA, eliminating tampering between validation and push (TOCTOU). |
| **Vulnerability visibility** | Cluster-backed scanners expose CVEs in the local project and the GitHub repo, each with severity and a concise remediation. |

## 2. Architecture overview

```text
                    local project
                         │  (gh esteira init)
                         ▼
        ┌────────── adaptive integrator ──────────┐
        │  stack / arch detection                 │
        │  generates: workflows, hooks, policies  │
        └────────────────┬────────────────────────┘
                         ▼
        developer commit → pre-commit security gate
                │      ├─ static & semantic validations
                │      └─ risk classification of the diff
                ▼
        ┌─── sandbox playground (isolated copy) ───┐
        │  100+ gates: functions, classes, methods,│
        │  paradigms, contracts, regressions, SAST │
        └───────┬──────────────────────┬───────────┘
             REPROVED                APPROVED
                │                        │
        push blocked,                integrity SHA
        precise failure report       attested → clean push
                                         │
                                         ▼
                                 GitHub repository
                                         │
                                 CI/CD (Actions) → GitOps (Argo CD)
                                         │
                    ┌────────── CVE audit cluster ───────┐
                    │  scans local project + remote repo │
                    │  findings: CVE, severity, fix path │
                    └────────────────────────────────────┘
```

## 3. Components

### 3.1 `gh esteira init` — adaptive integrator

- Detects the project's stack and architecture (languages, package managers, frameworks, monorepo layout, build/test tooling, containerization).
- Generates only the adapters actually needed: workflows, commit hooks, gate configuration, scanner bindings.
- Idempotent: re-running `init` reconciles existing configuration instead of duplicating it.
- Never requires the user to provision a cluster or registry; Esteira's own shared infrastructure runs the heavy work.

### 3.2 Pre-commit security gate

Installed as a commit hook plus a server-side verification. On every commit:

1. The diff is captured and classified (risk, scope, affected symbols).
2. Static and semantic validations run first (syntax, types, lint, secret detection, dangerous-pattern checks).
3. Validated snapshots are forwarded to the playground; nothing runs against the real repo.

### 3.3 Playground — 100+ gate matrix

An isolated working copy of the project built from the commit content. Gates include (non-exhaustive; the matrix is configuration-driven and grows with the stack adapters):

- **Unit & symbol level:** functions, classes, methods, signatures, invariants.
- **Contract & regression level:** execution of the project's existing test suite against the changed code; comparison of pre/post behavior of every touched symbol.
- **Paradigm & design level:** SOLID/architecture conformance checks, coupling/cohesion metrics, side-effect isolation, dead-code and abstraction-leak detection.
- **Security level:** SAST, secrets, dependency confusion, injection-prone patterns.

Verdicts:

- **Reproved:** the push is blocked. The report states *what* broke (impacted symbol/gate), *why*, and *how to fix it* (suggested patch direction for refactor errors).
- **Approved:** the playground result is sealed into an attestation bound to the commit tree's SHA.

**Security SHA (reinforced integrity).** The attestation records the exact content hash validated in the playground. The push step re-computes the tree hash and refuses to proceed unless it matches — if even one byte changed between validation and push, the commit is rejected and must be re-gated. This makes the validated code and the pushed code provably identical.

### 3.4 CVE audit cluster

A toolset of cluster-deployed scanners (SBOM generation, dependency advisories, container/image scanning, IaC and secret checks) that:

- Scans the **local project** (source, dependency lockfiles, containers) and the **GitHub repository** (including CI artifacts).
- Consolidates findings into a single concise report: CVE identifier, affected component/version, severity, exploit exposure, and a concrete remediation ("upgrade X to ≥ Y", patch, or config change).
- Re-runs on demand and on pipeline events so new CVEs surface immediately after they are published.

### 3.5 GitOps baseline (Actions + Argo CD)

For projects that deploy Kubernetes workloads, Esteira can additionally generate the standard baseline:

- CI on GitHub Actions (build, test, scan), OCI images tagged by immutable commit SHA.
- A separate GitOps repository as the source of truth; Argo CD reconciles cluster state; CI holds no Kubernetes credentials.
- PostgreSQL (or equivalent) managed outside application pods.

---

## 4. Repository layout

```text
.
├── .github/workflows/ci.yml
├── .github/workflows/build-publish.yml
├── apps/web/Dockerfile
├── apps/api/Dockerfile
├── packages/db/prisma/schema.prisma
├── ci/project.yaml
├── ci/validate-project.mjs
├── cli/                       # `gh esteira` extension: init, gate, audit
├── gate/                      # pre-commit security gate + attestation
├── playground/                # isolated runner + gate matrix definitions
├── audit/                     # CVE cluster orchestration & reporting
├── security_audits/           # audit trail logs
├── security_config.json       # users, targets, permissions, sessions
└── deploy/k8s/base/
```

## 5. Assumptions (deployment baseline)

- pnpm workspace with `apps/web` (Next.js), `apps/api` (NestJS), `packages/db` (Prisma) — for the reference project.
- GitHub Actions runs CI and builds OCI images.
- A separate GitOps repository is the source of truth for cluster state.
- Argo CD reads the GitOps repository; CI does not need Kubernetes credentials.
- Images are published by immutable commit SHA tags. Never deploy `latest`.

## 6. Required project scripts (reference workspace)

The root `package.json` should expose: `lint`, `typecheck`, `test`, `build`, `db:validate` (`prisma validate`), `db:generate` (`prisma generate`). The example workflows intentionally fail if the project scripts are absent.

## 7. GitHub repository configuration

1. Protect `main`: PR required, at least one independent approval, dismiss stale approvals, require CI checks, block force pushes and deletions.
2. Set workflow permissions to read-only by default; grant `packages: write` only to the publish job.
3. Create GitHub Environments `staging` and `production`; require reviewers for production.
4. Use GitHub OIDC and short-lived credentials; never store Kubernetes credentials in Actions.
5. Pin third-party Actions to verified full commit SHAs before production.
6. Enable secret scanning / push protection and Dependabot or equivalent.
7. Configure registry retention and prohibit overwriting release tags.

## 8. Variables, secrets, and migrations

**Variables:** `REGISTRY`, `IMAGE_NAMESPACE`, `GITOPS_REPOSITORY`.

**Secrets:** use `GITHUB_TOKEN` for GHCR publishing. For cross-repository GitOps PRs, prefer a narrowly scoped GitHub App token (Contents + Pull requests on the GitOps repo only); the promotion job is intentionally not automated.

**Migrations:** never run production migrations from every replica or from untrusted PR workflows. Use a separately controlled release job, a restricted database role, and backward-compatible expand/contract migrations with `prisma migrate deploy`. Review destructive SQL manually.

## 9. Rollback

Roll back application code by reverting the GitOps image digest/tag through a reviewed PR. Database schema rollback is separate: prefer forward fixes. A code rollback cannot safely reverse a destructive migration.

## 10. Roadmap

1. **M1 — CLI & analyzer (done):** `gh esteira init|analyze` (`cli/`), stack/arch detection (Node/pnpm/yarn/bun, Python/poetry/uv, Go, Rust, JVM, .NET, Ruby, PHP + containers/K8s/Helm/Terraform/CI providers), idempotent adapter generation (`.esteira/project.json`, workflow, pre-commit hook via `core.hooksPath`), `--dry-run` safety. Validated: 6/6 tests, hook gated a real commit, `gh extension install` working.
2. **M2 — Pre-commit gate (done):** `gh esteira gate` runs on staged changes: secret detection (AWS/GitHub/npm/Google/Slack tokens, private keys, hardcoded credentials — with placeholder/`test` allowlists), dangerous-pattern checks (`eval`, string-based `exec`, curl-pipe-shell, `rm -rf /`, `chmod 777`, disabled TLS, SQL concatenation), oversized-blob guard, and a per-commit audit record under `.esteira/runs/<snapshot>.json` bound to a content-addressed SHA-256 snapshot (the security-SHA foundation). Policy comes from `.esteira/project.json` (`gate.mode: block|audit`, `blockAt`, `maxFileBytes`); a failed check fails closed. Exit 1 blocks the commit through `core.hooksPath`.
3. **M3 — Playground:** isolated snapshot runner, first gate matrix (unit/contract/regression), verdict reports, integrity SHA attestation.
4. **M4 — CVE audit:** SBOM + advisory scanners against local project and repo, consolidated remediation report.
5. **M5 — GitOps baseline & hardening:** Argo CD template, SHA-pinned Actions, environments, SBOM/signing.

## 11. Before production

- [ ] Pin all third-party Actions to verified full-length commit SHAs.
- [ ] Add SAST, dependency scanning, secret scanning and container scanning per organization policy.
- [ ] Add SBOM and image signing / provenance attestation.
- [ ] Replace example manifests; configure NetworkPolicy, Pod Security, ingress TLS, resource requests/limits and probes.
- [ ] Configure External Secrets / Secrets Store CSI / cloud secret manager; no plaintext credentials in Git.
- [ ] Configure backups, restore tests, alerting and post-deploy smoke tests.
- [ ] Validate with `actionlint`, `kubeconform`, and a staging environment.
- [ ] Review the gate matrix policy thresholds and the CVE severity cutoffs for report/block behavior.
