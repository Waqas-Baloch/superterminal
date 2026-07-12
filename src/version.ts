import pkg from "../package.json";

/** Single source of truth — inlined from package.json at build time. */
export const VERSION: string = pkg.version;
