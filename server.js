"use strict";
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/converter.js", ["converter.js", "text/javascript"]],
  ["/liftover.js", ["liftover.js", "text/javascript"]],
  ["/app.js", ["app.js", "text/javascript"]]
]);

function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(request.headers.host || "")) {
      response.writeHead(403).end("Local access only.");
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Uploads are not supported.");
      return;
    }
    const asset = assets.get((request.url || "").split("?")[0]);
    if (!asset) {
      response.writeHead(404).end("Not found.");
      return;
    }
    try {
      const bytes = await readFile(path.join(__dirname, asset[0]));
      response.writeHead(200, {
        "Content-Type": `${asset[1]}; charset=utf-8`,
        "Content-Length": bytes.length
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      console.error(`Cannot serve ${asset[0]}: ${error.message}`);
      response.writeHead(500).end("Cannot read an application file. See the launcher window.");
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.on("error", error => {
    console.error(`Cannot start local converter: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(8765, "127.0.0.1", () => {
    const url = "http://127.0.0.1:8765";
    console.log(`SequenceConvert: ${url}`);
    console.log("Open this address in Chrome or Edge. Keep this window open; press Ctrl+C to stop.");
    console.log("Only application assets are served. Genomic files cannot be requested or uploaded.");
    if (process.argv.includes("--open")) {
      const { spawn } = require("node:child_process");
      const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" });
      child.on("error", error => console.error(`Could not open the browser: ${error.message}. Open ${url} manually.`));
    }
  });
}
module.exports = { createServer };
