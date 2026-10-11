// Local obfuscation deters casual inspection; the runtime key remains recoverable.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const JavaScriptObfuscator = require('javascript-obfuscator')

const ALGO = 'aes-256-gcm'

const RUNTIME_DIR_NAME = '.tia-rt'

exports.default = async function afterPack(context) {
  const keyHex = process.env.TIA_ASAR_KEY
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('TIA_ASAR_KEY must be set to a 64-char hex string (32 bytes) to build a packaged release.')
  }
  const key = Buffer.from(keyHex, 'hex')

  const isMac = context.electronPlatformName === 'darwin'
  const resourcesDir = isMac
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')

  const asarPath = path.join(resourcesDir, 'app.asar')
  const encPath = path.join(resourcesDir, 'app.dat')
  const appDir = path.join(resourcesDir, 'app')

  const asarBuf = fs.readFileSync(asarPath)

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(asarBuf), cipher.final()])
  const authTag = cipher.getAuthTag()

  fs.writeFileSync(encPath, Buffer.concat([iv, authTag, ciphertext]))
  fs.rmSync(asarPath)

  const unpackedSrc = path.join(resourcesDir, 'app.asar.unpacked')
  const unpackedDst = path.join(resourcesDir, RUNTIME_DIR_NAME)
  if (fs.existsSync(unpackedSrc)) fs.renameSync(unpackedSrc, unpackedDst)

  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'tia-launcher-bootstrap',
        version: context.packager.appInfo.version,
        main: 'bootstrap.js'
      },
      null,
      2
    )
  )

  const source = bootstrapSource(keyHex)
  const obfuscated = JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 1,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: true,
    target: 'node'
  }).getObfuscatedCode()

  fs.writeFileSync(path.join(appDir, 'bootstrap.js'), obfuscated)
}


function bootstrapSource(keyHex) {
  const keyBytes = Buffer.from(keyHex, 'hex')
  const CHUNKS = 4
  const chunkSize = Math.ceil(keyBytes.length / CHUNKS)

  const parts = []
  for (let i = 0; i < CHUNKS; i++) {
    const chunk = keyBytes.subarray(i * chunkSize, (i + 1) * chunkSize)
    if (chunk.length === 0) continue
    const salt = crypto.randomBytes(chunk.length)
    const masked = Buffer.alloc(chunk.length)
    for (let j = 0; j < chunk.length; j++) masked[j] = chunk[j] ^ salt[j]
    parts.push({ masked: [...masked], salt: [...salt] })
  }

  const partsLiteral = parts.map((p) => `{m:[${p.masked.join(',')}],s:[${p.salt.join(',')}]}`).join(',')

  return `"use strict";
// Use unpatched fs to write the decrypted archive.
const fs = require("original-fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const KEY_PARTS = [${partsLiteral}];
const KEY = Buffer.concat(
  KEY_PARTS.map((p) => Buffer.from(p.m.map((b, i) => b ^ p.s[i])))
);

const encPath = path.join(__dirname, "..", "app.dat");
const raw = fs.readFileSync(encPath);
const iv = raw.subarray(0, 12);
const authTag = raw.subarray(12, 28);
const ciphertext = raw.subarray(28);

const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
decipher.setAuthTag(authTag);
const asarBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

// Electron requires the .asar extension for archive resolution.
const tmpAsar = path.join(os.tmpdir(), \`tia-\${process.pid}-\${Date.now()}.asar\`);
fs.writeFileSync(tmpAsar, asarBuf, { mode: 0o600 });

// Recreate the unpacked native-module directory beside the temporary archive.
const originalUnpacked = path.join(__dirname, "..", ${JSON.stringify(RUNTIME_DIR_NAME)});
const tmpUnpacked = \`\${tmpAsar}.unpacked\`;
if (fs.existsSync(originalUnpacked)) fs.cpSync(originalUnpacked, tmpUnpacked, { recursive: true });

process.on("exit", () => {
  try { fs.unlinkSync(tmpAsar); } catch {}
  try { fs.rmSync(tmpUnpacked, { recursive: true, force: true }); } catch {}
});

require(path.join(tmpAsar, "out", "main", "index.js"));
`
}
