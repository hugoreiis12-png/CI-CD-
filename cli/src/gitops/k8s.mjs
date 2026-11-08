/** Base manifests (deploy/k8s/base): image is set by GitOps, never by CI. */
const labels = (app) =>
  `    app.kubernetes.io/name: ${app}\n    app.kubernetes.io/managed-by: esteira\n    app.kubernetes.io/part-of: ${app}`;

export function renderDeployment({ app, image, port = 8080 }) {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${app}
  labels:
${labels(app)}
spec:
  replicas: 2 # overlay patches set the real replica count per environment
  selector:
    matchLabels:
      app.kubernetes.io/name: ${app}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${app}
    spec:
      containers:
        - name: ${app}
          # TODO(ops): point at your registry/namespace (repo vars REGISTRY + IMAGE_NAMESPACE)
          image: ${image} # SET BY GITOPS: immutable commit-SHA tag, never :latest
          ports:
            - containerPort: ${port}
          env:
            # TODO(ops): wire External Secrets / Secrets Store CSI — no plaintext here
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${app}-db
                  key: url
          resources:
            requests: { cpu: "100m", memory: "256Mi" }
            limits: { cpu: "1", memory: "512Mi" }
          readinessProbe:
            httpGet: { path: /healthz, port: ${port} }
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: ${port} }
            initialDelaySeconds: 10
            periodSeconds: 10
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
`;
}

export function renderService({ app, port = 8080 }) {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${app}
spec:
  selector:
    app.kubernetes.io/name: ${app}
  ports:
    - port: 80
      targetPort: ${port}
`;
}

export function renderKustomization({ app }) {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
commonLabels:
  app.kubernetes.io/name: ${app}
`;
}

/**
 * Overlay for an environment. Returns both files the overlay directory needs.
 * The image tag stays SET-BY-GITOPS: promotion is a reviewed GitOps PR.
 */
export function renderOverlay({ app, env }) {
  const production = env === "production";
  const replicas = production ? 3 : 1;
  const note = production
    ? "# Production: sync is manual — promotion rides a reviewed GitOps PR (protected environment, required reviewers)."
    : "# Staging: auto-sync from the GitOps repo (prune + self-heal).";

  const kustomization = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
${note}
resources:
  - ../../base
patches:
  - path: patch.yaml
    target:
      kind: Deployment
      name: ${app}
images:
  # Promotions rewrite this tag to the reviewed commit-SHA (immutable)
  - name: ${app}
    newTag: SET-BY-GITOPS
`;

  const patch = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${app}
spec:
  replicas: ${replicas}
`;

  return { "kustomization.yaml": kustomization, "patch.yaml": patch };
}
