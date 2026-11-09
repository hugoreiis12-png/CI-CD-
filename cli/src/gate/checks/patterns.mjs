/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */
/** @typedef {import("../../types.js").Severity} Severity */
const JS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"];
const SHELL = ["sh", "bash", "zsh"];
const DOCKER = ["Dockerfile"];
const YAML = ["yaml", "yml"];

/** @param {string} path @param {string[]} exts */
const hasExt = (path, exts) => {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (exts.includes("Dockerfile") && (name === "dockerfile" || name.startsWith("dockerfile."))) return true;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "__no_ext__";
  return exts.includes(ext);
};

import { isTestPath } from "./test-path.mjs";

/** @type {{ id: string, severity: Severity, exts: string[], re: RegExp, message: string }[]} */
const RULES = [
  {
    id: "dangerous-eval", severity: "medium", exts: JS,
    re: /\beval\s*\(|\bnew\s+Function\s*\(/,
    message: "Execução dinâmica de código (eval / new Function)",
  },
  {
    id: "dangerous-child-process", severity: "high", exts: JS,
    re: /child_process[.\w]*\.(?:exec|execSync)|(?:^|[^.\w])exec(?:Sync)?\s*\(/,
    message: "Comando de shell montado em string (exec do child_process); prefira execFile/spawn com array de argumentos",
  },
  {
    id: "dangerous-curl-pipe", severity: "high", exts: [...SHELL, ...DOCKER],
    re: /\b(?:curl|wget)\b[^\n|;]*(?:\|\s*(?:ba|z)?sh|sh\s*<)/,
    message: "Script remoto enviado direto para um shell (curl | sh)",
  },
  {
    id: "dangerous-rm-rf", severity: "high", exts: [...SHELL, ...DOCKER, ...YAML],
    re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\w*\s+(?:[/~])/,
    message: "Remoção recursiva forçada em / ou ~",
  },
  {
    id: "dangerous-chmod-777", severity: "medium", exts: [...SHELL, ...DOCKER, ...YAML],
    re: /\bchmod\s+(?:-[a-zA-Z]+\s+)?777\b/,
    message: "Permissão de escrita para todos (chmod 777)",
  },
  {
    id: "dangerous-insecure-tls", severity: "medium", exts: [...JS, ...SHELL, ...YAML, ...DOCKER],
    re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false|GIT_SSL_NO_VERIFY\s*[:=]\s*true|\bcurl\b[^\n]*\s-k(?:\s|$)/,
    message: "Verificação de TLS desligada",
  },
  {
    id: "dangerous-sql-concat", severity: "medium", exts: JS,
    re: /(?:execute|query)\s*\(\s*["'`][^"'`]*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+/,
    message: "SQL montado por concatenação de strings (risco de injeção); use parâmetros",
  },
];

/** @type {Check} */
export function checkDangerousPatterns(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of ctx.files) {
    for (let i = 0; i < file.added.length; i++) {
      const line = file.added[i];
      for (const rule of RULES) {
        if (!hasExt(file.path, rule.exts)) continue;
        if (!rule.re.test(line)) continue;
        if (isTestPath(file.path)) continue;
        findings.push({
          check: "patterns", severity: rule.severity, rule: rule.id,
          file: file.path, line: file.addedLines?.[i] ?? i + 1, message: rule.message,
        });
      }
    }
  }
  return findings;
}
