#!/usr/bin/env node
/**
 * Copy the browser VAD runtime (Silero model, audio worklet, ONNX Runtime WASM)
 * from node_modules into public/vad/<version>/ so it is served from the same
 * origin with immutable caching. Runs automatically before `dev` and `build`,
 * so the assets always match the installed package versions.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = (name) =>
  JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;

export function vadAssetVersion() {
  return `${pkgVersion("@ricky0123/vad-web")}-ort${pkgVersion("onnxruntime-web")}`;
}

const files = [
  ["@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  ["@ricky0123/vad-web/dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  ["@ricky0123/vad-web/dist/silero_vad_legacy.onnx", "silero_vad_legacy.onnx"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
];

function main() {
  const version = vadAssetVersion();
  const base = join(root, "public", "vad");
  const target = join(base, version);

  // Remove assets from previously installed versions.
  if (existsSync(base)) {
    for (const entry of readdirSync(base)) {
      if (entry !== version) rmSync(join(base, entry), { recursive: true, force: true });
    }
  }
  mkdirSync(target, { recursive: true });

  for (const [source, name] of files) {
    const from = join(root, "node_modules", source);
    if (!existsSync(from)) {
      console.error(`[vad-assets] Missing ${source}. Run npm install.`);
      process.exit(1);
    }
    copyFileSync(from, join(target, name));
  }
  console.log(`[vad-assets] Copied ${files.length} files to public/vad/${version}/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
