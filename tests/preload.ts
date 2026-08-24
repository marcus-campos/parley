/**
 * Runs before every test file. One job: no test may reach the machine's real
 * parley state.
 *
 * The registry at `~/Library/Application Support/parley/repos.json` lists every
 * repository where parley was set up, and `refreshAllAdapters` walks it and
 * rewrites the hooks and skill of each one. A test that touches it is therefore
 * not testing in a sandbox — it is editing the person's own projects. That is
 * not hypothetical: eight unrelated repositories carried an unmerged branch's
 * skill text for two days, telling agents to run commands the installed binary
 * did not have, because one test file called `refreshAllAdapters` for real.
 *
 * Setting this here rather than in each file is deliberate. Per-file setup only
 * protects the files that remember, and the failure is silent in exactly the
 * files that forget — a second test writing to the real registry is what
 * survived the first fix. `PARLEY_STATE_DIR` is read by `registryPath`
 * (`src/adapters/registry.ts`) and by nothing in production.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PARLEY_STATE_DIR ??= mkdtempSync(join(tmpdir(), "parley-test-state-"));
