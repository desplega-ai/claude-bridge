#!/usr/bin/env bun
import { makePrintErrorResult } from "./print-result.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const withoutRaw = makePrintErrorResult("bad");
ok("error result has base fields", withoutRaw.type === "result" && withoutRaw.subtype === "error" && withoutRaw.is_error === true);
ok("error result omits raw_response by default", !("raw_response" in withoutRaw));

const withRaw = makePrintErrorResult("bad", {
  rawResponse: "Claude said nope",
  sessionId: "session-1",
  debug: [{ type: "desplega_debug", message: "debug" }],
});
ok("error result includes raw_response", withRaw.raw_response === "Claude said nope");
ok("error result includes session id", withRaw.session_id === "session-1");
ok("error result includes debug", Array.isArray(withRaw.debug));

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
