"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("./server.js");

test("local server serves only application assets and rejects uploads and nonlocal hosts", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  function request(url, method = "GET", host = `127.0.0.1:${port}`) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: url, method, headers: { Host: host } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /SequenceConvert/);
  assert.equal(home.headers["cache-control"], "no-store");
  assert.equal((await request("/liftover.js")).status, 200);
  assert.equal((await request("/index.html", "HEAD")).body, "");
  for (const url of ["/fictional.vcf.gz", "/hg19.fa.gz", "/README.md", "/server.js", "/..%2findex.html", "/../index.html"]) {
    assert.equal((await request(url)).status, 404);
  }
  assert.equal((await request("/", "POST")).status, 405);
  assert.equal((await request("/", "GET", "untrusted.example")).status, 403);
});
