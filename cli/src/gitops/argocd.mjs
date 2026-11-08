const APP_BASE = { project: "default", server: "https://kubernetes.default.svc" };

/**
 * Argo CD Applications. CI never holds cluster credentials: the GitOps repo
 * is the source of truth, CI only proposes the promotion PR.
 */
export function renderApplication({ app, gitopsRepo, env }) {
  const production = env === "production";
  const syncPolicy = production
    ? `  syncPolicy:
    # Manual sync: a human or policy gate promotes (protected environment).
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground`
    : `  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true`;

  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${app}-${env}
  namespace: argocd
  ${production ? `annotations: {} # add required reviewers / notifications here` : `annotations: {}`}
spec:
  project: ${APP_BASE.project}
  source:
    repoURL: ${gitopsRepo}
    targetRevision: HEAD # TODO(ops): pin a branch/commit range per environment
    path: apps/${app}/overlays/${env}
  destination:
    server: ${APP_BASE.server}
    namespace: ${app}-${env}
  ${syncPolicy}
`;
}
