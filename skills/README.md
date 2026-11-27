# Skills

Portable agent skills (`SKILL.md` with `name` and `description` frontmatter). Agents select one through `context/routing.json` (`bun tooling/route.ts "<task>"`) instead of loading all of them.

## Consumer skills — using Comforge in a repository

| Skill | Use when |
|---|---|
| [`comforge-install`](comforge-install/SKILL.md) | Install Comforge in a repository and verify the environment before first use. |
| [`comforge-configure`](comforge-configure/SKILL.md) | Create or change comforge.config.json safely: detection, review, commit to the base branch. |
| [`comforge-lifecycle`](comforge-lifecycle/SKILL.md) | Run one initiative end to end with the CLI: start, verify, deliver, cleanup. |
| [`comforge-mcp-setup`](comforge-mcp-setup/SKILL.md) | Connect an agent client to the Comforge MCP server with the least-privileged tool profile. |
| [`comforge-authorization`](comforge-authorization/SKILL.md) | Explain and apply the authorization modes and owner-signed grants. |
| [`comforge-evidence-and-reviews`](comforge-evidence-and-reviews/SKILL.md) | Read initiative evidence and publish or read advisory reviews bound to an exact head. |
| [`comforge-recovery`](comforge-recovery/SKILL.md) | Recover from interrupted writes, lost checkouts and partial deliveries without repeating a write. |
| [`comforge-multi-agent`](comforge-multi-agent/SKILL.md) | Coordinate several agents or phases on one repository without collisions. |
| [`comforge-embedded-host`](comforge-embedded-host/SKILL.md) | Embed Comforge services in your own server: host services, protocol services, runtime authority. |

## Contributor skills — developing Comforge

| Skill | Use when |
|---|---|
| [`contributor-architecture`](contributor-architecture/SKILL.md) | Orient in the Comforge repository: packages, boundaries and where a change belongs. |
| [`contributor-package-development`](contributor-package-development/SKILL.md) | Develop a change inside one package with tests, docs and a release intent. |
| [`contributor-api-compatibility`](contributor-api-compatibility/SKILL.md) | Keep public APIs, exit codes, error codes and protocols compatible across versions. |
| [`contributor-security-changes`](contributor-security-changes/SKILL.md) | Change authorization, trust boundaries, credentials handling or disclosure rules safely. |
| [`contributor-testing`](contributor-testing/SKILL.md) | Choose and run the right tests; add tests that are credential-free and model-free. |
| [`contributor-documentation`](contributor-documentation/SKILL.md) | Keep docs, package READMEs, llms.txt and skills accurate and consistent. |
| [`contributor-release`](contributor-release/SKILL.md) | Plan, prepare and publish a package release under owner authorization. |
| [`contributor-dependency-migration`](contributor-dependency-migration/SKILL.md) | Move a consumer (or this repository's harness) to a new Comforge release. |

