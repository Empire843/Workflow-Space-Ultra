import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import bytenode from "bytenode";
import JavaScriptObfuscator from "javascript-obfuscator";
import { app } from "electron";

const PROJECT_ROOT = process.cwd();
const ELECTRON_DIR = path.join(PROJECT_ROOT, "electron");

const FILES_TO_COMPILE = [
  "bootstrap.js",
  "license.js",
  "integrity.js"
];

async function hashFile(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  const hashSum = crypto.createHash("sha256");
  hashSum.update(fileBuffer);
  return hashSum.digest("hex");
}

async function run() {
  console.log("🚀 Starting commercial protection build pipeline...");

  try {
    const hashes = {};
    const filesToHash = [
      path.join(ELECTRON_DIR, "main.js"),
      path.join(ELECTRON_DIR, "preload.js")
    ];

    for (const f of filesToHash) {
      hashes[path.basename(f)] = await hashFile(f);
    }
    console.log("📦 Generated integrity hashes for static files");

    const integrityJsPath = path.join(ELECTRON_DIR, "integrity.js");
    let integrityCode = await fs.readFile(integrityJsPath, "utf-8");
    integrityCode = integrityCode.replace(
      /const EXPECTED_HASHES = \{[\s\S]*?\};/, 
      `const EXPECTED_HASHES = ${JSON.stringify(hashes, null, 2)};`
    );
    await fs.writeFile(integrityJsPath, integrityCode);

    for (const filename of FILES_TO_COMPILE) {
      const jsPath = path.join(ELECTRON_DIR, filename);
      const obfuscatedPath = path.join(ELECTRON_DIR, filename.replace(".js", ".obf.js"));
      const jscPath = path.join(ELECTRON_DIR, filename.replace(".js", ".jsc"));

      console.log(`🔒 Obfuscating ${filename}...`);
      const code = await fs.readFile(jsPath, "utf-8");
      const obfuscatedResult = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        stringArrayThreshold: 0.75,
        identifierNamesGenerator: "hexadecimal",
      });

      await fs.writeFile(obfuscatedPath, obfuscatedResult.getObfuscatedCode());

      console.log(`⚙️ Compiling ${filename} to V8 bytecode...`);
      await bytenode.compileFile(obfuscatedPath, jscPath);
      await fs.unlink(obfuscatedPath);
      console.log(`✅ Finished ${filename} -> ${filename.replace(".js", ".jsc")}`);
    }

    console.log("🎉 Protection pipeline completed successfully!");
    app.quit();
  } catch (err) {
    console.error("❌ Protection pipeline failed:", err);
    app.exit(1);
  }
}

app.whenReady().then(run);
