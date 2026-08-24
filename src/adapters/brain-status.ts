import { ParleyClient } from "../client/client";
import { locateRepo } from "../repo/locate";
import { resolveIdentity, wakeAddress } from "../cli/identity";
import { sessionFor } from "../cli/session";

/**
 * Reading and setting the brain from outside the CLI's own command table.
 *
 * `init` offers to turn semantic recall on, which means it needs to know
 * whether it is already on and then to say so to the daemon. Both are one
 * frame each, and neither is worth pulling the whole command dispatcher into
 * `install.ts` for.
 *
 * Every path here degrades to "no" rather than throwing. A daemon that cannot
 * be reached during `init` is not a failure of `init` — the files are already
 * written and the offer simply does not happen.
 */

/**
 * `join` first, because every op that touches state needs an actor, and
 * `leave` after, because this caller is a person answering one question during
 * setup — not a session that stays on the bus afterwards.
 *
 * The join is `kind: "human"`: the only caller is the prompt at the end of
 * `init`, which has already established there is a person at a terminal and no
 * harness in the environment.
 */
async function withClient<T>(fallback: T, run: (client: ParleyClient) => Promise<T>): Promise<T> {
  let client: ParleyClient | null = null;
  try {
    const repo = locateRepo(process.cwd());
    client = await ParleyClient.connect({
      gitCommonDir: repo.discoveryDir,
      busKey: repo.gitCommonDir,
    });
    const identity = resolveIdentity(repo.cwd, repo.cwd);
    const joined = await client.request({
      op: "join",
      name: identity.name,
      mission: "setting up",
      harness: identity.harness,
      cwd: repo.cwd,
      kind: "human",
      branch: identity.branch,
      wake: wakeAddress(),
      session: sessionFor(repo.discoveryDir, repo.cwd),
    });
    if (joined.ok !== true) return fallback;
    try {
      return await run(client);
    } finally {
      try { await client.request({ op: "leave" }); } catch { /* going away anyway */ }
    }
  } catch {
    return fallback;
  } finally {
    try { client?.close(); } catch { /* already gone */ }
  }
}

/** Is semantic recall already on here? `false` whenever that cannot be established. */
export async function brainIsOn(): Promise<boolean> {
  return withClient(false, async (client) => {
    const r = await client.request({ op: "brain" });
    return r.ok === true && (r as unknown as { active?: boolean }).active === true;
  });
}

/**
 * Record the person's decision on the bus.
 *
 * `false` means the daemon did not accept it — the caller then tells them the
 * command to run by hand, rather than claiming an activation that did not
 * happen. The model is already on disk at that point, so retrying costs
 * nothing but the words.
 */
export async function enableBrain(name: string): Promise<boolean> {
  return withClient(false, async (client) => {
    const r = await client.request({ op: "brain", enable: name });
    return r.ok === true;
  });
}
