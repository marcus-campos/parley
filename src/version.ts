import pkg from "../package.json" with { type: "json" };

/** Inlined at compile time by the bundler, so the binary needs no package.json. */
export const VERSION: string = pkg.version;
