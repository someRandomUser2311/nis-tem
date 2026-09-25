// Bundle the CLI (cli/localpost.ts + the shared engine in src/) into one Node ESM file.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

const outfile = "dist-cli/localpost.mjs";
await build({
  entryPoints: ["cli/localpost.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  // Some dependencies are CommonJS and use require(); give the ESM bundle one.
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  logLevel: "info",
});
await chmod(outfile, 0o755);
