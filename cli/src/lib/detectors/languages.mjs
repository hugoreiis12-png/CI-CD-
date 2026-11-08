import { exists, readFile, readJson, listDir, isDir } from "../lib/fs-tools.mjs";

const esc = (s) => s.replace(/[.*+?ˆ${}()|[\]\\]/g, "\\$&");
const mentions = (text, word) => 
 text ? new RegExp(`(^|[^\\w-])${esc(word)}([^\\w-]|$)`, "i").test(text) : false;

//Frameworks e libs para detecção de linguagens, runtimes e package managers.
const NODE_FRAMEWORKS = {
  next: "next", react: "react", "react-dom": "react", vue: "vue", nuxt: "nuxt",
  svelte: "svelte", "@sveltejs/kit": "sveltekit", "@angular/core": "angular",
  "solid-js": "solid", astro: "astro", "@remix-run/node": "remix",
  express: "express", fastify: "fastify", "@nestjs/core": "nestjs", hono: "hono",
  "@trpc/server": "trpc", "@prisma/client": "prisma", "drizzle-orm": "drizzle",
  typeorm: "typeorm", vitest: "vitest", jest: "jest",
  "@playwright/test": "playwright", cypress: "cypress", electron: "electron",
  expo: "expo", tailwindcss: "tailwindcss",
};

export function detectNode(root) {
  if (!exists(root, "package.json")) return null;
  const pkg = readJson(root, "package.json") ?? {};
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const scripts = pkg.scripts ?? {};
  const evidence = ["package.json"];

  let pm = (pkg.packageManager ?? "").split("@")[0] || null;
  if (!pm) {
    if (exists(root, "pnpm-lock.yaml") || exists(root, "pnpm-workspace.yaml")) pm = "pnpm";
    else if (exists(root, "yarn.lock")) pm = "yarn";
    else if (exists(root, "bun.lockb")) pm = "bun";
    else pm = "npm";
  }
  evidence.push(`package-manager:${pm}`);

  const frameworks = [];
  for (const [dep, name] of Object.entries(NODE_FRAMEWORKS)) {
    if (deps[dep] && !frameworks.includes(name)) frameworks.push(name);
  }

  const scriptCmd = (name) => {
    if (!scripts[name]) return null;
    return pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
  };

  let workspaces = null;
  if (exists(root, "pnpm-workspace.yaml")) workspaces = "pnpm";
  else if (Array.isArray(pkg.workspaces)) workspaces = "npm";
  else if (exists(root, "turbo.json")) workspaces = "turbo";
  else if (exists(root, "nx.json")) workspaces = "nx";
  else if (exists(root, "lerna.json")) workspaces = "lerna";

  const nodeVersion = String(pkg.engines?.node ?? "20").replace(/[^\d.]/g, "") || "20";

  const typecheck =
    scriptCmd("typecheck") ??
    scriptCmd("type-check") ??
    (deps.typescript ? "npx tsc --noEmit" : null);

  return {
    type: "language", id: "node", confidence: 0.95,
    runtime: { node: nodeVersion },
    packageManager: pm, frameworks, workspaces, evidence,
    commands: {
      test: scriptCmd("test"),
      lint: scriptCmd("lint"),
      typecheck,
      build: scriptCmd("build"),
    },
  };
}

const PY_FRAMEWORKS = [
  "fastapi", "django", "flask", "celery", "sqlalchemy", "pydantic",
  "pytest", "ruff", "mypy", "black", "uvicorn", "aiohttp", "tornado", "litestar",
];

export function detectPython(root) {
  const evidence = [];
  for (const f of ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]) {
    if (exists(root, f)) evidence.push(f);
  }
  if (evidence.length === 0) return null;

  const blob = ["pyproject.toml", "requirements.txt", "setup.py"]
    .map((f) => readFile(root, f))
    .filter(Boolean)
    .join("\n");

  let pm = "pip";
  if (exists(root, "uv.lock")) pm = "uv";
  else if (exists(root, "poetry.lock") || mentions(blob, "poetry")) pm = "poetry";
  else if (exists(root, "Pipfile")) pm = "pipenv";

  const prefix = pm === "poetry" ? "poetry run "
    : pm === "uv" ? "uv run "
    : pm === "pipenv" ? "pipenv run " : "";

  const frameworks = PY_FRAMEWORKS.filter((f) => mentions(blob, f));
  const hasTests = mentions(blob, "pytest") || isDir(root, "tests") || isDir(root, "test");

  const requiresPython = (readFile(root, "pyproject.toml") ?? "").match(/requires-python\s*=\s*"([^"]+)"/)?.[1];

  return {
    type: "language", id: "python", confidence: 0.9,
    runtime: { python: requiresPython ?? "3.x" },
    packageManager: pm, frameworks, evidence,
    commands: {
      test: hasTests ? `${prefix}python -m pytest` : null,
      lint: mentions(blob, "ruff") ? `${prefix}ruff check .`
        : mentions(blob, "flake8") ? `${prefix}flake8 .` : null,
      typecheck: mentions(blob, "mypy") ? `${prefix}mypy .`
        : mentions(blob, "pyright") ? `${prefix}pyright` : null,
      build: pm === "poetry" ? "poetry build" : null,
    },
  };
}

const GO_FRAMEWORKS = {
  gin: "gin-gonic", echo: "labstack/echo", fiber: "gofiber",
  chi: "go-chi/chi", grpc: "google.golang.org/grpc", kratos: "go-kratos",
};

export function detectGo(root) {
  if (!exists(root, "go.mod")) return null;
  const mod = readFile(root, "go.mod") ?? "";
  const frameworks = Object.entries(GO_FRAMEWORKS)
    .filter(([, sub]) => mod.includes(sub))
    .map(([name]) => name);
  const goVersion = mod.match(/^go\s+(\d+\.\d+)/m)?.[1];

  return {
    type: "language", id: "go", confidence: 0.95,
    runtime: { go: goVersion ?? "1.22" },
    packageManager: "go", frameworks, evidence: ["go.mod"],
    commands: {
      test: "go test ./...",
      lint: "go vet ./...",
      typecheck: null,
      build: "go build ./...",
    },
  };
}

const RUST_FRAMEWORKS = ["axum", "actix-web", "rocket", "warp", "poem", "tokio", "sqlx", "diesel"];

export function detectRust(root) {
  if (!exists(root, "Cargo.toml")) return null;
  const cargo = readFile(root, "Cargo.toml") ?? "";
  const frameworks = RUST_FRAMEWORKS.filter((f) => mentions(cargo, f));

  return {
    type: "language", id: "rust", confidence: 0.95,
    runtime: { rust: "stable" },
    packageManager: "cargo", frameworks, evidence: ["Cargo.toml"],
    commands: {
      test: "cargo test",
      lint: "cargo clippy -- -D warnings",
      typecheck: null,
      build: "cargo build --release",
    },
  };
}

export function detectJvm(root, fp) {
  const gradle = exists(root, "build.gradle") || exists(root, "build.gradle.kts");
  const maven = exists(root, "pom.xml");
  if (!gradle && !maven) return null;

  const blob = [readFile(root, "pom.xml"), readFile(root, "build.gradle"), readFile(root, "build.gradle.kts")]
    .filter(Boolean).join("\n");
  const frameworks = ["spring-boot", "quarkus", "micronaut", "dropwizard"]
    .filter((f) => blob.toLowerCase().includes(f));
  if ((fp.counts?.[".kt"] ?? 0) > 0) frameworks.push("kotlin");

  const useWrapper = exists(root, "gradlew");
  return {
    type: "language", id: "jvm", confidence: 0.9,
    runtime: { java: "21" },
    packageManager: gradle ? "gradle" : "maven", frameworks,
    evidence: [maven ? "pom.xml" : "build.gradle"],
    commands: {
      test: gradle ? (useWrapper ? "./gradlew test" : "gradle test") : "mvn -q test",
      lint: null,
      typecheck: null,
      build: gradle ? (useWrapper ? "./gradlew build" : "gradle build") : "mvn -q package",
    },
  };
}

export function detectDotnet(root, fp) {
  const files = listDir(root).filter((e) => e.isFile()).map((e) => e.name);
  const csproj = files.find((f) => f.endsWith(".csproj"));
  const sln = files.find((f) => f.endsWith(".sln"));
  if (!csproj && !sln && (fp.counts?.[".csproj"] ?? 0) === 0) return null;

  const cs = csproj ? readFile(root, csproj) ?? "" : "";
  const frameworks = ["aspnetcore", "blazor", "entityframework", "xunit", "nunit"]
    .filter((f) => cs.toLowerCase().includes(f));

  return {
    type: "language", id: "dotnet", confidence: 0.9,
    runtime: { dotnet: "8.0.x" },
    packageManager: "nuget", frameworks, evidence: [csproj ?? sln ?? "*.csproj"],
    commands: { test: "dotnet test", lint: null, typecheck: null, build: "dotnet build" },
  };
}

export function detectRuby(root) {
  if (!exists(root, "Gemfile")) return null;
  const blob = readFile(root, "Gemfile") ?? "";
  const frameworks = ["rails", "sinatra", "hanami", "rspec", "minitest"]
    .filter((f) => mentions(blob, f));

  return {
    type: "language", id: "ruby", confidence: 0.9,
    runtime: { ruby: "3.3" },
    packageManager: "bundler", frameworks, evidence: ["Gemfile"],
    commands: {
      test: mentions(blob, "rspec") ? "bundle exec rspec" : "bundle exec rake test",
      lint: mentions(blob, "rubocop") ? "bundle exec rubocop" : null,
      typecheck: null,
      build: null,
    },
  };
}

export function detectPhp(root) {
  if (!exists(root, "composer.json")) return null;
  const composer = readJson(root, "composer.json") ?? {};
  const deps = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
  const frameworks = [
    ["laravel/framework", "laravel"],
    ["symfony/framework-bundle", "symfony"],
    ["phpunit/phpunit", "phpunit"],
    ["pestphp/pest", "pest"],
  ].filter(([dep]) => deps[dep]).map(([, name]) => name);

  return {
    type: "language", id: "php", confidence: 0.9,
    runtime: { php: "8.3" },
    packageManager: "composer", frameworks, evidence: ["composer.json"],
    commands: {
      test: composer.scripts?.test ? "composer test" : "vendor/bin/phpunit",
      lint: deps["laravel/pint"] ? "vendor/bin/pint --test" : null,
      typecheck: deps["phpstan/phpstan"] ? "vendor/bin/phpstan analyse" : null,
      build: null,
    },
  };
}
