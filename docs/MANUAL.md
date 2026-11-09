# Manual do usuário: Esteira (`gh esteira`)

A Esteira é uma extensão do GitHub CLI que coloca um pipeline de CI/CD com foco em segurança em qualquer projeto, com um comando. Este manual cobre o uso do dia a dia: instalar, ligar num projeto, commitar e abrir PRs com o gate ativo, configurar a política e entender o que fazer quando algo for bloqueado.

> Os blocos de comando deste manual não têm comentários (`#`): no zsh interativo, `#` não é comentário a menos que você rode `setopt interactivecomments`. Copie e cole um bloco por vez.

> Versão documentada: **v0.1.3**. Repositório: `https://github.com/hugoreiis12-png/gh-esteira`.

---

## 1. Como funciona, em uma página

```text
 você ─ git commit ─▶ pre-commit ─▶ gh esteira gate
                       │   checagens estáticas (segredos, padrões perigosos, workflows de CI, arquivos grandes)
                       │   playground: roda seus testes numa cópia isolada (staged × HEAD)
                       └─ aprovado → grava uma attestation (SHA do conteúdo validado)

 você ─ git push ───▶ pre-push ──▶ gh esteira attest --verify
                       └─ só sobe se o HEAD for idêntico a um snapshot aprovado

 PR no GitHub ─────▶ esteira-ci.yml
                       ├─ validate       (seus lint/typecheck/test/build)
                       └─ security-gate  (o mesmo gate, no servidor, com a política do commit base)
                          ⇒ check obrigatório na branch protection = nada entra sem passar
```

**Os hooks locais são feedback rápido. Quem garante é o `security-gate` no CI.** Hooks podem ser pulados com `git commit --no-verify` ou `git push --no-verify`. O job do servidor não pode, desde que esteja marcado como check obrigatório.

---

## 2. Requisitos

| Ferramenta | Versão |
|---|---|
| GitHub CLI (`gh`), autenticado (`gh auth login`) | 2.x |
| `git` | 2.30+ |
| Node.js | 20+ |

---

## 3. Instalação

```bash
gh extension install hugoreiis12-png/gh-esteira --pin v0.1.3
gh esteira --version
```

O segundo comando deve imprimir `0.1.3`.

`--pin` fixa a versão (tag) instalada. Sem ele, o `gh` instala o que estiver na branch `main`.

**Atualizar.** Uma extensão instalada com `--pin` não é atualizada pelo `gh extension upgrade` (o `gh` responde `pinned extensions can not be upgraded`). Reinstale apontando para a versão nova:

```bash
gh extension remove esteira
gh extension install hugoreiis12-png/gh-esteira --pin vX.Y.Z
```

Se você instalou sem `--pin`, `gh extension upgrade esteira` traz a `main` mais recente.

**Desinstalar:** `gh extension remove esteira`. Depois, em cada projeto: `git config --unset core.hooksPath`.

> Se a pasta do projeto tiver `:` no nome (ex.: `CI:CD`), o `npx` deixa de funcionar ali, porque `:` é o separador do `PATH`. Nos scripts do projeto, chame os binários com `node node_modules/<pacote>/bin/<bin>`.

---

## 4. Primeiros passos num projeto

### 4.1 Ligar a Esteira

```bash
cd meu-projeto
gh esteira analyze
gh esteira init --dry-run
gh esteira init
```

O `analyze` só lê e mostra a stack, os comandos e as lacunas detectados. O `init --dry-run` mostra o que seria criado, sem gravar nada. O `init` aplica.

> Rode a Esteira **dentro do repositório git de cada projeto**. Se a pasta tiver outros repositórios git dentro dela, o git os registra como gitlinks (repositórios embutidos). O gate não lê o conteúdo deles e avisa com `submodule-not-scanned`.

O `init` cria:

| Arquivo | Para quê | Commitar? |
|---|---|---|
| `.esteira/project.json` | Perfil do projeto e política do gate/audit | **Sim** |
| `.github/workflows/esteira-ci.yml` | Jobs `validate` e `security-gate` | **Sim** |
| `.esteira/hooks/pre-commit`, `pre-push` + `git config core.hooksPath` | Hooks locais | **Não** (já entram no `.gitignore`) |
| `.gitignore` | Adiciona `.esteira/runs/`, `.esteira/tmp/` e `.esteira/hooks/` | Sim |

Se o projeto já tinha hooks (husky, `.git/hooks`), eles continuam rodando: a Esteira roda primeiro e depois chama o hook anterior.

### 4.2 Conferir os comandos de teste

O playground do gate roda o seu comando de **teste** numa cópia isolada. Confira em `.esteira/project.json`:

```json
"profile": { "commands": { "test": "npm test", "typecheck": null, "lint": null, "build": null } }
```

- Se o `analyze` não detectou a stack (por exemplo, o código está numa subpasta), preencha à mão: `"test": "npm --prefix cli test"`.
- O playground é extraído com `git archive`, então **não tem `node_modules`** nem nada que esteja no `.gitignore`. Use ali comandos que rodem sem dependências instaladas. Deixe typecheck e build que precisam de dependências para o job `validate` do CI.
- Rodar `gh esteira init` de novo **regera o `profile`**: anote edições manuais. A política em `gate` e `audit` é sempre preservada.

### 4.3 Fixar as actions por SHA

```bash
gh esteira pin --dry-run
gh esteira pin
```

O `--dry-run` mostra o que seria fixado. Sem ele, o `pin` reescreve `uses: X@v4` para `X@<sha40> # pinned: v4` e o `ESTEIRA_REF` para a SHA do commit.

Rode o `pin` sempre que gerar ou editar os workflows da Esteira. O gate **bloqueia** actions com tag mutável em workflows que têm permissões de escrita ou segredos (veja a seção 7).

### 4.4 Primeiro commit e PR

```bash
git switch -c esteira/setup
git add .esteira/project.json .github/workflows/esteira-ci.yml .gitignore
git commit -m "ci: liga a esteira"
git push -u origin esteira/setup
gh pr create --fill
gh pr checks --watch
```

No `commit`, o pre-commit roda o gate e o playground. No `push`, o pre-push verifica a attestation. O `gh pr checks --watch` acompanha o `validate` e o `security-gate`.

### 4.5 Configurar o GitHub (uma vez por repositório)

Torne o gate do servidor obrigatório. Sem isso ele é só informativo:

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["validate", "security-gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true
}
EOF
```

> Com `enforce_admins: false`, um admin ainda consegue dar push direto. Para que a regra valha para todo mundo, use `true`. Em times, adicione `required_pull_request_reviews`.

No **primeiro** PR, o `security-gate` usa a política da `main`, que ainda não tem `.esteira/project.json`. Então ele roda só as checagens estáticas e pula os testes. A partir do merge, os PRs seguintes rodam a suíte também no servidor.

---

## 5. Uso no dia a dia

| Você faz | A Esteira faz | Se bloquear |
|---|---|---|
| `git commit` | `gate`: checagens estáticas + playground (seus testes no staged e no HEAD) | Corrija os findings, faça `git add` e commit de novo |
| `git push` | `attest --verify`: o HEAD tem de ser idêntico a um snapshot aprovado | `gh esteira gate --head` valida e atesta o último commit (ver 9) |
| Abrir/atualizar PR | `validate` + `security-gate` no servidor | Veja o log do job (`gh pr checks`, `gh run view --log-failed`) |
| `gh esteira audit` | CVEs das dependências via OSV.dev | Atualize o pacote para a versão indicada em `correção:` |
| `gh esteira report` | Exporta gate + audit no formato `findings.json` da skill da Cloudflare | — |

Um gate aprovado mostra:

```text
Esteira gate — aprovado
Mudanças    : 2 arquivo(s), +146/-0
Playground  : testes npm --prefix cli test: OK (3487 ms)
Veredito    : commit liberado. Attestation 42001f897883… registrada (libera o push).
```

---

## 6. Referência de comandos

Todos aceitam `--dir <path>` (o padrão é o diretório atual).

| Comando | O que faz | Flags |
|---|---|---|
| `gh esteira analyze` | Detecta linguagens, gerenciadores, frameworks, infra e comandos. Só lê. | `--json` |
| `gh esteira init` | Cria manifesto, workflow de CI e hooks. Idempotente. | `--dry-run`, `--force` (regenera o workflow) |
| `gh esteira gate` | Roda o gate sobre o que está **staged** | `--json`, `--head` (valida e atesta o último commit), `--policy-ref <commit>` (usado no CI: lê a política desse commit) |
| `gh esteira attest --verify` | Confere se o HEAD é um snapshot aprovado | `--json` |
| `gh esteira audit` | Gera um SBOM e consulta o OSV.dev; grava `.esteira/audits/latest.json` | `--json` |
| `gh esteira gitops` | Gera `deploy/k8s` (base + staging/production), Argo CD e `esteira-release.yml` | `--image <ref>`, `--gitops-repo owner/repo`, `--force` |
| `gh esteira pin` | Fixa por SHA todo `uses:` e o `ESTEIRA_REF` nos workflows da Esteira | `--dry-run`, `--json` |
| `gh esteira promote` | Abre um PR no repositório GitOps trocando o `newTag` do overlay | `--tag <sha>` (obrigatório), `--env staging\|production`, `--repo owner/repo`, `--app`, `--dry-run` |
| `gh esteira report` | `findings.json` no contrato da skill da Cloudflare, validado antes de gravar | `--out <path>`, `--json` |

Códigos de saída: `0` significa aprovado ou limpo, `1` significa bloqueado, reprovado ou erro.

---

## 7. O que o gate bloqueia e como corrigir

O padrão é `blockAt: "medium"`: findings `medium` e `high` bloqueiam, `low` só avisa.

| Regra | Sev. | Significado | Como corrigir |
|---|---|---|---|
| `secret-aws`, `secret-github`, `secret-npm`, `secret-google`, `secret-slack` | high | Token reconhecível numa linha adicionada | **Revogue e rotacione** o token, remova-o e leia de uma variável de ambiente ou secret do CI |
| `secret-private-key` | high | Chave privada (vale até em caminhos de teste) | Remova e rotacione a chave |
| `secret-hardcoded-credential` | high | `password/token/secret/api_key = "…"` com 12+ caracteres | Use um secret manager; placeholders como `<your-key>`, `changeme` ou `xxxx` não disparam |
| `dangerous-child-process` | high | `exec()` com comando montado em string | `execFile`/`spawn` com argv |
| `dangerous-curl-pipe` | high | `curl … \| sh` em shell ou Dockerfile | Baixe, verifique o checksum e só então execute |
| `dangerous-rm-rf` | high | `rm -rf /` ou `~` | Limite a um diretório validado |
| `dangerous-eval`, `dangerous-insecure-tls`, `dangerous-sql-concat`, `dangerous-chmod-777` | medium | Padrões de injeção ou desligamento de controles | Veja a mensagem do finding |
| `ci-privileged-pr-checkout` | high | `pull_request_target`/`workflow_run` fazendo checkout do código do PR | Use o evento `pull_request` para código não confiável |
| `ci-expression-injection` | high | `${{ github.event.…title/body/head_ref… }}` dentro de `run:` | Passe por `env:` (`TITLE: ${{ … }}`) e use `"$TITLE"` |
| `ci-write-all` | medium | `permissions: write-all` | Permissões mínimas por job |
| `ci-floating-action-privileged` | medium | `uses: x@v4` num workflow com escrita ou segredos | `gh esteira pin` |
| `ci-floating-action` | low | `uses: x@v4` num workflow sem privilégios | `gh esteira pin` (recomendado) |
| `large-file` | low | Blob maior que `maxFileBytes` (5 MiB) | Use Git LFS ou armazenamento externo |
| `submodule-not-scanned` | low | Repositório git embutido (gitlink): o conteúdo dele não é validado | Rode a Esteira dentro dele, ou remova-o com `git rm --cached <pasta>` |
| `suite-failure`, `regression` | high | Seus testes falham no staged, ou falham mais que no HEAD | Corrija o código ou os testes |
| `pre-existing-failures` | low | Os testes já falhavam no HEAD e não pioraram | Não bloqueia; corrija quando puder |
| `playground-typecheck` | medium | O comando de typecheck falhou no snapshot | Corrija os tipos (ou tire o typecheck do profile se ele precisar de `node_modules`) |
| `playground-timeout` | high | Os testes passaram de `timeoutMs` | Acelere a suíte ou aumente o `timeoutMs` |
| `playground-skipped` | low | Nenhum comando de teste configurado | Preencha `profile.commands.test` (4.2) |
| `gate-read-error` | high | Não foi possível ler o diff staged; nada foi validado | Veja a mensagem; um diff de um único arquivo acima de 64 MiB também cai aqui |
| `gate-policy-invalid` / `gate-policy-error` | high | `mode`/`blockAt` inválidos, ou a política do commit base ilegível | Corrija o `.esteira/project.json` |

**Caminhos de teste** (`test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/`, `testdata/`, `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`) ficam de fora das regras de segredo (menos chave privada) e de padrões perigosos. Uma palavra que só *contém* "test" (como `latest/`) **não** conta como caminho de teste.

---

## 8. Configuração: `.esteira/project.json`

```json
{
  "profile": { "commands": { "test": "npm test", "typecheck": null, "lint": null, "build": null } },
  "gate": {
    "mode": "block",
    "blockAt": "medium",
    "maxFileBytes": 5242880,
    "playground": { "enabled": true, "baseline": true, "timeoutMs": 120000 }
  },
  "audit": { "failOn": "high", "maxDetails": 40 }
}
```

| Chave | Valores | Efeito |
|---|---|---|
| `gate.mode` | `block` \| `audit` | `audit` registra os findings mas não bloqueia (útil para adoção gradual). Qualquer outro valor **bloqueia**. |
| `gate.blockAt` | `low` \| `medium` \| `high` | Severidade mínima que bloqueia. Valor desconhecido **bloqueia**. |
| `gate.maxFileBytes` | bytes | Limite do `large-file` |
| `gate.playground.enabled` | bool | Liga ou desliga a execução dos testes no playground |
| `gate.playground.baseline` | bool | Também roda os testes no HEAD para separar regressão de falha preexistente |
| `gate.playground.timeoutMs` | ms | Tempo máximo por comando |
| `audit.failOn` | `critical` \| `high` \| `medium` \| `low` | A partir de qual severidade o `audit` sai com código 1. Valor desconhecido vira `high`. |
| `audit.maxDetails` | número | Limite de advisories detalhados consultados |

**No CI, a política vem do commit base, nunca do PR** (`--policy-ref "$BASE_SHA"`). Mudar o `project.json` num PR só passa a valer depois do merge. É isso que impede um PR de afrouxar o gate que o julga.

---

## 9. Saídas de emergência (e por que o CI não as aceita)

| Situação | Saída local | Efeito no CI |
|---|---|---|
| A CLI da Esteira não está instalada | `ESTEIRA_ALLOW_UNGATED=1 git commit …` (fica registrado no terminal) | Nenhum: o `security-gate` continua rodando |
| Precisa dar push de um commit não atestado | `touch .esteira/push-disabled` (arquivo ignorado pelo git; remova depois) | Nenhum |
| Pular hooks | `git commit/push --no-verify` | Nenhum: por isso o check é obrigatório |
| Adoção gradual | `"mode": "audit"` | Só vale depois do merge na base |

**"Push BLOQUEADO: o HEAD não é um snapshot atestado"** significa que o último commit não passou pelo gate. Isso acontece com commits feitos com `--no-verify`, com commits que não disparam o pre-commit (merge, cherry-pick, rebase) e quando o conteúdo mudou depois do gate. Para resolver, valide e ateste o último commit:

```bash
gh esteira gate --head
git push
```

O `--head` compara o último commit com o pai dele (ou com a árvore vazia, se for o primeiro commit do repositório) e exige o índice limpo. Se houver mudanças staged, commite-as ou remova-as do índice antes.

---

## 10. Auditoria de CVEs e relatório

```bash
gh esteira audit
gh esteira report
```

O `audit` lê os manifestos de npm (com lockfile), Python, Go e Rust e consulta o OSV.dev. Para cada advisory, mostra `pacote@versão`, severidade, resumo e a correção (`correção: atualize X para >= Y`). O `report` grava `.esteira/reports/findings.json`. Se o OSV.dev estiver fora do ar, o audit roda offline: sai com 0 e uma nota avisando.

O `report` segue o contrato da [skill de security-audit da Cloudflare](https://github.com/cloudflare/security-audit-skill):

- **`confirmed`**: credencial commitada, com severidade (probabilidade e impacto). O valor do segredo **nunca** é escrito no relatório.
- **`needs_validation`**: qualquer outro achado estático e os CVEs. Traz o que falta observar (`blockers`) e um plano de validação local, sem severidade.
- O arquivo é validado pelo validador oficial da skill antes de ser gravado. Se não passar, nada é escrito e a saída é 1.

---

## 11. Deploy com GitOps (projetos com Dockerfile e Kubernetes)

```bash
gh esteira gitops --gitops-repo OWNER/gitops-repo
gh esteira pin
```

O `gitops` gera `deploy/k8s`, `deploy/argocd` e `esteira-release.yml`. O `pin` é **obrigatório** antes de commitar o release.

O `esteira-release.yml` gerado faz isto:

1. **`build-publish`**: gera a imagem `ghcr.io/<app>:<github.sha>` com SBOM e provenance.
2. **`image-scan`**: Trivy; falha se houver HIGH/CRITICAL com correção disponível.
3. **`promote-staging`**: em push na `main`, abre um PR no repositório GitOps trocando o `newTag` do staging. O staging sincroniza sozinho no Argo CD.
4. **`promote-production`**: em tags `v*`, atrás do environment protegido `production`.

Para configurar no GitHub:
- Crie o secret `GITOPS_TOKEN` com permissão de escrita **só** no repositório GitOps.
- Crie o environment `production` com revisores obrigatórios.
- Copie `deploy/k8s/overlays` para `apps/<app>/overlays/` no repositório GitOps.
- O CI não tem nenhuma credencial do cluster: quem aplica é o Argo CD.

Promoção manual: `gh esteira promote --tag <sha> --env staging --repo OWNER/gitops-repo`. Use `--dry-run` para ver o plano. O `--repo` é obrigatório, porque o `gitops` não grava o repositório no manifesto.

---

## 12. Problemas comuns

| Sintoma | Causa | O que fazer |
|---|---|---|
| `CLI do gate não encontrada — pre-commit bloqueado` | A extensão não está instalada nesta máquina | Instale (seção 3); os hooks passam a encontrar `gh esteira` sozinhos |
| `gate-read-error` com `git cat-file` (até a v0.1.2) | Repositório git embutido na pasta (gitlink) | Atualize para a v0.1.3; o gitlink vira o aviso `submodule-not-scanned` |
| `zsh: command not found: #` ou `pathspec '#'` | Comentário colado junto com o comando no zsh | Cole só o comando, ou rode `setopt interactivecomments` |
| Push bloqueado logo no primeiro commit | O commit foi feito sem o pre-commit | `gh esteira gate --head` |
| `extension name must start with gh-` | Nome de repositório errado no `gh extension install` | Use `hugoreiis12-png/gh-esteira` (seção 3) |
| `playground-skipped` | Nenhum comando de teste | Preencha `profile.commands.test` |
| Typecheck falha só no playground | O snapshot não tem `node_modules` | Tire o `typecheck` do profile e deixe-o no job `validate` |
| `security-gate` pula os testes no 1º PR | A `main` ainda não tem o manifesto | Normal: a partir do merge, os testes rodam |
| O PR não pode ser mergeado | Check obrigatório falhou, ou a branch está desatualizada (`strict`) | `gh run view --log-failed`; atualize a branch com a `main` |
| Commit do release bloqueado (`ci-floating-action-privileged`) | Actions não fixadas no `esteira-release.yml` | `gh esteira pin` |
| `npx: command not found` em pasta com `:` | O `:` quebra o `PATH` | `node node_modules/<pkg>/bin/<bin>` |
| `gh extension list` mostra um repositório estranho na extensão | O seu diretório home é um repositório git, e o `gh` lê o remote dele | É só um rótulo; confira com `gh esteira --version` |

---

## 13. Limitações conhecidas (v0.1.3)

- **Regras estáticas são heurísticas:** batem em texto, inclusive dentro de strings e comentários. Se um falso positivo aparecer, reescreva o trecho. Não existe allowlist por linha.
- **Subpastas:** o `analyze` não detecta stacks em subpastas. Configure `profile.commands` à mão.
- **Repositórios embutidos:** pastas que são outros repositórios git (gitlinks) não são validadas pelo gate do repositório externo. Rode a Esteira em cada um deles.
- **Idioma:** as mensagens da CLI estão em PT-BR. IDs de regra, chaves de JSON e os textos vindos do OSV.dev (resumo do advisory) continuam em inglês.
- **Attestations são locais:** `.esteira/runs/*.json` é um registro local, não assinado. A garantia vem do `security-gate` obrigatório no CI.
- **Smoke test e assinatura:** não há smoke test pós-deploy, e as imagens não são assinadas (só SBOM e provenance).
