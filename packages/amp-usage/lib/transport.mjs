import { request } from "node:http";

// This is a host-side loopback request. Node fetch adds Sec-Fetch-Mode, which
// Magpie correctly treats as a browser request and refuses without a key.
export function sendUsage(url, init) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers, signal: init.signal },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.destroy(new Error("Magpie acknowledgement is too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            async json() {
              return JSON.parse(Buffer.concat(chunks).toString("utf8"));
            },
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
