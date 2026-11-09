# Esteira — secure adaptive CI/CD & vulnerability-audit pipeline

**Esteira** is a security-first CI/CD system that integrates into *any* local project with a single command and no prior infrastructure required:

```bash
gh esteira init
```

It analyzes the project's stack and architecture, wires an adaptive CI/CD pipeline around it, and installs a **reinforced pre-commit security gate**: every commit is validated, tested in an isolated playground, and cryptographically bound to its approval before it is allowed to reach the remote repository. It also continuously audits the project for exposed CVEs — locally and on GitHub — and reports each vulnerability with a concise fix path.

> This project is security-oriented by design, not a drop-in deployment. Replace example names, registries, repo URLs, and policy thresholds before production use.

---

## Install

> **End-user manual (pt-BR): [docs/MANUAL.md](docs/MANUAL.md)** — install, daily flow, rules and fixes, configuration, GitOps, troubleshooting.

Requirements: `gh` (authenticated), `git`, Node.js ≥ 20.

```bash
gh extension install hugoreiis12-png/gh-esteira --pin v0.1.2
gh esteira --version
```

Upgrade: `gh extension remove esteira && gh extension install hugoreiis12-png/gh-esteira --pin vX.Y.Z` (pinned extensions are not touched by `gh extension upgrade`). Without `--pin`, `gh` installs the default branch and `gh extension upgrade esteira` follows it.
Generated workflows fetch the same repository at `ESTEIRA_REF` (the release tag; `gh esteira pin` rewrites it to a commit SHA) in a step without secrets and run `node "$ESTEIRA" …`.

Then, inside any project: `gh esteira init` → commit (the pre-commit gate runs) → push / open a PR (the `security-gate` job re-runs the gate server-side; make it a required check).

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

Installed as local `pre-commit`/`pre-push` hooks plus the `security-gate` job in the generated CI workflow. On every commit:

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

**Security SHA (reinforced integrity).** The attestation records the exact content hash validated in the playground. The push step re-computes the tree hash and refuses to proceed unless it matches — if even one byte changed between validation and push, the commit is rejected and must be re-gated. This makes the validated code and the pushed code identical for any push that goes through the hook.

**Trust model.** The local hooks are a fast feedback loop, not the enforcement point: `git push --no-verify` skips `pre-push`, and `.esteira/runs/*.json` records are unsigned files a user can write. The authoritative check is the `security-gate` job in `esteira-ci.yml`, which re-runs `gh esteira gate` on the full change set since the base commit. Make it a **required status check** in branch protection; without that, the push gate is advisory. The CI job runs `gh esteira gate --policy-ref "$BASE_SHA"`, so the gate policy (`.esteira/project.json`) comes from the base commit, never from the PR it judges; unknown `mode`/`blockAt` values block. The gate fails closed when the change set cannot be read, diffs ignore repo `.gitattributes` (`--text --no-textconv --no-ext-diff`) and files are diffed one by one by exact path (`-z`, `:(literal)`). `.esteira/hooks/` is git-ignored: each clone gets its hooks from `gh esteira init`. Hooks fail closed when no gate CLI is found (`ESTEIRA_ALLOW_UNGATED=1` is the explicit, logged bypass) and chain any hooks that were active before `init`.

### 3.4 CVE audit cluster

A toolset of scanners (dependency advisories via OSV.dev today; SBOM generation, container/image scanning, IaC and secret checks as the cluster adapters grow) that:

- Scans the **local project** (source, dependency lockfiles, containers) and the **GitHub repository** (via CI runs on the checkout).
- Consolidates findings into a single concise report: advisory/CVE identifier, affected component/version, severity, exploit exposure, and a concrete remediation ("upgrade X to >= Y", patch, or config change).
- Re-runs on demand (`gh esteira audit`), and on pipeline events so new CVEs surface immediately after they are published; `audit.failOn` turns critical findings into hard failures.

### 3.5 GitOps baseline (Actions + Argo CD)

For projects that deploy Kubernetes workloads, `gh esteira gitops` generates the standard baseline (base manifests + environment overlays + Argo CD Applications + a release workflow). Combined with `gh esteira pin`, this makes it hardening-compliant:

- CI on GitHub Actions (build, test, scan); OCI images tagged by immutable commit SHA; Argo CD reconciles cluster state; CI holds no Kubernetes credentials.
- `staging` overlay auto-syncs (prune + self-heal); `production` requires a reviewed promotion PR (protected environment, required reviewers).
- Release images carry SBOM + provenance attestations (`provenance: mode=max`).
- Every third-party Action in generated workflows is SHA-pinned with an audit comment pointing at the original ref.

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
├── cli/                       # `gh esteira` extension: init, analyze, gate, attest, audit, gitops, pin
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
3. **M3 — Playground (done):** isolated snapshot runner — the staged index becomes an anonymous `commit-tree` (objects only, no ref updates), extracted via `git archive` into temp dirs; the project's own suite runs twice (staged + HEAD baseline) and failure deltas are judged (`suite-failure`, `regression`, `pre-existing-failures`) plus a typecheck gate and hard timeouts. Host runner variables are sanitized (`NODE_TEST_CONTEXT` etc. — bugs that make suites report exit 0 on failure). Verdicts feed the gate report; every approved run records an attestation, and `gh esteira attest --verify` (wired into a `pre-push` hook) blocks any push whose HEAD is not content-identical to an approved snapshot, so a commit made with `--no-verify` is stopped at push time (admin escape hatch: `.esteira/push-disabled`). `git push --no-verify` still skips the hook; the CI `security-gate` job is the enforcement point (see §3.2 trust model).
4. **M4 — CVE audit (done):** `gh esteira audit` harvests dependencies from npm (exact versions when the lockfile pins them), Python, Go and Rust manifests into a normalized SBOM (`.esteira/sbom.json` summary in reports); queries OSV.dev in one batch (no API key) with a conservative floor for ranges, fetches bounded advisory details, and reports each finding concisely: CVE/GHSA identifier, package@version, severity (GHSA labels → CVSS numeric → UNKNOWN), one-line summary and a concrete fix ("upgrade X to >= Y") pointing at the manifest. Policy from `.esteira/project.json` (`audit.failOn`, default `high`; `audit.maxDetails`); blockers set exit code 1 and the record persists at `.esteira/audits/latest.json`. Unreachable advisories degrade offline (exit 0 + note). The GitHub-repo side of the audit rides on CI running this command against the checkout.
5. **M5 — GitOps baseline & hardening (done):** `gh esteira gitops` generates `deploy/k8s/base` (Deployment with the release image resolved by GitOps, security context, probes, secrets via `DatabaseURL` placeholder for External Secrets, `service`), overlays for `staging` (auto-sync) and `production` (manual, more replicas, review-gated), Argo CD Applications pointing at the GitOps repo and a release workflow that builds the OCI image tagged by the immutable commit SHA with SBOM + `provenance: mode=max`; `gh esteira pin` SHA-pins every `uses:` in the generated workflows through `gh api` (audit comment `# pinned: <ref>` per line, idempotent reruns, unresolved refs fail the run with exit 1). CI keeps no cluster credentials — promotion is a reviewed GitOps PR, reconciled by Argo CD.
6. **M6 — Promotion & image scan (partial):** `gh esteira promote --tag <sha> [--env staging|production] [--repo <o/r>] [--dry-run]` clones the GitOps repo, rewrites `newTag` in `apps/<app>/overlays/<env>/kustomization.yaml` (idempotent; same tag = no PR), pushes a branch and opens a review PR with `gh pr create`. The generated release workflow now runs a Trivy image scan (HIGH/CRITICAL with a fix fail the release) and then opens the staging promotion PR on `main` or the production one on `v*` tags (protected `production` environment). Needs a `GITOPS_TOKEN` secret and a published `gh-esteira` extension (`ESTEIRA_EXT` placeholder). **Not done:** post-deploy smoke tests (need a live deployment to hit) and CLI publication.
7. **M7 — Typed core & Cloudflare security-audit model (done):** the CLI is type-checked with `tsc --noEmit` in `strict` mode over JSDoc (`cli/tsconfig.json`, shared contracts in `cli/src/types.d.ts`, `npm run typecheck`; devDependencies pinned: `typescript@6.0.3`, `@types/node@24.19.2`). The gate gained a `workflows` check for the CI attack classes of the [Cloudflare security-audit skill](https://github.com/cloudflare/security-audit-skill) (`SUPPLY-CHAIN-AND-RELEASE.md`): `pull_request_target`/`workflow_run` checking out the PR head, contributor-controlled `${{ github.event… }}` inside `run:` scripts, `permissions: write-all`, and mutable `uses:` refs (blocking in workflows that hold write scopes or secrets — run `gh esteira pin` before committing the generated release workflow). `gh esteira report` exports the latest gate run and CVE audit as the skill's `findings.json` contract — every Esteira rule is mapped to a skill attack class (`cli/src/report/catalog.mjs`); committed credentials are `confirmed` with likelihood/impact severity, every other static match is `needs_validation` with its blocker and a bounded validation plan (no severity), matched secret values are never written — and the document is validated by the skill's own validator (vendored, MIT, `cli/vendor/cloudflare-security-audit/`) before it is written.

## 11. Before production

- [ ] Pin all third-party Actions to verified full-length commit SHAs.
- [ ] Add SAST, dependency scanning, secret scanning and container scanning per organization policy.
- [ ] Add SBOM and image signing / provenance attestation.
- [ ] Replace example manifests; configure NetworkPolicy, Pod Security, ingress TLS, resource requests/limits and probes.
- [ ] Configure External Secrets / Secrets Store CSI / cloud secret manager; no plaintext credentials in Git.
- [ ] Configure backups, restore tests, alerting and post-deploy smoke tests (M6 does not cover smoke tests yet).
- [ ] Validate with `actionlint`, `kubeconform`, and a staging environment.
- [ ] Review the gate matrix policy thresholds and the CVE severity cutoffs for report/block behavior.
