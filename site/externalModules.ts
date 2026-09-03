// site/externalModules.ts: the shape of site/external-modules/, read by
// site/build.ts and written by site/fetch-external-modules.ts.
//
// One small module rather than an import between those two, because the
// fetcher is a script with top-level work: importing it to borrow a type
// would clone somebody else's repository as a side effect of building the
// gallery, which is exactly the coupling site/fetch-external-modules.ts's
// own header exists to avoid.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One module built from another repository, at that repository's own pin. */
export interface ExternalModuleRecord {
  /** The registry.json app name, e.g. "aliceisjustplaying/tinydraw". */
  app: string;
  /** The pack that app's own bundle names, which this repository does not carry. */
  pack: string;
  repo: string;
  commit: string;
  command: string;
  /** Where the build wrote the module, inside its own checkout. */
  artifact: string;
  /** The file under site/external-modules/, tracked. */
  module: string;
  sha256: string;
}

/** An app or pack name, flattened into one path segment a URL can carry. */
export function externalModuleSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** The combo id an external module is served under: site/dist/modules/<id>.wasm. */
export function externalComboId(record: { app: string; pack: string }): string {
  return `${externalModuleSlug(record.app)}-${externalModuleSlug(record.pack)}`;
}

export function externalModulesDir(siteDir: string): string {
  return join(siteDir, "external-modules");
}

/** Empty when nothing has been fetched yet: a missing index is a gallery with no external tile, never a failed build. */
export function readExternalModules(siteDir: string): ExternalModuleRecord[] {
  const path = join(externalModulesDir(siteDir), "index.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as ExternalModuleRecord[];
}
