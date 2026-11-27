# Runtimes and platforms

| | Supported | Tested in CI |
|---|---|---|
| Node.js | ≥ 22.18 | 22, 24, 26 on Ubuntu and macOS |
| Bun | ≥ 1.4 | 1.4.1 on Ubuntu and macOS |
| OS | macOS, Linux | Ubuntu, macOS |
| Windows | **refused** with `unsupported-platform` | refusal is tested (`packages/cli/test`) |

The packages ship compiled JavaScript with declarations; consumers need no TypeScript loader.
The packed-package consumer tests (`tests/*/consumerInstall.test.ts`) install each package from
its built tarball and run its example under both Node.js and Bun.
