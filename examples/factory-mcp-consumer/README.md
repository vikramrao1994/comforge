# acme-mcp-consumer

An independent consumer of `@comforge/mcp`. `demo.mjs` creates two throwaway repositories with a
local bare remote, one a Makefile project and one a TypeScript project, each with a committed
`comforge.config.json`, then:

- launches the installed `comforge-mcp` executable over stdio for both repositories and checks
  discovery, capabilities, status, context routing and the repository allowlist;
- mounts `createHttpHandler` behind an MCP client and checks authentication, profile filtering
  and that no executing tool exists without host isolation.

It prints `{runtime, checks, failed}` as JSON and exits non-zero when a check fails. It needs
`git` and either `node` (>= 22.18) or `bun` (>= 1.4); it makes no network request.

```sh
npm install
node demo.mjs    # or: bun demo.mjs
```
