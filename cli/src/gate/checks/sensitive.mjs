import { execFileSync } from "node:child_process";
import path from "node:path";

/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */

// Files whose presence in git is itself the exposure: environment files,
// private keys, keystores, cloud/CLI credentials, Terraform state.
const SENSITIVE_FILE = [
  { re: /^\.env(?:\.(?!(?:example|sample|template|dist|defaults|schema)$)[\w.-]+)?$/i, what: "arquivo de ambiente (.env)" },
  { re: /^[\w.-]+\.env$/i, what: "arquivo de ambiente (*.env)" },
  // .pem is often a public certificate; PEM private keys are caught by content (secret-private-key).
  { re: /\.(?:key|p12|pfx|jks|keystore|ppk)$/i, what: "chave privada ou keystore" },
  { re: /^id_(?:rsa|dsa|ecdsa|ed25519)$/, what: "chave SSH privada" },
  { re: /^(?:credentials(?:\.json)?|service-account[\w.-]*\.json|client_secret[\w.-]*\.json)$/i, what: "arquivo de credenciais" },
  { re: /^\.(?:netrc|pgpass|htpasswd)$/, what: "arquivo de senhas" },
  { re: /^(?:kubeconfig|[\w.-]+\.kubeconfig)$/i, what: "kubeconfig (credencial de cluster)" },
  { re: /^terraform\.tfstate(?:\.backup)?$/, what: "estado do Terraform (costuma conter segredos)" },
];
const IN_AWS = /(?:^|\/)\.aws\/credentials$/;

const isEnvFile = (/** @type {string} */ name) =>
  /^\.env(?:\.[\w.-]+)?$/i.test(name) || /^[\w.-]+\.env$/i.test(name);
const isEnvExample = (/** @type {string} */ name) => /\.(?:example|sample|template|dist|defaults|schema)$/i.test(name);

// KEY=value lines (no quotes needed) whose name says "secret".
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/;
const SECRET_NAME = /(?:SECRET|PASSW(?:OR)?D|PASSWD|PWD|TOKEN|PRIVATE|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIAL|DATABASE_URL|DSN|CONNECTION_STRING|WEBHOOK)/i;
// Values that are meant to be public (browser bundles, publishable keys).
const PUBLIC_NAME = /(?:^(?:VITE|NEXT_PUBLIC|PUBLIC|REACT_APP|NUXT_PUBLIC|EXPO_PUBLIC)_)|PUBLISHABLE/i;
const PLACEHOLDER_VALUE = /^(?:|x{3,}|changeme|change-me|placeholder|todo|null|none|false|true|your[\w-]*|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\*+)$/i;

/** Ignore patterns that protect secrets, and a path each one is meant to cover. */
const PROTECTED = [
  { re: /\.env/, probe: ".env" },
  { re: /\.env/, probe: ".env.local" },
  { re: /\.pem|\*\.key|\.key\b/, probe: "server.key" },
  { re: /\.pem/, probe: "cert.pem" },
  { re: /id_rsa|id_ed25519/, probe: "id_rsa" },
  { re: /credentials/, probe: "credentials.json" },
  { re: /tfstate/, probe: "terraform.tfstate" },
  { re: /\.npmrc/, probe: ".npmrc" },
];

/**
 * Is `probe` (relative to the .gitignore's folder) still ignored by the rules
 * now on disk? `--no-index` judges the rules alone, tracked or not.
 * @param {string} root @param {string} dir @param {string} probe
 */
function stillIgnored(root, dir, probe) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", "--", path.posix.join(dir, probe)], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** @type {Check} */
export function checkSensitive(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of ctx.files) {
    const name = file.path.split("/").pop() ?? file.path;
    const present = file.blob !== null; // added or modified, not deleted

    if (present) {
      const hit = SENSITIVE_FILE.find((r) => r.re.test(name)) ?? (IN_AWS.test(file.path) ? { what: "credenciais da AWS" } : null);
      if (hit) {
        findings.push({
          check: "sensitive", severity: "high", rule: "sensitive-file", file: file.path, line: null,
          message: `${hit.what[0].toUpperCase()}${hit.what.slice(1)} não deve ir para o git. Tire do commit (git rm --cached ${file.path}), adicione ao .gitignore e, se já foi enviado, rotacione os segredos.`,
        });
      }
    }

    if (present && isEnvFile(name) && !isEnvExample(name)) {
      file.added.forEach((line, i) => {
        const m = line.match(ASSIGNMENT);
        if (!m || !SECRET_NAME.test(m[1]) || PUBLIC_NAME.test(m[1])) return;
        const value = m[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\s+#.*$/, "");
        if (PLACEHOLDER_VALUE.test(value)) return;
        findings.push({
          check: "sensitive", severity: "high", rule: "secret-env-assignment", file: file.path, line: file.addedLines[i] ?? i + 1,
          message: `${m[1]} tem um valor de segredo (o valor não é mostrado). Use um secret manager ou deixe só o nome no .env.example.`,
        });
      });
    }

    if (name === ".gitignore" && file.removed.length) {
      const dir = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
      const exposed = new Set();
      for (const removed of file.removed) {
        for (const p of PROTECTED) {
          if (p.re.test(removed) && !stillIgnored(ctx.root, dir, p.probe)) exposed.add(p.probe);
        }
      }
      if (exposed.size) {
        findings.push({
          check: "sensitive", severity: "high", rule: "gitignore-unprotects-secrets", file: file.path, line: null,
          message: `A mudança no .gitignore deixa de ignorar ${[...exposed].join(", ")}. Restaure a regra (ex.: .env, .env.*, !.env.example) antes de commitar.`,
        });
      }
    }
  }
  return findings;
}
