# ADR 0001: Public repository with an external secret boundary

- Status: Accepted
- Date: 2026-08-16
- Owners: project owner
- Related specification: [plan.md — Security and publishing](../plan.md#22-安全与发布要求)

## Context

The project is being published as a public GitHub repository. A dedicated wallet was previously created for the executor, and the user explicitly rejected storing private-key material inside a project that could be uploaded. `.gitignore` does not protect against forced adds, archives, copied worktrees, package publication, logs, or screenshots.

The workspace also contains unrelated analysis and two local `sniper-engineering` work copies. Publishing the workspace indiscriminately would create unnecessary disclosure and maintenance scope.

## Decision drivers

- No private key, seed phrase, authenticated RPC, wallet backup, runtime ledger, or signed raw transaction may enter Git history.
- Public repository scope must be easy to audit before every push.
- Local and cloud runtimes need a consistent credential-loading model.
- Package artifacts and CI logs need the same boundary as Git.

## Options considered

### Store secrets in repository-local ignored files

Simple for local development, but `.gitignore` is not a security boundary and repository-local backups remain easy to publish accidentally.

### Encrypt secrets and commit ciphertext

Improves at-rest handling but adds key-distribution complexity and still exposes secret metadata. It is unnecessary for this executor's initial operational model.

### Keep secrets outside the checkout

Use mode-0700 directories and mode-0600 key files locally, and systemd credentials or a cloud secret manager in production. Store only address/role manifests in Git.

## Decision

Use an external secret boundary. The public repository tracks only project documentation, governance, CI/CD, and `clockin-sniper` source/tests. It excludes local analysis, Skill work copies, runtime data, credentials, wallet material, databases, logs, and build artifacts.

Git ignore rules are defense in depth. CI additionally runs a content/filename secret scan and `npm pack --dry-run`. Production services load secret references from outside the checkout.

## Consequences

### Positive

- A public push does not require moving or copying keys into the repository.
- The Git and npm publication scopes are auditable.
- Local and cloud secret handling follow the same conceptual boundary.

### Negative

- Developers must provision credentials separately from cloning the repository.
- Recovery and deployment documentation must manage external paths and permissions.

### Follow-up evidence

- Secret scan passes locally and in CI.
- `git ls-files` and npm package contents contain no secret/runtime files.
- Cloud service readback proves credentials are mounted outside the deployment directory.
