// Standalone checks for documents.mjs. Run with:
//   node test/documents-unit.mjs
import { documentRefusal, documentText } from "../documents.mjs"

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? " :: " + detail : ""}`)
}

const b64 = (s) => Buffer.from(s).toString("base64")
const doc = (source, title) => ({ type: "document", source, ...(title ? { title } : {}) })
const pdf = doc({ type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" }, "paper.pdf")

check("a text source is its text", documentText(doc({ type: "text", media_type: "text/plain", data: "HELLO" })) === "HELLO")
check("a titled text source is framed", documentText(doc({ type: "text", data: "HELLO" }, "a.txt")) === "[document: a.txt]\nHELLO\n[end of document]")
check("a content list of text parts is joined", documentText(doc({ type: "content", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })) === "a\nb")
check("a base64 text/plain source is decoded", documentText(doc({ type: "base64", media_type: "text/plain", data: b64("PLAIN ünïcode") })) === "PLAIN ünïcode")
check("a base64 JSON source is decoded", documentText(doc({ type: "base64", media_type: "application/json; charset=utf-8", data: b64('{"a":1}') })) === '{"a":1}')
check("a base64 text source that isn't UTF-8 is not passed as text", documentText(doc({ type: "base64", media_type: "text/plain", data: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") })) === null)

const url = documentText(doc({ type: "url", url: "https://example.com/spec.pdf" }, "spec"))
check("a URL source goes as its URL, said to be unread", url.includes("https://example.com/spec.pdf") && url.includes("spec") && url.includes("not attached"), url)
check("a URL source names neither agy nor the bridge", !/agy|bridge|magpie/i.test(url), url)
check("a URL source other than http(s) is refused", documentText(doc({ type: "url", url: "file:///etc/passwd" })) === null)

check("a PDF the user attached is refused", documentText(pdf) === null)
const note = documentText(pdf, { inToolResult: true })
check("a PDF inside a tool result is a note to read it another way", note.includes("paper.pdf") && note.includes("a PDF that could not be attached") && !note.includes("JVBERi0"), note)
check("the note names neither agy nor the bridge", !/agy|bridge|magpie/i.test(note), note)
check("a Files API file is refused, in a tool result too", documentText(doc({ type: "file", file_id: "file_1" }), { inToolResult: true }) === null)

const refusal = documentRefusal(pdf)
check("a PDF's refusal says what the user can do", refusal.what.includes("PDF") && /Paste the document's text/.test(refusal.hint), JSON.stringify(refusal))
check("a file id's refusal says to send it inline", /inline/.test(documentRefusal(doc({ type: "file", file_id: "f" })).hint))

if (failed) {
  console.error(`${failed} FAILED`)
  process.exit(1)
}
console.log("ALL OK")
