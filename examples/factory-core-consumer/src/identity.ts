// #region identity
import {
  createCompletionProtocol,
  createGrantProtocol,
  createReceiptProtocol,
  createReviewProtocol,
  createSpecificationProtocol,
} from "@comforge/core";

// Your project's identity. These values are yours to choose, and they are trusted
// configuration: keep them in committed code, never read them from an issue, a
// comment, an agent's output or a grant. Each scheme is part of a digest or a signed
// payload, so changing one later makes earlier records unverifiable.
export const REPOSITORY = "acme/widgets";
export const TICKET_PATTERN = /^ACME-[0-9]+$/;
export const branchForTicket = (ticket: string) => `agent/${ticket.toLowerCase()}`;

export const specifications = createSpecificationProtocol({
  digestScheme: "acme-engineering-spec/v1",
  markerNamespace: "acme-factory",
  publisherName: "Acme Factory",
  publishToolName: "publish_specification",
});

export const grants = createGrantProtocol({
  grantScheme: "acme-engineering-grant/v1",
  repository: REPOSITORY,
  ticketPattern: TICKET_PATTERN,
  branchForTicket,
});

export const receipts = createReceiptProtocol({
  receiptScheme: "acme-engineering-receipt/v1",
  repository: REPOSITORY,
});

export const reviews = createReviewProtocol({
  reviewScheme: "acme-engineering-review/v1",
  repository: REPOSITORY,
  markerNamespace: "acme-factory",
  publisherName: "Acme Factory",
  publishToolName: "post_review",
  ticketPattern: TICKET_PATTERN,
  limits: {
    summaryMaxChars: 2000,
    findingsMax: 20,
    findingTitleMaxChars: 120,
    findingTextMaxChars: 2000,
    notesMax: 10,
    noteMaxChars: 500,
  },
});

export const completions = createCompletionProtocol({
  completionScheme: "acme-engineering-completion/v1",
  repository: REPOSITORY,
  markerNamespace: "acme-records",
  ticketPattern: TICKET_PATTERN,
  reservedMarkerPrefixes: ["acme-factory:", "acme-records:"],
  runner: { id: "acme-runner", label: "Acme Runner" },
  publishCommand: "make complete",
  links: {
    comment: (issue, id) => `https://forge.example.invalid/acme/widgets/issues/${issue}#c${id}`,
    blob: (commit, path) => `https://forge.example.invalid/acme/widgets/blob/${commit}/${path}`,
  },
  // Your secret detector. The kernel only sees its verdict, never the secret.
  redact: (value) =>
    /ACME_TOKEN=[A-Za-z0-9]{12,}/.test(value)
      ? { count: 1, kinds: ["acme-token"] }
      : { count: 0, kinds: [] },
});
// #endregion identity
