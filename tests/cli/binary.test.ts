import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "dist", "parley");

// The installer's last step runs `parley --help` and reports failure on a
// non-zero exit. These guard that contract against the real compiled binary.
describe.if(existsSync(BIN))("the compiled binary", () => {
  test("--help exits 0 and prints usage", async () => {
    const p = Bun.spawn([BIN, "--help"], { stdout: "pipe" });
    const text = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(text).toContain("coordination bus");
  });

  test("--version exits 0 and names the protocol version", async () => {
    const p = Bun.spawn([BIN, "--version"], { stdout: "pipe" });
    const text = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(text).toMatch(/^parley \d+\.\d+\.\d+ \(protocol v\d+\)/);
  });

  test("both work outside a git repository", async () => {
    const p = Bun.spawn([BIN, "--version"], { cwd: "/", stdout: "pipe" });
    expect(await p.exited).toBe(0);
  });
});
