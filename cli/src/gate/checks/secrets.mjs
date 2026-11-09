import { isTestPath } from "./test-path.mjs";

// Placeholder/dead values that should not be treated as leaked credentials.
// Boundaries are explicit so substrings like "EXAMPLE" inside a real key do not
// cause a false exemption (anchored word-ish edges).
const PLACEHOLDER =
  /\b(x{4,}|changeme|placeholder|t[o0]d[o0])\b|your[_-][a-z_]*(?:key|token|secret|passw[o0]rd)|[_-](?:test|dummy|sample)[_-]|(_test_|-dummy)|\breplace[_-]me\b|<[^>]*>/i;

const RULES = [
  {
    id: "secret-aws", severity: "high", re: /AKIA[0-9A-Z]{16}/,
    message: "AWS Access Key ID",
  },
  {
    id: "secret-github", severity: "high", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    message: "GitHub token",
  },
  {
    id: "secret-npm", severity: "high", re: /\bnpm_[A-Za-z0-9]{36}\b/,
    message: "npm publish token",
  },
  {
    id: "secret-google", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: "Google API key",
  },
  {
    id: "secret-slack", severity: "high", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: "Slack token",
  },
  {
    id: "secret-private-key", severity: "high",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    message: "Private key material",
  },
  {
    id: "secret-hardcoded-credential", severity: "high",
    re: /(?:api[_-]?key|secret|token|password)\s*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    message: "Hardcoded credential-looking assignment (use a secret manager / env var)",
  },
];

export function checkSecrets(ctx) {
  const findings = [];
  for (const file of ctx.files) {
    for (let i = 0; i < file.added.length; i++) {
      const line = file.added[i];
      for (const rule of RULES) {
        const match = line.match(rule.re);
        if (!match) continue;
        // S3: judge the matched credential, not the line — a "// todo" comment
        // next to a real key must not exempt it.
        if (PLACEHOLDER.test(match[0])) continue;
        if (isTestPath(file.path) && rule.id !== "secret-private-key") continue;
        findings.push({
          check: "secrets", severity: rule.severity, rule: rule.id,
          file: file.path, line: file.addedLines?.[i] ?? i + 1, message: rule.message,
        });
      }
    }
  }
  return findings;
}
