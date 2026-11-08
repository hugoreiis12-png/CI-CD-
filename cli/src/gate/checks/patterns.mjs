const JS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"];
const SHELL = ["sh", "bash", "zsh"];
const DOCKER = ["Dockerfile"];
const YAML = ["yaml", "yml"];

const hasExt = (path, exts) => {
  const name = path.split("/").pop().toLowerCase();
  if (exts.includes("Dockerfile") && (name === "dockerfile" || name.startsWith("dockerfile."))) return true;
  const ext = name.includes(".") ? name.split(".").pop() : "__no_ext__";
  return exts.includes(ext);
};

const RULES = [
  {
    id: "dangerous-eval", severity: "medium", exts: JS,
    re: /\beval\s*\(|\bnew\s+Function\s*\(/,
    message: "Dynamic code execution (eval / new Function)",
  },
  {
    id: "dangerous-child-process", severity: "high", exts: JS,
    re: /child_process[.\w]*\.(?:exec|execSync)|(?:^|[^.\w])exec(?:Sync)?\s*\(/,
    message: "Shell execution via string command (child_process.exec / exec()); prefer execFile/spawn with an argv array",
  },
  {
    id: "dangerous-curl-pipe", severity: "high", exts: [...SHELL, ...DOCKER],
    re: /\b(?:curl|wget)\b[^\n|;]*(?:\|\s*(?:ba|z)?sh|sh\s*<)/,
    message: "Remote script piped straight into a shell",
  },
  {
    id: "dangerous-rm-rf", severity: "high", exts: [...SHELL, ...DOCKER, ...YAML],
    re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\w*\s+(?:[/~])/,
    message: "Forced recursive delete on / or ~",
  },
  {
    id: "dangerous-chmod-777", severity: "medium", exts: [...SHELL, ...DOCKER, ...YAML],
    re: /\bchmod\s+(?:-[a-zA-Z]+\s+)?777\b/,
    message: "World-writable permissions (chmod 777)",
  },
  {
    id: "dangerous-insecure-tls", severity: "medium", exts: [...JS, ...SHELL, ...YAML, ...DOCKER],
    re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false|GIT_SSL_NO_VERIFY\s*[:=]\s*true|\bcurl\b[^\n]*\s-k(?:\s|$)/,
    message: "TLS verification disabled",
  },
  {
    id: "dangerous-sql-concat", severity: "medium", exts: JS,
    re: /(?:execute|query)\s*\(\s*["'`][^"'`]*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+/,
    message: "SQL built by string concatenation (injection risk); use parameters",
  },
];

export function checkDangerousPatterns(ctx) {
  const findings = [];
  for (const file of ctx.files) {
    for (let i = 0; i < file.added.length; i++) {
      const line = file.added[i];
      for (const rule of RULES) {
        if (!hasExt(file.path, rule.exts)) continue;
        if (!rule.re.test(line)) continue;
        if (/(?:test|spec|fixture)/i.test(file.path)) continue;
        findings.push({
          check: "patterns", severity: rule.severity, rule: rule.id,
          file: file.path, line: i + 1, message: rule.message,
        });
      }
    }
  }
  return findings;
}
