// Deterministic v1 build: daemon ESM bundle plus browser bundle and HTML.
import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function options(outRoot = root) {
  return {
    daemon: {
      entryPoints: ["daemon/src/main.ts"],
      absWorkingDir: root,
      platform: "node",
      format: "esm",
      target: "node20",
      bundle: true,
      packages: "external",
      outfile: path.join(outRoot, "daemon/dist/main.js"),
      sourcemap: "linked",
      sourceRoot: "",
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      logLevel: "silent",
    },
    web: {
      entryPoints: ["web/src/main.tsx"],
      absWorkingDir: root,
      platform: "browser",
      format: "iife",
      target: "es2020",
      bundle: true,
      minify: true,
      jsx: "automatic",
      jsxImportSource: "react",
      outfile: path.join(outRoot, "app/app.js"),
      loader: { ".svg": "text" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    },
  };
}

async function normalizeSourcemap(outRoot) {
  const file = path.join(outRoot, "daemon/dist/main.js.map");
  const map = JSON.parse(await readFile(file, "utf8"));
  // Esbuild makes sources relative to the outfile; normalize temporary-output paths
  // so a clean build and the committed build have identical bytes.
  // Sources live under the repo root (daemon/src, lib/); express each one relative to
  // <repo>/daemon/dist regardless of where this build was written.
  const outDir = path.join(outRoot, "daemon/dist");
  map.sources = map.sources.map((source) => {
    // esbuild URL-encodes non-ASCII characters in paths (e.g. "magpie插件") in sources; decode them before computing the relative path,
    // otherwise building from a temp directory under a non-ASCII directory doesn't yield ../src/… and verify:build reports a false main.js.map mismatch
    let decoded = source;
    try {
      decoded = decodeURIComponent(source);
    } catch {}
    const abs = path.resolve(outDir, decoded);
    let rel = path.relative(outRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) rel = path.relative(root, abs);
    return path.posix.relative("daemon/dist", rel.split(path.sep).join("/"));
  });
  await writeFile(file, JSON.stringify(map));
}

export async function buildAll(outRoot = root) {
  const buildOptions = options(outRoot);
  await mkdir(path.join(outRoot, "daemon/dist"), { recursive: true });
  await mkdir(path.join(outRoot, "app"), { recursive: true });
  await copyFile(path.join(root, "web/index.html"), path.join(outRoot, "app/index.html"));
  await Promise.all([esbuild.build(buildOptions.daemon), esbuild.build(buildOptions.web)]);
  if (!existsSync(path.join(outRoot, "app/app.css")))
    await writeFile(path.join(outRoot, "app/app.css"), "/* built by build-v1 */\n");
  await normalizeSourcemap(outRoot);
}

async function main() {
  await buildAll();
  const size = await stat(path.join(root, "app/app.js"));
  if (size.size > 3 * 1024 * 1024)
    console.warn(`[build-v1] warning: app.js ${(size.size / 1024 / 1024).toFixed(2)}MB exceeds 3MB budget`);
  else console.log(`[build-v1] app.js ${(size.size / 1024).toFixed(0)}KB`);
  console.log("[build-v1] complete");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--watch")) {
    const buildOptions = options();
    await copyFile(path.join(root, "web/index.html"), path.join(root, "app/index.html"));
    const daemonContext = await esbuild.context(buildOptions.daemon);
    const webContext = await esbuild.context(buildOptions.web);
    await Promise.all([daemonContext.watch(), webContext.watch()]);
    console.log("[build-v1] watch mode started");
  } else {
    await main();
  }
}
