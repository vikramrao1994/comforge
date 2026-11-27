// A TypeScript host that depends on @comforge/cli and @comforge/mcp only. Type-checked, not run.
import { createRuntimeAuthority, RUNTIME_AUTHORITY_SCHEMA, type RuntimeGrant, type TrustedKey } from "@comforge/cli/authority";
import { createProtocolServices, PROTOCOL_PROFILE_SCHEMA, type ProtocolProfile, type ReviewProvenance } from "@comforge/cli/protocols";
import { createEngineeringHost, HostServiceError, type HostTransport, type OperationStore, sqliteOperationStore } from "@comforge/mcp/host";

const services = createProtocolServices({
  schema: PROTOCOL_PROFILE_SCHEMA,
  repository: "acme/widgets",
  ticketPattern: /^[A-Z]+-\d+$/,
  specification: { digestScheme: "acme-spec/v1", markerNamespace: "acme", publisherName: "Acme", publishToolName: "publish" },
});
// A configured section is typed non-null: no check is needed before using it.
export const digest: string = services.specification.specificationDigest({ ticketId: "WID-1", title: "t", body: "b" });
export const absent: boolean = services.review === null;
const annotated: ProtocolProfile = { schema: PROTOCOL_PROFILE_SCHEMA, repository: "acme/widgets", ticketPattern: /x/ };
export const maybe = createProtocolServices(annotated).completion?.scheme;
export const provenance: ReviewProvenance = "trusted_author";

const authority = createRuntimeAuthority({
  schema: RUNTIME_AUTHORITY_SCHEMA,
  repository: "acme/widgets",
  ticketPattern: /^[A-Z]+-\d+$/,
  branchForTicket: (t) => `agent/${t.toLowerCase()}`,
  grantScheme: "acme-grant/v1",
  receiptScheme: "acme-receipt/v1",
  separateFrom: [],
});
export function check(raw: unknown, keys: TrustedKey[]): RuntimeGrant["issue"] {
  return authority.grants.verify(raw, keys, new Date()).grant.issue;
}

const transport: HostTransport = { get: async () => ({}) };
export const host = createEngineeringHost({ repository: { owner: "acme", name: "widgets" }, transport });
export const store: OperationStore = sqliteOperationStore({
  database: { prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) },
  repository: "acme/widgets",
});
export const isRefusal = (e: unknown): e is HostServiceError => e instanceof HostServiceError;
