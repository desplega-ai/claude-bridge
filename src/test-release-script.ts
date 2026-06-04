#!/usr/bin/env bun
import { compareVersions, isExplicitVersion } from "../scripts/release.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

ok("patch version is not explicit semver", !isExplicitVersion("patch"));
ok("plain semver is explicit", isExplicitVersion("1.2.3"));
ok("prerelease semver is explicit", isExplicitVersion("1.2.3-beta.1"));
ok("higher patch compares greater", compareVersions("0.1.1", "0.1.0") > 0);
ok("same version compares equal", compareVersions("0.1.0", "0.1.0") === 0);
ok("lower minor compares lower", compareVersions("0.1.0", "0.2.0") < 0);
ok("stable beats prerelease with same numbers", compareVersions("1.0.0", "1.0.0-beta.1") > 0);
ok("prerelease loses to stable with same numbers", compareVersions("1.0.0-beta.1", "1.0.0") < 0);

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
