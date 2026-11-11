// `gh esteira agent`: read-only Hermes chat. The contract under test: the model
// can only reach the registry of read-only tools, and nothing it does writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { READ_ONLY_TOOLS, safeRelPath } from "../src/agent/tools.mjs";
import { parseToolCall, invokeTool, runTurn } from "../src/agent/turn.mjs";
import { runAgent } from "../src/agent/repl.mjs";

process.env.ESTEIRA_LLM_ENABLED = "false";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-agent-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "projeto de teste\n");
  fs.writeFileSync(path.join(dir, ".env"), "SEGREDO=abc\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-qm", "base", "--no-verify");
  return dir;
}

function collector() {
  let text = "";
  const out = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { out, text: () => text };
}

test("the agent's tools are exactly the read-only registry (no write tool exists)", () => {
  assert.deepEqual(Object.keys(READ_ONLY_TOOLS).sort(), [
    "attest_check", "audit_latest", "ci_log", "ci_status", "gate_latest", "git_branches", "git_diff",
    "git_log", "git_show", "git_status", "list_files", "read_file", "remote_api_get", "remote_branches",
    "remote_issue_view", "remote_issues", "remote_pr_diff", "remote_pr_view", "remote_prs", "remote_repo",
    "run_tests", "search_code",
  ]);
  assert.equal(Object.keys(READ_ONLY_TOOLS).some((name) => /write|push|merge|comment|create|edit|close|commit|rebase|reset/.test(name)), false);
});

test("remote_api_get only reads inside this repository: no methods, no other repos, no escapes", async () => {
  const root = project();
  const refused = await READ_ONLY_TOOLS.remote_api_get.run({ root }, { path: "repos/outro/dono/issues" });
  assert.match(refused, /não consegui identificar|caminho recusado/);
  const sneaky = await READ_ONLY_TOOLS.remote_api_get.run({ root }, { path: "repos/x/y/pulls -X POST" });
  assert.match(sneaky, /não consegui identificar|caminho recusado/);
  const escape = await READ_ONLY_TOOLS.remote_api_get.run({ root }, { path: "repos/x/y/../../user" });
  assert.match(escape, /não consegui identificar|caminho recusado/);
});

test("git_show refuses refs that git would read as options or ranges", async () => {
  const root = project();
  assert.match(await invokeTool(READ_ONLY_TOOLS, { root }, { name: "git_show", args: { ref: "--output=/tmp/x" } }), /ref inválida/);
  assert.match(await invokeTool(READ_ONLY_TOOLS, { root }, { name: "git_show", args: { ref: "main..HEAD" } }), /ref inválida/);
  assert.match(await invokeTool(READ_ONLY_TOOLS, { root }, { name: "git_show", args: {} }), /README|base/);
});

test("search_code finds text in tracked files and never returns lines from credential files", async () => {
  const root = project();
  git(root, "add", "-f", ".env");
  git(root, "commit", "-qm", "oops", "--no-verify");
  assert.equal(await READ_ONLY_TOOLS.search_code.run({ root }, { pattern: "SEGREDO" }), "nenhuma ocorrência");
  assert.match(await READ_ONLY_TOOLS.search_code.run({ root }, { pattern: "projeto de teste" }), /README\.md:1:projeto de teste/);
});

test("attest_check reports a commit that never passed the gate as blocked", async () => {
  const root = project();
  assert.match(await READ_ONLY_TOOLS.attest_check.run({ root }, {}), /Push BLOQUEADO/);
});

test("the agent's context knows the local branch, the recent commits and the remote state", async () => {
  const root = project();
  const { projectSnapshot } = await import("../src/agent/context.mjs");
  const snapshot = projectSnapshot(root);
  assert.match(snapshot, /Branch e sincronização: ## main/);
  assert.match(snapshot, /Últimos commits:\n[0-9a-f]+ base/);
  assert.match(snapshot, /Repositório remoto: /);
  assert.match(snapshot, /Último gate:\nnenhum registro do gate ainda/);
});

test("a natural-language question about the remote is answered from a read-only tool", async () => {
  const root = project();
  const seen = [];
  const replies = [
    { status: "ok", text: 'Vou ver os PRs.\nTOOL: {"name":"remote_prs","args":{"state":"open"}}', error: null },
    { status: "ok", text: "Não há PRs abertos.", error: null },
  ];
  const turn = await runTurn({
    system: "sys", history: [], question: "tem PR aberto?", tools: READ_ONLY_TOOLS, ctx: { root },
    chatFn: async (messages) => { seen.push(messages); return replies.shift(); },
  });
  assert.equal(turn.reply, "Não há PRs abertos.");
  assert.equal(turn.steps[0].name, "remote_prs");
  assert.match(seen[1][seen[1].length - 1].content, /RESULTADO remote_prs:/);
});

test("safeRelPath keeps reads inside the project, away from .git and credentials", () => {
  const root = path.resolve("/tmp/proj");
  assert.equal(safeRelPath(root, "src/a.js"), "src/a.js");
  assert.equal(safeRelPath(root, ".env.example"), ".env.example");
  assert.throws(() => safeRelPath(root, "../secreto.txt"), /fora do projeto/);
  assert.throws(() => safeRelPath(root, ".git/config"), /\.git/);
  assert.throws(() => safeRelPath(root, ".env"), /credenciais/);
  assert.throws(() => safeRelPath(root, "deploy/id_rsa"), /credenciais/);
  assert.throws(() => safeRelPath(root, "  "), /caminho/);
});

test("parseToolCall reads the first TOOL line; a broken one is an unnamed call", () => {
  assert.deepEqual(
    parseToolCall('vou ver\nTOOL: {"name":"git_status","args":{}}\n'),
    { name: "git_status", args: {} },
  );
  assert.deepEqual(parseToolCall('remote_pr_diff {"number": 9}'), { name: "remote_pr_diff", args: { number: 9 } });
  assert.equal(parseToolCall("resposta final sem ferramenta"), null);
  assert.deepEqual(parseToolCall("TOOL: {nao-json"), { name: "", args: {} });
});

test("invokeTool refuses names outside the registry, write-like ones included", async () => {
  const refused = await invokeTool(READ_ONLY_TOOLS, { root: "/x" }, { name: "write_file", args: {} });
  assert.match(refused, /não permitida: "write_file"/);
  assert.match(refused, /read_file/);
});

test("runTurn feeds a tool result back and answers in plain text", async () => {
  const root = project();
  const seen = [];
  const replies = [
    { status: "ok", text: 'TOOL: {"name":"read_file","args":{"path":"README.md"}}', error: null },
    { status: "ok", text: "O README diz que é um projeto de teste.", error: null },
  ];
  const turn = await runTurn({
    system: "sys", history: [], question: "o que é?", tools: READ_ONLY_TOOLS, ctx: { root },
    chatFn: async (messages) => { seen.push(messages); return replies.shift(); },
  });
  assert.equal(turn.reply, "O README diz que é um projeto de teste.");
  assert.equal(turn.steps.length, 1);
  const last = seen[1][seen[1].length - 1];
  assert.match(last.content, /RESULTADO read_file:\nprojeto de teste/);
});

test("runTurn stops at the step limit and reports an unavailable model", async () => {
  const root = project();
  const looping = await runTurn({
    system: "s", history: [], question: "q", tools: READ_ONLY_TOOLS, ctx: { root }, maxSteps: 2,
    chatFn: async () => ({ status: "ok", text: 'TOOL: {"name":"git_status","args":{}}', error: null }),
  });
  assert.match(looping.reply, /Limite de consultas/);
  const down = await runTurn({
    system: "s", history: [], question: "q", tools: READ_ONLY_TOOLS, ctx: { root },
    chatFn: async () => ({ status: "error", text: "", error: "HTTP 500" }),
  });
  assert.equal(down.failed, true);
  assert.match(down.reply, /indisponível: HTTP 500/);
});

test("gh esteira agent: a chat session reads, refuses writes, and leaves the repo untouched", async () => {
  const root = project();
  const before = git(root, "status", "--porcelain");
  const input = Readable.from(["o que tem no projeto?\n", "tente escrever um arquivo\n", "/sair\n"]);
  const sink = collector();
  const replies = [
    { status: "ok", text: 'TOOL: {"name":"write_file","args":{"path":"x.txt","content":"y"}}', error: null },
    { status: "ok", text: "Não consigo escrever: o modo é somente leitura.", error: null },
    { status: "ok", text: "Projeto com README.md.", error: null },
  ];
  const code = await runAgent({ root, input, output: sink.out, chatFn: async () => replies.shift() });

  assert.equal(code, 0);
  assert.match(sink.text(), /modo consulta \(somente leitura\)/);
  assert.match(sink.text(), /Projeto com README\.md\./);
  assert.match(sink.text(), /Não consigo escrever/);
  assert.equal(fs.existsSync(path.join(root, "x.txt")), false);
  assert.equal(git(root, "status", "--porcelain"), before, "the session changed nothing in the working tree");
});

test("gh esteira agent shows each consultation before the answer, so the user can audit it", async () => {
  const root = project();
  const sink = collector();
  const replies = [
    { status: "ok", text: 'TOOL: {"name":"git_branches","args":{}}', error: null },
    { status: "ok", text: "Estou em main.", error: null },
  ];
  await runAgent({ root, input: Readable.from(["em que branch estou?\n", "/sair\n"]), output: sink.out, chatFn: async () => replies.shift() });
  assert.match(sink.text(), /↳ consultou git_branches \{\}\n\nEstou em main\./);
});

test("gh esteira agent without a model says so and exits 1", async () => {
  const root = project();
  const sink = collector();
  const code = await runAgent({ root, input: Readable.from([]), output: sink.out, chatFn: undefined });
  assert.equal(code, 1);
  assert.match(sink.text(), /desligado/);
});
