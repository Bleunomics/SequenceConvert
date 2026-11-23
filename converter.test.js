"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { inspect, convert, gzipChunks } = require("./converter.js")();

const HEADER = "##fileformat=VCFv4.2\n##reference=GRCh37\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSYNTHETIC\n";
function row(chrom = "1", pos = "101", id = "rs1001", ref = "A", alt = "G", gt = "0/1", filter = "PASS", info = ".", format = "GT") {
  return [chrom, pos, id, ref, alt, ".", filter, info, format, gt].join("\t") + "\n";
}
async function* chunks(text, size = 17) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}
const run = (text, options = {}) => convert(chunks(text), { build: "37", sampleIndex: 0, ...options });
const rows = result => result.parts.join("").split("\n").filter(line => line && !line.startsWith("#"));

test("reads only through sample header across tiny chunks and CRLF", async () => {
  const result = await inspect(chunks(HEADER.replace(/\n/g, "\r\n"), 1));
  assert.deepEqual(result, { samples: ["SYNTHETIC"], builds: ["37"] });
  async function* headerOnly() {
    yield HEADER;
    throw new Error("inspect must not request the body");
  }
  assert.equal((await inspect(headerOnly())).samples.length, 1);
});

test("exports exact four-column genotypes for phased, multiallelic, reference, and haploid calls", async () => {
  const result = await run(HEADER +
    row() +
    row("chr2", "202", "rs1002", "C", "T,G", "2|1") +
    row("X", "303", "rs1003", "T", "A", "1") +
    row("chrM", "404", "rs1004", "G", "A", "0") +
    row("Y", "505", "rs1005", "C", ".", "0") +
    row("22", "606", "custom;rs1006;rs1007", "C", "T", "0/0", ".") +
    row("3", "707", "rs1008", "A", "C,<NON_REF>", "1/0") +
    row("4", "808", "rs1009", "A", "G,<*>", "0/1"));
  assert.deepEqual(rows(result), [
    "rs1001\t1\t101\tAG", "rs1002\t2\t202\tGT", "rs1003\tX\t303\tA",
    "rs1004\tMT\t404\tG", "rs1005\tY\t505\tC", "rs1006\t22\t606\tCC",
    "rs1008\t3\t707\tAC", "rs1009\t4\t808\tAG"
  ]);
  assert.equal(result.counts.exported, 8);
});

test("skips structural variants, indels, no IDs, missing calls, filters, ploidy and alternate contigs", async () => {
  const result = await run(HEADER + row() +
    row("1", "102", "rs2", "A", "<DEL>", "0/1", "PASS", "SVTYPE=DEL") +
    row("1", "103", "rs3", "A", "AT") +
    row("1", "104", ".") +
    row("1", "105", "rs5", "A", "G", "0/.") +
    row("1", "106", "rs6", "A", "G", "0/1", "LowQual") +
    row("chrUn", "107", "rs7") +
    row("1", "108", "rs8", "A", "G", "1") +
    row("1", "109", "rs9", "A", "G", "0/1/1") +
    row("1", "110", "rs10", "A", "<NON_REF>", "1/1") +
    row("1", "111", "rs11", "A", "G", "20", "PASS", ".", "DP"));
  assert.equal(result.counts.records, 11);
  assert.equal(result.counts.nonSnp, 2);
  assert.equal(result.counts.noRsid, 1);
  assert.equal(result.counts.missingCall, 3);
  assert.equal(result.counts.filtered, 1);
  assert.equal(result.counts.nonPrimary, 1);
  assert.equal(result.counts.unsupportedPloidy, 2);
  assert.deepEqual(rows(result), ["rs1001\t1\t101\tAG"]);
});

test("selects the requested sample, including non-leading GT", async () => {
  const header = HEADER.replace("SYNTHETIC\n", "FIRST\tSECOND\n");
  const record = "1\t101\trs1001\tA\tC,G\t.\tPASS\t.\tDP:GT\t20:0/0\t25:2/1\n";
  assert.deepEqual(rows(await run(header + record, { sampleIndex: 1 })), ["rs1001\t1\t101\tCG"]);
  await assert.rejects(run(header + record, { sampleIndex: 2 }), /valid VCF sample/);
  await assert.rejects(run(header + record, { sampleIndex: -1 }), /valid VCF sample/);
});

test("rejects GRCh38, older and conflicting build hints even if user selects 37", async () => {
  for (const reference of ["GRCh38", "hg38", "hs38", "hg18", "NCBI36"]) {
    await assert.rejects(run(HEADER.replace("GRCh37", reference) + row()), /unsupported or conflicting/);
  }
  await assert.rejects(run(HEADER.replace("##reference=GRCh37", '##contig=<ID=1,assembly=GRCh38>') + row()), /unsupported or conflicting/);
  await assert.rejects(run(HEADER + row(), { build: "38" }), /liftover/);
  await assert.rejects(run(HEADER + row(), { build: "" }), /confirmed/);
  const unknown = HEADER.replace("##reference=GRCh37\n", "");
  assert.equal((await run(unknown + row())).counts.exported, 1);
});

test("duplicates agree regardless of phase; conflicting rsIDs are all excluded", async () => {
  const result = await run(HEADER + row() + row("1", "101", "rs1001", "A", "G", "1|0"));
  assert.equal(result.counts.duplicates, 1);
  assert.equal(result.counts.exported, 1);
  const retained = row("3", "303", "rs3003");
  for (const conflict of [
    row("1", "101", "rs1001", "A", "G", "1/1"),
    row("2", "101"),
    row("1", "102")
  ]) {
    const converted = await run(HEADER + row() + retained + conflict + row() + conflict);
    assert.deepEqual(rows(converted), ["rs3003\t3\t303\tAG"]);
    assert.equal(converted.counts.exported, 1);
    assert.equal(converted.counts.conflictingRsids, 1);
    assert.match(converted.parts.join(""), /# Conflicting rsIDs excluded entirely: 1/);
  }
  await assert.rejects(
    run(HEADER + row() + row("2", "101")),
    /conflicting rsIDs excluded: 1/
  );
});

test("late conflicts remove earlier calls even beyond an output-chunk boundary", async () => {
  async function* input() {
    yield HEADER;
    for (let i = 1; i <= 70000; i++) yield row("1", String(i), `rs${i}`);
    yield row("1", "1", "rs1", "A", "G", "1/1");
    yield row("1", "70000", "rs70000", "A", "G", "1/1");
    yield row("1", "1", "rs1");
  }
  const result = await convert(input(), { build: "37", sampleIndex: 0 });
  const output = rows(result);
  assert.ok(result.parts.length > 7, "exercise multiple output chunks");
  assert.equal(output.length, 69998);
  assert.equal(output[0], "rs2\t1\t2\tAG");
  assert.equal(output.at(-1), "rs69999\t1\t69999\tAG");
  assert.equal(result.counts.conflictingRsids, 2);
  assert.equal(result.counts.exported, output.length);
});

test("liftover counts exclude conflicted rsIDs and compare final mapped coordinates", async () => {
  const mapper = { async map(chr, position) {
    return { chromosome: chr, position: position + 100, reverse: false };
  } };
  const text = HEADER.replace("GRCh37", "GRCh38") + row() +
    row("2", "202", "rs2") + row("1", "102") + row();
  const result = await run(text, { build: "38", mapper });
  assert.deepEqual(rows(result), ["rs2\t2\t302\tAG"]);
  assert.equal(result.counts.exported, 1);
  assert.equal(result.counts.lifted, 1);
  assert.equal(result.counts.conflictingRsids, 1);
});

test("structural-only and unannotated files do not produce success-shaped empty exports", async () => {
  await assert.rejects(run(HEADER + row("1", "101", "rs1001", "A", "<DEL>")), /No exportable SNP/);
  await assert.rejects(run(HEADER + row("1", "101", ".")), /missing rsID: 1/);
  await assert.rejects(run(HEADER), /No exportable SNP/);
});

test("malformed headers, records, positions and genotype indices report errors", async () => {
  for (const text of [
    row(),
    HEADER.replace("##fileformat=VCFv4.2\n", "") + row(),
    HEADER.replace("\tFORMAT", "\tWRONG") + row(),
    HEADER.replace("SYNTHETIC\n", "SAME\tSAME\n") + row(),
    HEADER + "1\t101\trs1001\n",
    HEADER + row("1", "0"),
    HEADER + row("1", "9007199254740992"),
    HEADER + row("1", "101", "rs1001", "A", "G", "2/0"),
    HEADER + row("1", "101", "rs1001", "A", "G", "0/A"),
    HEADER + row("1", "101", "rs1001", "A", "G", "0/1:0/1", "PASS", ".", "GT:GT"),
    HEADER + row() + "#extra\n"
  ]) await assert.rejects(run(text), Error);
});

test("handles final unterminated line, UTF-8 sample names, and corrupt UTF-8", async () => {
  const text = HEADER.replace("SYNTHETIC", "SYNTH\u00c9TIQUE") + row().trimEnd();
  assert.equal((await run(text)).counts.exported, 1);
  async function* invalid() { yield new Uint8Array([0xff]); }
  await assert.rejects(inspect(invalid()), /encoded data/);
});

test("gzip streaming uses the standard browser decompressor", async () => {
  const bytes = gzipSync(HEADER + row());
  const stream = gzipChunks(new Blob([bytes]).stream());
  assert.equal((await convert(stream, { build: "37", sampleIndex: 0 })).counts.exported, 1);
});

function bgzf(text) {
  const gzip = gzipSync(text);
  const block = Buffer.concat([
    Buffer.from([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 0, 0]),
    gzip.subarray(10)
  ]);
  block.writeUInt16LE(block.length - 1, 16);
  return block;
}

function byteStream(bytes, size = 7) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    }
  });
}

test("BGZF streams multiple gzip members with headers and rows split across blocks", async () => {
  const text = HEADER + row() + row("2", "202", "rs1002");
  const blocks = [];
  for (let i = 0; i < text.length; i += 29) blocks.push(bgzf(text.slice(i, i + 29)));
  blocks.push(bgzf(""));
  const bytes = Buffer.concat(blocks);
  assert.deepEqual(await inspect(gzipChunks(byteStream(bytes, 1))), { samples: ["SYNTHETIC"], builds: ["37"] });
  const result = await convert(gzipChunks(byteStream(bytes)), { build: "37", sampleIndex: 0 });
  assert.deepEqual(rows(result), ["rs1001\t1\t101\tAG", "rs1002\t2\t202\tAG"]);
});

test("BGZF rejects truncated headers, truncated blocks, bad sizes and trailing junk", async () => {
  const valid = bgzf(HEADER + row());
  const badSize = Buffer.from(valid);
  badSize.writeUInt16LE(10, 16);
  const badExtra = Buffer.from(valid);
  badExtra.writeUInt16LE(3, 14);
  const tooLarge = Buffer.from(valid);
  tooLarge.writeUInt32LE(65537, tooLarge.length - 4);
  for (const bytes of [
    valid.subarray(0, 5), valid.subarray(0, valid.length - 1), badSize, badExtra,
    tooLarge, Buffer.concat([valid, Buffer.from("trailing junk")])
  ]) {
    await assert.rejects(
      convert(gzipChunks(byteStream(bytes)), { build: "37", sampleIndex: 0 }),
      /Truncated|Invalid|Malformed|exceeds/
    );
  }
});

test("BGZF rejects a corrupt checksum instead of exporting partial success", async () => {
  const block = bgzf(HEADER + row());
  block[block.length - 8] ^= 0xff;
  await assert.rejects(convert(gzipChunks(byteStream(block)), { build: "37", sampleIndex: 0 }));
});

test("enforces line and header size limits", async () => {
  const options = { build: "37", sampleIndex: 0 };
  await assert.rejects(
    convert(chunks("x".repeat(4 * 1024 * 1024 + 1), 65536), options), /record exceeds/
  );
  await assert.rejects(
    convert(chunks(("##comment=" + "a".repeat(1024 * 1024) + "\n").repeat(9), 65536), options), /header exceeds/
  );
});

test("streams a larger synthetic file and reports progress without dropping output", async () => {
  async function* records() {
    yield HEADER;
    for (let i = 1; i <= 35000; i++) yield row("1", String(i), `rs${i}`);
  }
  let progress = 0;
  const result = await convert(records(), { build: "37", sampleIndex: 0 }, () => progress++);
  assert.equal(result.counts.exported, 35000);
  assert.equal(rows(result).length, 35000);
  assert.ok(progress >= 4);
});
