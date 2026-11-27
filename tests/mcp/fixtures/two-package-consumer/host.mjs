// A plain JavaScript host that depends on @comforge/cli and @comforge/mcp only. It runs under
// Node and Bun and prints one JSON line: { runtime, checks, failed }.
import { generateKeyPairSync } from "node:crypto";
import { AuthorityError, createRuntimeAuthority, ed25519Signer, keyIdFor, RUNTIME_AUTHORITY_SCHEMA } from "@comforge/cli/authority";
import { createProtocolServices, PROTOCOL_PROFILE_SCHEMA } from "@comforge/cli/protocols";
import { createEngineeringHost, HOST_SERVICES_SCHEMA, HostServiceError, minimizeFinished } from "@comforge/mcp/host";
import { createComforgeMcpServer } from "@comforge/mcp";

const checks = [];
const failed = [];
async function check(name, run) {
  checks.push(name);
  try {
    if ((await run()) !== true) failed.push(name);
  } catch (error) {
    failed.push(`${name}: ${error?.message ?? error}`);
  }
}
async function refuses(run, test) {
  try {
    await run();
    return false;
  } catch (error) {
    return test(error);
  }
}

// The lower-level packages are not this consumer's dependencies: it cannot import them.
for (const name of ["@comforge/core", "@comforge/github", "@comforge/ledger"])
  await check(`${name} is not resolvable from the consumer`, () =>
    refuses(
      () => import(name),
      (e) => /Cannot find (package|module)|ERR_MODULE_NOT_FOUND|ResolveMessage/.test(`${e?.code} ${e?.message} ${e?.name}`),
    ),
  );

const ticketPattern = /^[A-Z]+-\d+$/;
const services = createProtocolServices({
  schema: PROTOCOL_PROFILE_SCHEMA,
  repository: "acme/widgets",
  ticketPattern,
  specification: { digestScheme: "acme-spec/v1", markerNamespace: "acme", publisherName: "Acme", publishToolName: "publish" },
  completion: {
    scheme: "acme-completion/v1",
    markerNamespace: "acme-done",
    runner: { id: "local", label: "local" },
    publishCommand: "publish",
    links: { comment: (i, c) => `https://example.invalid/${i}#${c}`, blob: (c, p) => `https://example.invalid/${c}/${p}` },
  },
});
await check("protocols: a profile yields the configured protocols", () =>
  services.specification.digestScheme === "acme-spec/v1" && services.completion.scheme === "acme-completion/v1" && services.review === null);
await check("protocols: an unknown profile version is refused", () =>
  refuses(() => createProtocolServices({ schema: "comforge-protocol-profile/v0", repository: "acme/widgets", ticketPattern }), (e) => e instanceof TypeError));
await check("protocols: the credential floor cannot be configured away", () =>
  services.completion.textProblems([`token ghp_${"a".repeat(36)}`]).some((p) => /secret-like/.test(p)));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const options = {
  schema: RUNTIME_AUTHORITY_SCHEMA,
  repository: "acme/widgets",
  ticketPattern,
  branchForTicket: (t) => `agent/${t.toLowerCase()}`,
  grantScheme: "acme-grant/v1",
  receiptScheme: "acme-receipt/v1",
  separateFrom: ["acme-lifecycle/v1"],
};
const authority = createRuntimeAuthority(options);
const now = new Date();
const fields = {
  schema: "acme-grant/v1",
  grantId: "11111111-1111-4111-8111-111111111111",
  nonce: "ab".repeat(16),
  repository: "acme/widgets",
  ticket: "WID-1",
  issue: 7,
  specDigest: "c".repeat(64),
  mode: "implementation",
  capabilities: [],
  base: { kind: "origin-main" },
  maxAttempts: 1,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
};
const trusted = [{ keyId: keyIdFor(pem.pub), publicKeyPem: pem.pub, owner: "owner" }];
const envelope = authority.grants.issue(fields, ed25519Signer(pem.priv));
await check("authority: a grant verifies with the public key only", () => authority.grants.verify(envelope, trusted, now).grant.issue === 7);
await check("authority: another authority's grant is refused", () =>
  refuses(
    () => createRuntimeAuthority({ ...options, grantScheme: "acme-other/v1" }).grants.verify(envelope, trusted, now),
    (e) => e instanceof AuthorityError && e.code === "unauthorized",
  ));
await check("authority: a scheme of another authority cannot be reused", () =>
  refuses(() => createRuntimeAuthority({ ...options, grantScheme: "acme-lifecycle/v1" }), (e) => e instanceof TypeError));
await check("authority: a tampered grant is refused", () =>
  refuses(() => authority.grants.verify({ ...envelope, grant: { ...envelope.grant, ticket: "WID-2" } }, trusted, now), (e) => e instanceof AuthorityError));

const seen = [];
const host = createEngineeringHost({
  repository: { owner: "acme", name: "widgets" },
  transport: {
    async get(path) {
      seen.push(path);
      throw new HostServiceError("not-found", "no such thing", { status: 404 });
    },
  },
});
await check("host: the schema and the read-only profile", () => host.schema === HOST_SERVICES_SCHEMA && host.profile === "read-only");
await check("host: reads stay inside the repository and keep their refusal", async () =>
  (await refuses(() => host.evidence.getIssue(1), (e) => e instanceof HostServiceError && e.code === "not-found")) &&
  seen.length > 0 && seen.every((p) => p.startsWith("/repos/acme/widgets/")));
await check("host: a read-only host refuses every write before a request exists", async () => {
  const before = seen.length;
  const refused = await refuses(
    () => host.writes.execute({ kind: "issue.comment", operationId: "op-1", issueNumber: 1, body: "x" }),
    (e) => e instanceof HostServiceError && e.code === "capability-denied",
  );
  return refused && seen.length === before;
});
await check("host: a record that is not finished is stored as it is", () => {
  const record = { state: "reserved", descriptor: { payload: { body: "text" } } };
  return minimizeFinished(record) === record;
});
await check("mcp: the server entry point is the same package", () => typeof createComforgeMcpServer === "function");

console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", checks, failed }));
process.exit(failed.length === 0 ? 0 : 1);
