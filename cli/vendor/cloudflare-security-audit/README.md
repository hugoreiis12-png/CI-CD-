# Vendored: Cloudflare security-audit skill — findings contract

Source: https://github.com/cloudflare/security-audit-skill (commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`), MIT License (see `LICENSE`).

- `report-schema.json` — the `findings.json` contract (`confirmed` / `needs_validation` / `rejected`).
- `validate-findings.cjs` — the skill's validator (uses only `fs`, `path`, `util`; no network, no writes).

Used by `gh esteira report` to refuse exporting a document that does not satisfy the contract. Files are unmodified; update by copying a newer commit and running `npm test`.
