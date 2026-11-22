// Quick's event-stream frame codec, recovered from 121 captured frames
// (test/fixtures-ws.json) and verified against every one of them:
//
//   [0..3]   total length, big-endian, counting the whole frame
//   [4..7]   headers length, big-endian — counted from offset 12: the
//            4 bytes at [8..11] (a per-frame id) belong to neither the
//            headers nor the body
//   [8..11]  per-frame id, not needed by callers
//   [12..]   headers: a run of [keyLen][key][0x07 0x00][valueLen][value]
//            — bare 1-byte lengths, keys like ":event-type", the value a
//            plain string; 0x07 0x00 is a constant 2-byte marker between
//            key and value
//   [..]     body: CBOR — a1 67 "payload" 58/59 <len> <JSON bytes>, i.e.
//            {"payload": <json string as bytes>}; a handshake frame may
//            carry an empty indefinite map (bf ff) instead
//   [-4..]   CRC32 of everything before it (zlib.crc32 matches all 121)
//
// The direction is in the headers: requests say rawInputEvent, replies
// rawOutputEvent.

import zlib from "node:zlib"
import { decode, encode } from "cbor2"

const MARKER = Buffer.from([0x07, 0x00])

// ---- reading ---------------------------------------------------------------------------

// parseFrame splits a frame into its headers ({":event-type":
// "rawInputEvent", …}) and its body — the {"payload": json} bytes the CBOR
// body wraps, parsed back to a value. It throws on a bad CRC or a frame
// whose pieces run past its end.
export function parseFrame(buf) {
  if (buf.length < 20) throw new Error(`Quick frame too short: ${buf.length} bytes`)
  const total = buf.readUInt32BE(0)
  if (total !== buf.length) throw new Error(`Quick frame length mismatch: header says ${total}, got ${buf.length}`)
  const crc = buf.readUInt32BE(total - 4)
  const computed = zlib.crc32(buf.subarray(0, total - 4))
  if (crc !== computed) throw new Error(`Quick frame CRC mismatch: frame ${crc.toString(16)}, computed ${computed.toString(16)}`)
  const headersLen = buf.readUInt32BE(4)
  const headersEnd = 12 + headersLen
  if (headersEnd > total - 4) throw new Error(`Quick frame headers run past its end: ${headersEnd} > ${total - 4}`)
  const headers = {}
  let i = 12
  while (i + 2 <= headersEnd) {
    const keyLen = buf[i++]
    const key = buf.subarray(i, i + keyLen).toString("utf8")
    i += keyLen + 2 // the 0x07 0x00 marker
    const valueLen = buf[i++]
    headers[key] = buf.subarray(i, i + valueLen).toString("utf8")
    i += valueLen
  }
  const bodyBytes = buf.subarray(headersEnd, total - 4)
  let body
  try {
    const map = decode(bodyBytes)
    const p = map?.payload
    body = p === undefined ? map : Buffer.isBuffer(p) ? JSON.parse(p.toString("utf8")) : p
  } catch {
    body = undefined // an empty indefinite map (bf ff) and friends
  }
  return { headers, body }
}

// readFrames splits a byte stream into frames by the 4-byte total length
// each frame opens with. Returns the frames and the bytes left over (a
// partial frame to prepend the next chunk to).
export function readFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    const total = buf.readUInt32BE(off)
    if (total < 20 || off + total > buf.length) break
    frames.push(buf.subarray(off, off + total))
    off += total
  }
  return { frames, rest: buf.subarray(off) }
}

// ---- writing ---------------------------------------------------------------------------

// buildFrame assembles a frame the way the web client's send path does.
// headers is a plain object (":event-type" → "rawInputEvent", …); body is
// the message value, written as {"payload": JSON.stringify(body)} in CBOR —
// the shape every captured user_message, ping and session_connect carries.
export function buildFrame(headers, body) {
  const head = []
  let headersLen = 0
  for (const [key, value] of Object.entries(headers)) {
    const kb = Buffer.from(key, "utf8")
    const vb = Buffer.from(value, "utf8")
    head.push(Buffer.from([kb.length]), kb, MARKER, Buffer.from([vb.length]), vb)
    headersLen += 1 + kb.length + 2 + 1 + vb.length
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8")
  // cbor2 turns a Buffer into a {type:"Buffer"} map; the wire form is a
  // bare CBOR byte string (0x58/0x59), so write Uint8Array and tag it
  const bodyCbor = Buffer.from(encode({ payload: new Uint8Array(payload) }))
  const total = 12 + headersLen + bodyCbor.length + 4
  const out = Buffer.alloc(total)
  let off = 0
  const put = (b) => {
    b.copy(out, off)
    off += b.length
  }
  const len = Buffer.alloc(4)
  len.writeUInt32BE(total)
  put(len)
  len.writeUInt32BE(headersLen)
  put(len)
  put(crypto.getRandomValues(Buffer.alloc(4))) // the per-frame id
  for (const b of head) put(b)
  put(bodyCbor)
  const crc = zlib.crc32(out.subarray(0, off))
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc)
  put(tail)
  return out
}

// a SEND frame's headers, as the client sends them
export function inputHeaders() {
  return { ":event-type": "rawInputEvent", ":content-type": "application/cbor", ":message-type": "event" }
}

// the payload a SEND frame wraps: the captured user_message shape
export function buildMessage(type, payload) {
  return buildFrame(inputHeaders(), { type, payload })
}
