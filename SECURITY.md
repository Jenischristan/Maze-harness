# Security Policy

## Supported versions

Only the latest release on the default branch receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it
privately through GitHub's "Report a vulnerability" (Security → Advisories) on
the repository. Include:

- the affected version or commit,
- a minimal reproduction (command line, config, workspace shape),
- the impact you observed (what was read, written, executed, or leaked),
- whether you believe the issue is in the harness itself, in a tool, or in the
  policy sandbox.

You can expect an acknowledgement within a few business days and an assessment
within ten. We will coordinate a disclosure date with you and credit you in the
release notes unless you prefer otherwise.

## Scope: what the harness does and does not protect against

The harness runs **untrusted model output** and **untrusted policy code**.
Read `docs/security.md` for the full trust model. In brief:

- Tools run with the privileges of the user who starts the harness. The
  permission policy, path resolution, network allowlist and command deny-list
  are defence in depth, not an OS sandbox.
- Discovery attempts, verification hooks, MCP servers and git run in a scrubbed
  child environment with provider credentials removed, but they can still read
  the filesystem and network the user can reach.
- Replay policies run in a separate child process with a timeout, a heap cap,
  hardened Node flags and a scrubbed environment. This is a **process**
  boundary, not a container.
- The `bash` tool executes arbitrary commands by design. Run the harness in a
  container or VM when the workspace or the model is not trusted.

## Secrets

- Provider keys are read from the environment and never logged.
- Logs, sessions, transcripts, run stores, tool output and hook output are
  redacted before they are written (`src/util/redact.ts`).
- Child processes receive an allowlisted environment (`src/util/env.ts`).

If you find a path where a secret reaches disk or a child process unredacted,
that is in scope.
