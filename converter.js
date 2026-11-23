/* Shared by the browser worker and the synthetic-data Node tests. */
(function (root) {
  "use strict";
  function createConverter() {
    const BASE = /^[ACGT]$/;
    const MAX_LINE = 4 * 1024 * 1024;
    const MAX_HEADER = 8 * 1024 * 1024;
    const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      return value >>> 0;
    });

    async function* streamChunks(stream) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      }
    }

    async function* gzipChunks(stream) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("Gzip streaming is not supported. Use an up-to-date Chrome or Edge browser.");
      }
      const reader = stream.getReader();
      let pending = new Uint8Array(0);
      let blocked = false;

      async function readBytes(count, allowEnd = false) {
        const bytes = new Uint8Array(count);
        let filled = 0;
        while (filled < count) {
          if (!pending.length) {
            const result = await reader.read();
            if (result.done) {
              if (!filled && allowEnd) return null;
              throw new Error("Truncated gzip/BGZF file. Obtain a complete copy before converting.");
            }
            pending = result.value;
            if (!pending.length) continue;
          }
          const size = Math.min(count - filled, pending.length);
          bytes.set(pending.subarray(0, size), filled);
          pending = pending.subarray(size);
          filled += size;
        }
        return bytes;
      }

      try {
        while (true) {
          const fixed = await readBytes(10, blocked);
          if (!fixed) return;
          if (fixed[0] !== 0x1f || fixed[1] !== 0x8b || fixed[2] !== 8 || (fixed[3] & 0xe0)) {
            throw new Error("Invalid gzip/BGZF header or unexpected trailing data.");
          }
          const prefix = [fixed];
          let headerSize = fixed.length;
          let blockSize = null;
          if (fixed[3] & 4) {
            const lengthBytes = await readBytes(2);
            const extraLength = lengthBytes[0] | (lengthBytes[1] << 8);
            const extra = await readBytes(extraLength);
            prefix.push(lengthBytes, extra);
            headerSize += 2 + extraLength;
            for (let offset = 0; offset < extra.length;) {
              if (offset + 4 > extra.length) throw new Error("Malformed gzip extra field.");
              const size = extra[offset + 2] | (extra[offset + 3] << 8);
              if (offset + 4 + size > extra.length) throw new Error("Malformed gzip extra field length.");
              if (extra[offset] === 66 && extra[offset + 1] === 67) {
                if (size !== 2 || blockSize !== null) throw new Error("Malformed BGZF block-size field.");
                blockSize = (extra[offset + 4] | (extra[offset + 5] << 8)) + 1;
              }
              offset += 4 + size;
            }
          }
          if (blockSize === null) {
            if (blocked) throw new Error("Expected another BGZF block, but found a non-BGZF gzip member.");
            // Ordinary gzip has no block-size field. Reattach the consumed header.
            const restored = new ReadableStream({
              async pull(controller) {
                if (prefix.length) { controller.enqueue(prefix.shift()); return; }
                if (pending.length) {
                  controller.enqueue(pending);
                  pending = new Uint8Array(0);
                  return;
                }
                const result = await reader.read();
                if (result.done) controller.close();
                else controller.enqueue(result.value);
              },
              cancel(reason) { return reader.cancel(reason); }
            });
            yield* streamChunks(restored.pipeThrough(new DecompressionStream("gzip")));
            return;
          }
          blocked = true;
          if (fixed[3] !== 4 || blockSize < headerSize + 8 || blockSize > 65536) {
            throw new Error("Invalid BGZF block header or size.");
          }
          const body = await readBytes(blockSize - headerSize);
          const expectedSize = new DataView(body.buffer, body.byteOffset + body.length - 4, 4).getUint32(0, true);
          if (expectedSize > 65536) throw new Error("BGZF uncompressed block exceeds 64 KiB.");
          const expectedCrc = new DataView(body.buffer, body.byteOffset + body.length - 8, 4).getUint32(0, true);
          const member = new Blob([body.subarray(0, body.length - 8)]).stream()
            .pipeThrough(new DecompressionStream("deflate-raw"));
          let decodedSize = 0;
          let crc = 0xffffffff;
          // Decode members separately: browser gzip decoders may reject concatenated members.
          for await (const chunk of streamChunks(member)) {
            decodedSize += chunk.length;
            if (decodedSize > 65536) throw new Error("BGZF uncompressed block exceeds 64 KiB.");
            for (const byte of chunk) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
            yield chunk;
          }
          if (decodedSize !== expectedSize) throw new Error("BGZF uncompressed block size mismatch.");
          if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw new Error("BGZF checksum mismatch. The compressed file is corrupt.");
        }
      } finally {
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      }
    }

    async function* lines(chunks) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      for await (const chunk of chunks) {
        pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let start = 0;
        let end;
        while ((end = pending.indexOf("\n", start)) !== -1) {
          if (end - start > MAX_LINE) throw new Error("VCF record exceeds the 4 MiB safety limit.");
          yield pending.slice(start, end).replace(/\r$/, "");
          start = end + 1;
        }
        pending = pending.slice(start);
        if (pending.length > MAX_LINE) throw new Error("VCF record exceeds the 4 MiB safety limit.");
      }
      pending += decoder.decode();
      if (pending.length > MAX_LINE) throw new Error("VCF record exceeds the 4 MiB safety limit.");
      if (pending) yield pending.replace(/\r$/, "");
    }

    function newHeader() {
      return { samples: [], builds: new Set(), version: false, size: 0, columns: 0 };
    }

    function readHeader(line, header) {
      header.size += line.length + 1;
      if (header.size > MAX_HEADER) throw new Error("VCF header exceeds the 8 MiB safety limit.");
      if (line.startsWith("##fileformat=VCFv4.")) header.version = true;
      if (/^##(?:reference=|contig=)/i.test(line)) {
        if (/(?:GRCh37|hg19|human_g1k_v37|hs37d5|assembly="?b37)(?![a-z0-9])/i.test(line)) header.builds.add("37");
        if (/(?:GRCh38|hg38|hs38)(?![a-z0-9])/i.test(line)) header.builds.add("38");
        if (/(?:GRCh36|hg18|NCBI36)(?![a-z0-9])/i.test(line)) header.builds.add("other");
      }
      if (line.startsWith("#CHROM\t")) {
        const columns = line.split("\t");
        if (!header.version) throw new Error("Expected a VCF v4.x fileformat header.");
        const expected = ["#CHROM", "POS", "ID", "REF", "ALT", "QUAL", "FILTER", "INFO", "FORMAT"];
        if (expected.some((value, i) => columns[i] !== value) || columns.length < 10) {
          throw new Error("Expected a tab-delimited VCF with FORMAT and at least one sample.");
        }
        header.samples = columns.slice(9);
        if (header.samples.some(name => !name || /[\u0000-\u001f]/.test(name)) ||
            new Set(header.samples).size !== header.samples.length) {
          throw new Error("VCF sample names must be nonempty and unique.");
        }
        header.columns = columns.length;
        return true;
      }
      if (!line.startsWith("#")) throw new Error("Missing #CHROM sample header.");
      return false;
    }

    function publicHeader(header) {
      return { samples: header.samples, builds: [...header.builds] };
    }

    async function inspect(chunks) {
      const header = newHeader();
      for await (const line of lines(chunks)) {
        if (readHeader(line, header)) return publicHeader(header);
      }
      throw new Error("No #CHROM sample header found.");
    }

    function checkBuild(header, options) {
      const { build, mapper } = options;
      if (!["37", "38"].includes(build)) throw new Error("Select the confirmed human source build.");
      if (build === "38" && (!mapper || typeof mapper.map !== "function")) {
        throw new Error("GRCh38 requires configured chain and target reference files for liftover, not relabelling.");
      }
      if (header.builds.has("other") || [...header.builds].some(value => value !== build)) {
        throw new Error("The header indicates an unsupported or conflicting reference build. Conversion stopped; coordinates were not relabelled.");
      }
    }

    function chromosome(value) {
      const normalized = value.replace(/^chr/i, "").toUpperCase();
      if (/^(?:[1-9]|1[0-9]|2[0-2]|X|Y)$/.test(normalized)) return normalized;
      if (normalized === "M" || normalized === "MT") return "MT";
      return null;
    }

    async function convert(chunks, options, onProgress = () => {}) {
      const header = newHeader();
      const counts = {
        records: 0, exported: 0, nonPrimary: 0, nonSnp: 0, filtered: 0,
        noRsid: 0, missingCall: 0, unsupportedPloidy: 0, duplicates: 0,
        lifted: 0, unmapped: 0, ambiguousMapping: 0, referenceMismatch: 0, crossChromosome: 0,
        mitochondrialSkipped: 0, conflictingRsids: 0
      };
      const seen = new Map();
      const parts = [
        "# 23andMe-style SNP export generated locally by SequenceConvert\n",
        "# Not an official 23andMe test; partial called SNPs only; no imputation\n",
        "# Coordinates: human GRCh37 / hg19; forward reference strand\n",
        options.build === "38" ? "# Source: GRCh38; chain-mapped to hg19; target REF checked; reverse-strand alleles complemented\n" : "# Source: GRCh37 / hg19; coordinates retained\n",
        "# rsid\tchromosome\tposition\tgenotype\n"
      ];
      let ready = false;
      let sampleColumn;
      let lineNumber = 0;
      for await (const line of lines(chunks)) {
        lineNumber++;
        if (!ready) {
          if (readHeader(line, header)) {
            checkBuild(header, options);
            if (!Number.isInteger(options.sampleIndex) || options.sampleIndex < 0 ||
                options.sampleIndex >= header.samples.length) throw new Error("Select a valid VCF sample.");
            sampleColumn = 9 + options.sampleIndex;
            ready = true;
          }
          continue;
        }
        if (!line) continue;
        if (line.startsWith("#")) throw new Error(`Unexpected header after data at line ${lineNumber}.`);
        counts.records++;
        if (counts.records % 10000 === 0) onProgress({ ...counts });
        const fields = line.split("\t");
        if (fields.length !== header.columns) throw new Error(`Wrong column count at VCF line ${lineNumber}. No partial output was saved.`);
        const [chrom, pos, id, ref, alt, , filter, info, format] = fields;
        if (!/^[1-9]\d*$/.test(pos) || !Number.isSafeInteger(Number(pos))) {
          throw new Error(`Invalid position at VCF line ${lineNumber}.`);
        }
        const chr = chromosome(chrom);
        if (!chr) { counts.nonPrimary++; continue; }
        if (filter !== "PASS" && filter !== ".") { counts.filtered++; continue; }
        const alternates = alt === "." ? [] : alt.split(",");
        if (!BASE.test(ref) || /(?:^|;)SVTYPE=/.test(info) ||
            alternates.some(a => !BASE.test(a) && a !== "<NON_REF>" && a !== "<*>")) {
          counts.nonSnp++; continue;
        }
        const rsid = id.split(";").find(value => /^rs[1-9]\d*$/.test(value));
        if (!rsid) { counts.noRsid++; continue; }
        const formatKeys = format.split(":");
        const gtIndex = formatKeys.indexOf("GT");
        if (gtIndex < 0) { counts.missingCall++; continue; }
        if (formatKeys.lastIndexOf("GT") !== gtIndex) throw new Error(`Duplicate GT field at VCF line ${lineNumber}.`);
        const sample = fields[sampleColumn].split(":");
        const gt = sample[gtIndex];
        if (!gt || gt.split(/[|/]/).includes(".")) { counts.missingCall++; continue; }
        if (!/^\d+(?:[|/]\d+)*$/.test(gt)) throw new Error(`Malformed GT at VCF line ${lineNumber}.`);
        const indices = gt.split(/[|/]/).map(Number);
        if (indices.some(i => !Number.isSafeInteger(i) || i > alternates.length)) {
          throw new Error(`GT allele index outside REF/ALT at VCF line ${lineNumber}.`);
        }
        if (indices.length > 2 || (indices.length === 1 && chr !== "X" && chr !== "Y" && chr !== "MT")) {
          counts.unsupportedPloidy++; continue;
        }
        const alleles = [ref, ...alternates];
        const bases = indices.map(i => alleles[i]);
        if (bases.some(base => !BASE.test(base))) { counts.missingCall++; continue; }
        // Phase and allele order do not affect a consumer raw genotype.
        let outputChr = chr;
        let outputPos = pos;
        let outputBases = bases;
        if (options.build === "38") {
          // UCSC hg19 chrM is not the rCRS mitochondrial reference used by GRCh37 raw tests.
          if (chr === "MT") { counts.mitochondrialSkipped++; continue; }
          const mapped = await options.mapper.map(chr, Number(pos), ref);
          if (mapped.reason) {
            if (!["unmapped", "ambiguousMapping", "referenceMismatch", "crossChromosome"].includes(mapped.reason)) throw new Error("Unexpected liftover rejection reason.");
            counts[mapped.reason]++;
            continue;
          }
          outputChr = mapped.chromosome;
          outputPos = String(mapped.position);
          if (mapped.reverse) {
            const complement = { A: "T", T: "A", C: "G", G: "C" };
            outputBases = bases.map(base => complement[base]);
          }
        }
        const genotype = outputBases.sort().join("");
        const record = `${rsid}\t${outputChr}\t${outputPos}\t${genotype}\n`;
        if (seen.has(rsid)) {
          const previous = seen.get(rsid);
          if (previous === null) continue;
          if (previous === record) {
            counts.duplicates++;
          } else {
            // Keep a tombstone: no later call may restore an ambiguous rsID.
            seen.set(rsid, null);
            counts.conflictingRsids++;
            counts.exported--;
            if (options.build === "38") counts.lifted--;
          }
          continue;
        }
        seen.set(rsid, record);
        counts.exported++;
        if (options.build === "38") counts.lifted++;
      }
      if (!ready) throw new Error("No #CHROM sample header found.");
      if (!counts.exported) {
        throw new Error(
          "No exportable SNP genotypes were found. Structural-variant-only files cannot supply ancestry SNPs. " +
          "Use a SNP/small-variant VCF of a supported build, annotated with rsIDs and sample GT calls. " +
          `Records: ${counts.records}; non-SNP: ${counts.nonSnp}; missing rsID: ${counts.noRsid}; filtered: ${counts.filtered}; missing calls: ${counts.missingCall}; non-primary contigs: ${counts.nonPrimary}; unsupported ploidy: ${counts.unsupportedPloidy}; unmapped: ${counts.unmapped}; ambiguous mapping: ${counts.ambiguousMapping}; target REF mismatches: ${counts.referenceMismatch}; cross-chromosome: ${counts.crossChromosome}; mitochondrial sites excluded from liftover: ${counts.mitochondrialSkipped}; conflicting rsIDs excluded: ${counts.conflictingRsids}.`
        );
      }
      parts.splice(parts.length - 1, 0, `# Conflicting rsIDs excluded entirely: ${counts.conflictingRsids}\n`);
      // Serialize only after all records are checked, so even late conflicts remove earlier calls.
      let buffer = "";
      for (const record of seen.values()) {
        if (record === null) continue;
        buffer += record;
        if (buffer.length >= 1024 * 1024) { parts.push(buffer); buffer = ""; }
      }
      if (buffer) parts.push(buffer);
      onProgress({ ...counts });
      return { parts, counts };
    }
    return { inspect, convert, lines, streamChunks, gzipChunks };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = createConverter;
  else root.createConverter = createConverter;
})(typeof globalThis !== "undefined" ? globalThis : this);
