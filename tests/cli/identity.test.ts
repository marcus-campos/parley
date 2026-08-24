import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { joinFrame, personIdentity, personSession, resolveIdentity, type Identity } from "../../src/cli/identity";

/**
 * `joinFrame` exists because `born` was produced by `bearFront`, consumed by
 * `shouldRetire`, and carried by none of the four hand-written join frames in
 * between. A single producer is what makes "every join carries it" a property
 * of the code. These are about the one field that must survive every caller.
 */
let saved: NodeJS.ProcessEnv | null = null;
afterEach(() => {
  if (saved) { process.env = saved; saved = null; }
});

function newbornIdentity(): Identity {
  saved = { ...process.env };
  process.env.PARLEY_BORN = "parley";
  process.env.PARLEY_NAME = "POOL-1";
  // Outside any repository on purpose: the branch lookup is not what is under
  // test here, and it must not depend on where the suite happens to run.
  return resolveIdentity(tmpdir(), tmpdir());
}

describe("the one place a join frame is built", () => {
  test("what only the caller knows still wins — the NAME_TAKEN retry renames the frame", () => {
    const frame = joinFrame(newbornIdentity(), { name: "POOL-1-2", cwd: "/somewhere", kind: "agent" });
    expect(frame.name).toBe("POOL-1-2");
    expect(frame.cwd).toBe("/somewhere");
    expect(frame.kind).toBe("agent");
  });

  test("but `born` is not the caller's to forget, or to rewrite", () => {
    const identity = newbornIdentity();
    // The retry only ever needs `name`. Nothing in src/ passes `born` in
    // `extra` today — and the point of a single producer is that nothing ever
    // can, by accident or otherwise.
    expect(joinFrame(identity, { born: "person" }).born).toBe("parley");
    expect(joinFrame(identity, {}).born).toBe("parley");
  });
});

describe("a person is not a front", () => {
  // The bug this pins: a person's name came from the branch, and their session
  // key fell back to one recalled from the working directory — so opening a
  // shell where an agent was working reattached them to that agent. `--human`
  // was read and discarded, because reattaching does not change what somebody
  // already is, and `brain enable --human` then refused the only person allowed
  // to run it.
  test("their name is not the branch's, and not the machine account's either", () => {
    const person = personIdentity();
    const front = resolveIdentity("/tmp/repo-on-develop", "/tmp/repo-on-develop");
    expect(person.name).not.toBe(front.name);
    expect(person.born).toBe("person");
    expect(person.provisional).toBe(false);
  });

  test("--as still wins, for somebody who wants another name", () => {
    expect(personIdentity("Chefe").name).toBe("CHEFE");
  });

  test("their session key is scoped to the person, not to a directory", () => {
    // Two different repositories, one person: the same participant. The front
    // path cannot promise this — it recalls a session from the directory, which
    // is the whole reason a person landed inside an agent.
    expect(personSession()).toBe(personSession());
    expect(personSession().startsWith("person:")).toBe(true);
  });
});
