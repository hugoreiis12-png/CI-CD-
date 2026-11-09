/**
 * Maps each Esteira rule to the Cloudflare security-audit skill's vocabulary:
 * the attack class it hunts, the verdict a static match can honestly support,
 * and what an owner must observe before calling it confirmed.
 *
 * Verdict policy (skill, SKILL.md "Separate priority from certainty"):
 *   - `confirmed` only when the match itself is the observed boundary result
 *     (committed credential material is readable by every repository reader);
 *   - everything else is `needs_validation`: a pattern match is a lead, not a
 *     demonstrated exploit, and carries no severity.
 *   - operational results (playground, gate/config errors, large files) are
 *     not vulnerabilities and are not exported.
 */

/**
 * @typedef {object} RuleMeta
 * @property {string} attackClass skill block reference, e.g. "ATTACK-CLASSES.md#Injection"
 * @property {"confirmed" | "needs_validation"} verdict
 * @property {string} rootCause
 * @property {string} intended
 * @property {string} fix
 * @property {string} [blocker] decisive fact a static match cannot establish (needs_validation)
 * @property {string} [plan] bounded local step that resolves the blocker
 */

const SECRET = /** @type {const} */ ({
  attackClass: "ATTACK-CLASSES.md#Cryptography and secrets",
  verdict: "confirmed",
  rootCause: "Material de credencial foi commitado no controle de versão, onde qualquer pessoa com acesso ao repositório, aos forks e aos clones pode copiá-lo.",
  intended: "Credenciais ficam num secret manager ou nos secrets do CI e só chegam ao código em tempo de execução, por variável de ambiente ou arquivo montado.",
  fix: "Revogue e rotacione a credencial agora, remova-a da mudança (e do histórico, se já foi enviada) e passe a lê-la de um secret manager ou secret do CI.",
});

const DANGEROUS = {
  attackClass: "ATTACK-CLASSES.md#Injection",
  verdict: /** @type {const} */ ("needs_validation"),
  intended: "Entrada não confiável nunca chega a execução de código, shell, sistema de arquivos ou consultas sem validação e parametrização.",
  blocker: "Uma coincidência de padrão estático não prova que entrada de menor confiança chega a este ponto.",
  plan: "Rastreie os argumentos da chamada sinalizada até a origem; crie um teste unitário que passe uma entrada maliciosa e verifique que ela é rejeitada ou escapada.",
};

const CI = {
  verdict: /** @type {const} */ ("needs_validation"),
  blocker: "O efeito depende de quais eventos disparam o workflow, de quais secrets existem e das configurações de Actions do repositório — nada disso é visível no código.",
};

/** @type {Record<string, RuleMeta>} */
export const CATALOG = {
  "secret-aws": SECRET,
  "secret-github": SECRET,
  "secret-npm": SECRET,
  "secret-google": SECRET,
  "secret-slack": SECRET,
  "secret-private-key": SECRET,
  "secret-hardcoded-credential": {
    ...SECRET,
    verdict: "needs_validation",
    rootCause: "Um literal com cara de credencial é atribuído no código.",
    blocker: "A heurística não distingue uma credencial ativa de um identificador que não é segredo.",
    plan: "Confira o valor no sistema que o emitiu (lado do dono); se estiver ativo, trate como credencial commitada e rotacione.",
  },
  "dangerous-eval": { ...DANGEROUS, rootCause: "Foi adicionada avaliação dinâmica de código (eval / new Function).", fix: "Troque a avaliação dinâmica por parsing explícito ou uma tabela de despacho." },
  "dangerous-child-process": { ...DANGEROUS, rootCause: "Um comando de shell é montado numa única string e executado por um shell.", fix: "Use execFile/spawn com array de argumentos e sem shell." },
  "dangerous-sql-concat": { ...DANGEROUS, rootCause: "Uma instrução SQL é montada por concatenação de strings.", fix: "Use consultas parametrizadas." },
  "dangerous-curl-pipe": {
    ...DANGEROUS, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "Um script remoto é enviado direto para um shell; quem controla essa URL controla o build.",
    fix: "Baixe para um arquivo, verifique um checksum ou assinatura fixados e só então execute.",
    blocker: "Quem controla a URL remota, e se o conteúdo é verificado em outro lugar, não aparece no código.",
    plan: "Fixe o script por checksum no repositório e faça o step falhar quando divergir.",
  },
  "dangerous-rm-rf": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Resource and file handling", rootCause: "Uma remoção recursiva forçada mira / ou ~.", fix: "Limite a remoção a uma variável de diretório validada e não vazia." },
  "dangerous-chmod-777": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Resource and file handling", rootCause: "Permissão de escrita para todos é aplicada.", fix: "Conceda só a permissão mínima de que o processo dono precisa." },
  "dangerous-insecure-tls": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Cryptography and secrets", rootCause: "A verificação de certificado TLS está desligada.", fix: "Mantenha a verificação; confie explicitamente numa CA privada em vez de desligar a checagem." },
  "ci-privileged-pr-checkout": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Untrusted code in a privileged workflow",
    rootCause: "Um workflow pull_request_target/workflow_run faz checkout do código do PR, então o código do contribuidor roda com os segredos e o token de escrita do repositório base.",
    intended: "Workflows privilegiados nunca executam código de uma referência não confiável.",
    fix: "Use o evento pull_request para código não confiável, ou separe um build sem privilégio de um job privilegiado que só consome artefatos presos a digest.",
    plan: "Num fork descartável, abra um PR cujo script de build imprima se os secrets existem (nunca os valores) e observe a execução privilegiada.",
  },
  "ci-expression-injection": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Workflow command and expression confusion",
    rootCause: "Um valor ${{ github.event… }} controlado pelo contribuidor é expandido dentro de um script run: antes de o shell interpretá-lo.",
    intended: "Campos não confiáveis do evento só chegam aos scripts como variáveis de ambiente entre aspas.",
    fix: "Mova a expressão para env: (FOO: ${{ … }}) e use \"$FOO\" no script.",
    plan: "Rode o workflow localmente (por exemplo, com act) com um evento cujo título seja `a\"; echo INJETADO; #` e veja se INJETADO aparece.",
  },
  "ci-floating-action-privileged": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "Uma action de terceiros é referenciada por tag ou branch mutável num workflow com escopos de escrita ou segredos.",
    intended: "Código que recebe escopos de escrita ou segredos fica preso a um commit imutável e revisado.",
    fix: "Fixe todo uses: numa SHA completa de 40 caracteres (gh esteira pin) e revise as atualizações.",
    plan: "Rode `gh esteira pin --dry-run` e confirme que toda linha sinalizada seria reescrita para uma SHA.",
  },
  "ci-floating-action": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "Uma action de terceiros é referenciada por tag ou branch mutável.",
    intended: "As entradas do build ficam presas a commits imutáveis.",
    fix: "Fixe a action numa SHA completa de commit (gh esteira pin).",
    plan: "Rode `gh esteira pin --dry-run`.",
  },
  "ci-write-all": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Automation identity overreach",
    rootCause: "permissions: write-all dá todos os escopos de escrita a todos os steps do workflow.",
    intended: "Cada job recebe só os escopos de que sua operação precisa.",
    fix: "Defina contents: read no workflow e conceda escopos de escrita por job.",
    plan: "Liste as operações reais de cada job e compare com os escopos concedidos.",
  },
};

/** Rules that describe the gate's own operation, not a vulnerability. */
export const OPERATIONAL = /^(?:playground-|gate-|check-error$|large-file$|submodule-not-scanned$)/;
