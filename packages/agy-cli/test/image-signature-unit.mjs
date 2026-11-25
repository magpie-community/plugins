// Standalone checks for the image magic-byte guard. Run with:
//   node test/image-signature-unit.mjs
import { hasImageSignature } from "../index.mjs"

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? " :: " + detail : ""}`)
}

// A 1x1 PNG header, and real JPEG/GIF/WebP signatures.
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de", "hex")
const jpeg = Buffer.from("ffd8ffe000104a4649460001", "hex")
const gif = Buffer.from("47494638396101000100", "hex")
const webp = Buffer.from("524946461a0000005745425056503820", "hex")
const notImage = Buffer.from("AAAA", "base64")
const text = Buffer.from("hello, this is a text file labelled image/png")

check("PNG signature accepted", hasImageSignature(png, "image/png"))
check("JPEG signature accepted", hasImageSignature(jpeg, "image/jpeg"))
check("GIF89a signature accepted", hasImageSignature(gif, "image/gif"))
check("WebP RIFF....WEBP accepted", hasImageSignature(webp, "image/webp"))

check("base64 'AAAA' is not an image", !hasImageSignature(notImage, "image/png"))
check("text labelled image/png rejected", !hasImageSignature(text, "image/png"))
check("PNG bytes as image/jpeg rejected", !hasImageSignature(png, "image/jpeg"))
check("PNG bytes as image/gif rejected", !hasImageSignature(png, "image/gif"))
check("empty buffer rejected", !hasImageSignature(Buffer.alloc(0), "image/png"))
check("tiny buffer rejected", !hasImageSignature(Buffer.from([0x89, 0x50]), "image/png"))
check("unknown media type rejected", !hasImageSignature(png, "image/bmp"))
check("null rejected", !hasImageSignature(null, "image/png"))

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nALL OK")
