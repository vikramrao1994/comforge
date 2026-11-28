# Overview

**Comforge** is deterministic, agent-agnostic engineering infrastructure. It turns an agent's
engineering work into a governed, inspectable sequence ([tested walk-through](../recipes/01-first-governed-initiative.md)):

1. A person publishes a **specification** (an issue whose body carries a digest marker).
2. An agent **starts** an initiative from it: the CLI verifies the specification and creates an
   isolated checkout on its own branch.
3. The agent works and **verifies**: the repository's own validation commands run on the clean,
   committed head, and the result is recorded against that exact commit.
4. The agent **delivers**: the validated head is pushed, one pull request is created or updated,
   and one completion record is published and read back.
5. Reviewers publish **advisory reviews** bound to the reviewed head. People review and merge.
6. After the merge, **cleanup** removes the checkout. Every write is in a ledger, so an
   interrupted write is **recovered** instead of repeated.

Deterministic code decides every permission and every write; prompts and instructions never do.
(Published, `@comforge/cli` ≥ 0.2.0.)

## What it is not

- Not a sandbox: validation runs the candidate's code as the operator (see
  [known limitations](../troubleshooting/known-limitations.md)).
- Not an approval system: it never merges, approves or deploys. Advisory reviews are comments,
  never native GitHub approvals.
- Not an agent: it works with any agent client through the CLI or MCP.
- Not a token-compression product: compact and summary output options exist, and their
  component-level effects are measured ([benchmarks](../benchmarks/README.md)), but no
  end-to-end saving is claimed.

## When to use it, and when not

| Use Comforge when | Look elsewhere when |
|---|---|
| agents open pull requests in a GitHub repository and you need each change tied to a published specification, an exact validated commit and an auditable record | you need isolation from untrusted code (use containers or VMs; Comforge runs your validation as you) |
| several agents, sessions or people hand work over and must not duplicate writes | you want an agent framework that plans and writes code (Comforge governs the lifecycle around it) |
| you want owner-signed authorization of agent writes, or an explicit operator mode | your forge is not GitHub (github.com or GitHub Enterprise) |
| you need one lifecycle from the CLI, MCP and your own server alike | you are on Windows (refused; use WSL) |

## Who it is for

- Teams that want agents to open pull requests under the same evidence and validation rules
  every time.
- Agent-client authors who need a governed tool surface (MCP) instead of raw `git` and `gh`.
- Hosts that embed the lifecycle in their own service (host services, protocol services).

## Interfaces

Consumers install two packages: [`@comforge/cli`](../../packages/cli/README.md) and
[`@comforge/mcp`](../../packages/mcp/README.md). The three library packages they are built on are
implementation details for most users; see [architecture](../concepts/architecture.md).

A reference consumer runs Comforge in production as an ordinary npm dependency of these two
packages; it is not needed to understand, install or contribute to Comforge.
