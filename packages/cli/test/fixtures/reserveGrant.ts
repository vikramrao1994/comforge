// One independent process for grantReservation.test.ts: spends one attempt of a grant on an
// initiative's state, then prints {ok} or {refused}. HOLD=1 waits after spending (to be killed);
// WAIT_FILE delays the start until the file exists, so racers begin together.
import { existsSync } from "node:fs";
import { reserveGrantAttempt } from "../../src/authorization.ts";
import { CliError } from "../../src/errors.ts";
import { openState } from "../../src/state.ts";

const env = (n: string) => process.env[n] ?? "";
while (env("WAIT_FILE") && !existsSync(env("WAIT_FILE")))
  await new Promise((r) => setTimeout(r, 2));
const state = openState(env("COMMON_DIR"));
try {
  const attempt = await reserveGrantAttempt({ state }, env("INITIATIVE"), {
    grantId: env("GRANT_ID"),
    maxAttempts: Number(env("MAX_ATTEMPTS")),
    envelopeDigest: "d".repeat(64),
    head: "a".repeat(40),
    command: "test",
    at: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, attempt })}\n`);
  if (env("HOLD") === "1") await new Promise(() => {});
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(error instanceof CliError ? { ok: false, code: error.code } : { ok: false, code: "unexpected", message: String(error) })}\n`,
  );
}
