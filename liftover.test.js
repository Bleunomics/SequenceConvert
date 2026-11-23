"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const converter = require("./converter.js")();
const liftover = require("./liftover.js")(converter);

function chain(tStart, size, qStart, reverse = false, id = 1, destination = "chr1", qSize = 249250621) {
  return `chain 100 chr1 248956422 + ${tStart} ${tStart + size} ${destination} ${qSize} ${reverse ? "-" : "+"} ${qStart} ${qStart + size} ${id}\n${size}\n\n`;
}
const chainFile = text => new File([text], "synthetic.chain");
// Reusing Blob parts represents a full-length fictional all-A chromosome without
// allocating a chromosome-sized JavaScript string or reading any user files.
const unitSize = 1024 * 1024;
const unit = new Blob(["A".repeat(unitSize)]);
const length = 249250621;
const fastaFile = new File([
  ">chr1\n", ...Array(Math.floor(length / unitSize)).fill(unit),
  "A".repeat(length % unitSize), "\n"
], "synthetic.fa");
const indexFile = new File([`chr1\t${length}\t6\t${length}\t${length + 1}\n`], "synthetic.fa.fai");
const prepare = (text, extras = {}) => liftover.prepare({ chainFile: chainFile(text), fastaFile, indexFile, ...extras });

test("forward and negative query strands map one-based coordinates exactly and check target REF", async () => {
  const mapper = await prepare(chain(100, 10, 200) + chain(200, 10, 300, true, 2));
  assert.deepEqual(await mapper.map("1", 101, "A"), { chromosome: "1", position: 201, reverse: false });
  assert.deepEqual(await mapper.map("1", 110, "A"), { chromosome: "1", position: 210, reverse: false });
  assert.deepEqual(await mapper.map("1", 201, "T"), { chromosome: "1", position: length - 300, reverse: true });
  assert.deepEqual(await mapper.map("1", 210, "T"), { chromosome: "1", position: length - 309, reverse: true });
  assert.deepEqual(await mapper.map("1", 111, "A"), { reason: "unmapped" });
  assert.deepEqual(await mapper.map("2", 101, "A"), { reason: "unmapped" });
  assert.deepEqual(await mapper.map("1", 101, "C"), { reason: "referenceMismatch" });
  assert.deepEqual(await mapper.map("1", 201, "A"), { reason: "referenceMismatch" });
});

test("chain zero starts, reverse endpoints, and source/target gaps have no off-by-one errors", async () => {
  const text = chain(0, 1, 0) + chain(10, 1, 0, true, 2) +
    "chain 100 chr1 248956422 + 300 325 chr1 249250621 + 400 422 3\n10 5 2\n10\n";
  const mapper = await prepare(text);
  assert.equal((await mapper.map("1", 1, "A")).position, 1);
  assert.equal((await mapper.map("1", 11, "T")).position, length);
  assert.equal((await mapper.map("1", 310, "A")).position, 410);
  assert.deepEqual(await mapper.map("1", 311, "A"), { reason: "unmapped" });
  assert.deepEqual(await mapper.map("1", 315, "A"), { reason: "unmapped" });
  assert.equal((await mapper.map("1", 316, "A")).position, 413);
  assert.equal((await mapper.map("1", 325, "A")).position, 422);
  assert.deepEqual(await mapper.map("1", 326, "A"), { reason: "unmapped" });
});

test("overlapping chains are rejected rather than selected by score, and cross-chromosome sites are excluded", async () => {
  const mapper = await prepare(chain(100, 100, 200) + chain(105, 5, 400, false, 2) +
    chain(300, 10, 200, false, 3, "chr2", 243199373));
  assert.deepEqual(await mapper.map("1", 106, "A"), { reason: "ambiguousMapping" });
  assert.equal((await mapper.map("1", 150, "A")).position, 250);
  assert.deepEqual(await mapper.map("1", 301, "A"), { reason: "crossChromosome" });
});

test("wrong-direction and malformed chains stop explicitly", async () => {
  for (const text of [
    chain(100, 10, 200).replace("chr1 248956422", "chr1 249250621"),
    chain(100, 10, 200).replace("chr1 249250621", "chr1 248956422"),
    chain(100, 10, 200).replace("100 110", "100 109"),
    chain(100, 10, 200).replace("\n10\n", "\n9\n"),
    chain(100, 10, 200).replace("\n10\n", "\n10 0 0\n"),
    chain(100, 10, 200).replace("+ 100", "- 100"),
    "not a chain\n",
    ""
  ]) await assert.rejects(prepare(text), Error);
});

test("ordinary gzip chain input is decoded locally", async () => {
  const zipped = new File([gzipSync(chain(100, 10, 200))], "synthetic.chain.gz");
  assert.equal((await (await prepare("", { chainFile: zipped })).map("1", 101, "A")).position, 201);
  await assert.rejects(prepare("", { chainFile: new File(["not gzip"], "synthetic.chain.gz") }), /gzip header/);
});

test("FASTA indexing handles LF, CRLF, multiple contigs and a final line without newline", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = [">chrM synthetic", "ACGT", "AC", ">extra", "TTTT", "T"].join(newline);
    const file = new File([text], "tiny.fa");
    const built = await liftover.buildFai(file, () => {});
    const entries = (await built.text()).trim().split("\n").map(line => line.split("\t"));
    assert.equal(entries[0][1], "6");
    assert.equal(Number(entries[0][2]), (">chrM synthetic" + newline).length);
    assert.equal(entries[0][3], "4");
    assert.equal(Number(entries[0][4]), 4 + newline.length);
    assert.equal(entries[1][1], "5");
    const index = await liftover.readFai(built, file);
    assert.equal(index.get("MT").length, 6);
  }
});

test("automatic indexing is reused by prepare and returns a downloadable index", async () => {
  const file = new File([">chrM\n" + ("A".repeat(16571).match(/.{1,60}/g).join("\n")) + "\n"], "synthetic-mt.fa");
  const text = "chain 1 chrM 16569 + 0 10 chrM 16571 + 0 10 1\n10\n";
  let generated;
  const mapper = await liftover.prepare(
    { chainFile: chainFile(text), fastaFile: file },
    () => {}, blob => { generated = blob; }
  );
  assert.ok(generated instanceof Blob);
  assert.equal((await mapper.map("MT", 1, "A")).position, 1);
});

test("invalid references, index mismatches and unsupported wrapping stop explicitly", async () => {
  for (const text of ["", "ACGT\n", ">x\n", ">x\nAC\nAAAA\n", ">x\nAX!\n"]) {
    await assert.rejects(liftover.buildFai(new File([text], "bad.fa"), () => {}), Error);
  }
  await assert.rejects(prepare(chain(100, 10, 200), {
    fastaFile: new File([gzipSync(">chr1\nA\n")], "compressed.fa.gz")
  }), /temporary reference storage name/);
  for (const text of [
    "chr1\t4\t999999999\t4\t5\n",
    "chr1\t4\t6\t4\t10\n",
    "chr1\t4\t6\t4\t5\nchr1\t4\t6\t4\t5\n",
    "chr1\t4\t6\t4\t5\n1\t4\t6\t4\t5\n",
    "chr1\tNaN\t6\t4\t5\n"
  ]) await assert.rejects(liftover.readFai(new File([text], "bad.fai"), fastaFile), Error);
  const wrongIndex = new File(["chr1\t100\t6\t100\t101\n"], "bad.fai");
  const mapper = await prepare(chain(100, 10, 200), { indexFile: wrongIndex });
  await assert.rejects(mapper.map("1", 101, "A"), /does not match/);
});

test("converter exports lifted positions and complemented genotypes, with skip counts", async () => {
  const mapper = await prepare(chain(100, 10, 200) + chain(200, 10, 300, true, 2) +
    chain(400, 10, 400, false, 3) + chain(400, 10, 500, false, 4));
  const header = "##fileformat=VCFv4.2\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSYNTHETIC\n";
  const record = (chr, pos, id, ref, alt) => `${chr}\t${pos}\t${id}\t${ref}\t${alt}\t.\tPASS\t.\tGT\t0/1\n`;
  const text = header +
    record("1", 101, "rs1", "A", "C") +
    record("1", 201, "rs2", "T", "C") +
    record("1", 202, "rs3", "A", "C") +
    record("1", 301, "rs4", "A", "C") +
    record("1", 401, "rs5", "A", "C") +
    record("MT", 1, "rs6", "A", "C");
  async function* input() { yield text; }
  const result = await converter.convert(input(), { build: "38", sampleIndex: 0, mapper });
  const output = result.parts.join("").split("\n").filter(line => line && !line.startsWith("#"));
  assert.deepEqual(output, ["rs1\t1\t201\tAC", `rs2\t1\t${length - 300}\tAG`]);
  assert.equal(result.counts.lifted, 2);
  assert.equal(result.counts.referenceMismatch, 1);
  assert.equal(result.counts.unmapped, 1);
  assert.equal(result.counts.ambiguousMapping, 1);
  assert.equal(result.counts.mitochondrialSkipped, 1);
  await assert.rejects(converter.convert(input(), { build: "37", sampleIndex: 0, mapper }), /conflicting/);
});

function referenceStorage() {
  const state = { writes: 0, aborted: false, closed: false, parts: [] };
  const handle = {
    async createWritable() {
      const stream = new WritableStream({
        write(bytes) {
          state.writes++;
          assert.ok(bytes.length <= 1024 * 1024, "reference writes must be bounded");
          state.parts.push(bytes.slice());
        },
        close() { state.closed = true; },
        abort() { state.aborted = true; }
      });
      const writer = stream.getWriter();
      return {
        write: bytes => writer.write(bytes),
        close: () => writer.close(),
        abort: () => writer.abort()
      };
    },
    async getFile() {
      assert.equal(state.closed, true, "reference must be finalized before indexed reads");
      return new File(state.parts, "temporary-reference.fa");
    }
  };
  return { handle, state };
}

function bgzf(text) {
  const gzip = gzipSync(text);
  const block = Buffer.concat([
    Buffer.from([31,139,8,4,0,0,0,0,0,255,6,0,66,67,2,0,0,0]),
    gzip.subarray(10)
  ]);
  block.writeUInt16LE(block.length - 1, 16);
  return block;
}

test("compressed FASTA streams bounded writes, closes storage and preserves exact index bytes", async () => {
  const text = ">synthetic\r\n" + ("ACGT".repeat(32) + "\r\n").repeat(25000);
  const file = new File([gzipSync(text)], "fictional.fa.gz");
  const { handle, state } = referenceStorage();
  const decoded = await liftover.decompressReference(file, handle, () => {});
  assert.equal(state.aborted, false);
  assert.ok(state.writes >= 3);
  assert.equal(await decoded.text(), text);
  const plainIndex = await liftover.buildFai(new File([text], "fictional.fa"), () => {});
  const decodedIndex = await liftover.buildFai(decoded, () => {});
  assert.equal(await decodedIndex.text(), await plainIndex.text());
});

test("BGZF FASTA supports multiple members and rejects checksum corruption without finalizing storage", async () => {
  const text = ">chrM\n" + "ACGT".repeat(10000) + "\n";
  const blocks = [bgzf(text.slice(0, 100)), bgzf(text.slice(100)), bgzf("")];
  const { handle } = referenceStorage();
  assert.equal(await (await liftover.decompressReference(
    new File(blocks, "synthetic.fa.gz"), handle, () => {}
  )).text(), text);
  const corrupt = Buffer.from(blocks[1]);
  corrupt[corrupt.length - 8] ^= 0xff;
  const bad = referenceStorage();
  await assert.rejects(liftover.decompressReference(
    new File([blocks[0], corrupt], "bad.fa.gz"), bad.handle, () => {}
  ), /checksum mismatch/);
  assert.equal(bad.state.aborted, true);
  assert.equal(bad.state.closed, false);
});

test("reference storage write failures and non-FASTA payloads surface explicit errors", async () => {
  const compressed = new File([gzipSync(">chrM\n" + "A".repeat(1024 * 1024))], "synthetic.fa.gz");
  await assert.rejects(liftover.decompressReference(compressed, {
    async createWritable() { throw new DOMException("Test permission denied", "NotAllowedError"); }
  }, () => {}), /Cannot open temporary reference storage/);
  let aborted = false;
  const handle = {
    async createWritable() {
      return {
        async write() { throw new DOMException("Test quota exceeded", "QuotaExceededError"); },
        async abort() { aborted = true; }
      };
    },
    async getFile() { throw new Error("Partial data must not be used"); }
  };
  await assert.rejects(liftover.decompressReference(compressed, handle, () => {}), /storage is full or unavailable/);
  assert.equal(aborted, true);
  const storage = referenceStorage();
  await assert.rejects(liftover.decompressReference(
    new File([gzipSync("not a FASTA")], "wrong.fa.gz"), storage.handle, () => {}
  ), /not a FASTA/);
  await assert.rejects(prepare(chain(100, 10, 200), {
    fastaFile: new File([">chr1\nA\n"], "not-really-gzip.fa.gz")
  }), /no gzip header/);
});

test("compressed preparation uses local storage, builds or accepts the uncompressed FASTA index", async t => {
  const text = ">chrM\n" + "A".repeat(16571).match(/.{1,60}/g).join("\n") + "\n";
  const compressed = new File([gzipSync(text)], "fictional.fa.gz");
  const temporaryName = "sequenceconvert-reference-00000000-0000-0000-0000-000000000001.fa";
  const original = Object.getOwnPropertyDescriptor(navigator, "storage");
  t.after(() => {
    if (original) Object.defineProperty(navigator, "storage", original);
    else delete navigator.storage;
  });
  let nextHandle;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      async getDirectory() {
        return { async getFileHandle(name, options) {
          assert.equal(name, temporaryName);
          assert.equal(options, undefined, "worker must not recreate a cancelled temporary reference");
          return nextHandle;
        } };
      }
    }
  });
  const textChain = "chain 1 chrM 16569 + 0 10 chrM 16571 + 0 10 1\n10\n";
  let generated;
  nextHandle = referenceStorage().handle;
  const mapper = await liftover.prepare({
    chainFile: chainFile(textChain), fastaFile: compressed, temporaryName
  }, () => {}, blob => { generated = blob; });
  assert.equal((await mapper.map("MT", 1, "A")).position, 1);
  assert.ok(generated instanceof Blob);
  nextHandle = referenceStorage().handle;
  const reused = await liftover.prepare({
    chainFile: chainFile(textChain), fastaFile: compressed, temporaryName, indexFile: generated
  }, () => {}, () => { throw new Error("Supplied index must be reused"); });
  assert.equal((await reused.map("MT", 10, "A")).position, 10);
  Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
  await assert.rejects(liftover.prepare({
    chainFile: chainFile(textChain), fastaFile: compressed, temporaryName
  }), /needs browser file storage/);
});
