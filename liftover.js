(function (root) {
  "use strict";
  function createLiftover(converter) {
    const sourceLengths = [248956422,242193529,198295559,190214555,181538259,170805979,159345973,145138636,138394717,133797422,135086622,133275309,114364328,107043718,101991189,90338345,83257441,80373285,58617616,64444167,46709983,50818468,156040895,57227415,16569];
    const targetLengths = [249250621,243199373,198022430,191154276,180915260,171115067,159138663,146364022,141213431,135534747,135006516,133851895,115169878,107349540,102531392,90354753,81195210,78077248,59128983,63025520,48129895,51304566,155270560,59373566,16571];
    const names = [...Array.from({ length: 22 }, (_, i) => String(i + 1)), "X", "Y", "MT"];
    const complement = { A: "T", T: "A", C: "G", G: "C" };
    const canonical = name => {
      const value = name.replace(/^chr/i, "").toUpperCase();
      const normalized = value === "M" ? "MT" : value;
      return names.includes(normalized) ? normalized : null;
    };
    function integer(text, label) {
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`Invalid ${label}.`);
      return Number(text);
    }

    async function fileChunks(file) {
      const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      const gzip = magic[0] === 31 && magic[1] === 139;
      if (/\.gz$/i.test(file.name) && !gzip) throw new Error("The selected chain .gz file has no gzip header.");
      return gzip ? converter.gzipChunks(file.stream()) : converter.streamChunks(file.stream());
    }

    async function readChain(file) {
      const byChromosome = new Map();
      let chain = null;
      let validated = 0;
      let blockCount = 0;
      let lineNumber = 0;
      for await (const raw of converter.lines(await fileChunks(file))) {
        lineNumber++;
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const fields = line.split(/\s+/);
        if (fields[0] === "chain") {
          if (chain) throw new Error(`Unterminated chain before line ${lineNumber}.`);
          if (fields.length !== 13) throw new Error(`Invalid chain header at line ${lineNumber}.`);
          const [, score, tName, tSize, tStrand, tStart, tEnd, qName, qSize, qStrand, qStart, qEnd, id] = fields;
          integer(score, "chain score");
          integer(id, "chain ID");
          chain = {
            source: canonical(tName), destination: canonical(qName),
            tSize: integer(tSize, "source chromosome length"), qSize: integer(qSize, "target chromosome length"),
            t: integer(tStart, "chain source start"), tEnd: integer(tEnd, "chain source end"),
            q: integer(qStart, "chain target start"), qEnd: integer(qEnd, "chain target end"),
            reverse: qStrand === "-"
          };
          if (tStrand !== "+" || !["+", "-"].includes(qStrand) ||
              chain.t >= chain.tEnd || chain.tEnd > chain.tSize ||
              chain.q >= chain.qEnd || chain.qEnd > chain.qSize) throw new Error("Invalid chain coordinates or strands.");
          if (chain.source && chain.tSize !== sourceLengths[names.indexOf(chain.source)]) {
            throw new Error("Chain source lengths do not match GRCh38. Select hg38ToHg19.over.chain, not the reverse direction.");
          }
          if (chain.destination && chain.qSize !== targetLengths[names.indexOf(chain.destination)]) {
            throw new Error("Chain target lengths do not match UCSC hg19. Select the hg38-to-hg19 chain.");
          }
          if (chain.source && chain.destination) validated++;
          continue;
        }
        if (!chain || ![1, 3].includes(fields.length)) throw new Error(`Invalid chain block at line ${lineNumber}.`);
        const size = integer(fields[0], "chain block size");
        if (!size || chain.t + size > chain.tEnd || chain.q + size > chain.qEnd) throw new Error("Chain block exceeds alignment bounds.");
        if (chain.source) {
          if (!byChromosome.has(chain.source)) byChromosome.set(chain.source, []);
          byChromosome.get(chain.source).push({
            start: chain.t, end: chain.t + size, q: chain.q,
            destination: chain.destination, qSize: chain.qSize, reverse: chain.reverse
          });
        }
        if (++blockCount > 5000000) throw new Error("Chain exceeds the five-million-block memory safety limit.");
        chain.t += size;
        chain.q += size;
        if (fields.length === 1) {
          if (chain.t !== chain.tEnd || chain.q !== chain.qEnd) throw new Error("Chain ends do not match the block coordinates.");
          chain = null;
        } else {
          chain.t += integer(fields[1], "source gap");
          chain.q += integer(fields[2], "target gap");
          if (chain.t >= chain.tEnd || chain.q >= chain.qEnd) throw new Error("Chain gap exceeds alignment bounds.");
        }
      }
      if (chain) throw new Error("Truncated chain: final block is missing.");
      if (!validated) throw new Error("No recognized GRCh38-to-hg19 primary chromosome alignments in this chain.");
      for (const blocks of byChromosome.values()) {
        blocks.sort((a, b) => a.start - b.start);
        let maxEnd = 0;
        for (const block of blocks) {
          maxEnd = Math.max(maxEnd, block.end);
          block.maxEnd = maxEnd;
        }
      }
      return byChromosome;
    }

    async function buildFai(fasta, onStatus) {
      const entries = [];
      let current = null;
      let offset = 0;
      let pending = new Uint8Array(0);
      let previousLength = null;
      let lastPercent = -1;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      function finish() {
        if (!current) return;
        if (!current.length) throw new Error("Empty FASTA sequence.");
        entries.push(`${current.name}\t${current.length}\t${current.offset}\t${current.lineBases}\t${current.lineWidth}\n`);
      }
      function accept(bytes, width) {
        const line = decoder.decode(bytes);
        if (line.startsWith(">")) {
          finish();
          const name = line.slice(1).split(/\s+/)[0];
          if (!name) throw new Error("Missing FASTA sequence name.");
          current = { name, length: 0, offset: offset + width, lineBases: 0, lineWidth: 0 };
          previousLength = null;
        } else {
          if (!current || !/^[ACGTRYSWKMBDHVNacgtryswkmbdhvn]+$/.test(line)) throw new Error("Expected an uncompressed DNA FASTA with nonempty sequence lines.");
          if (previousLength !== null && previousLength !== current.lineBases) {
            throw new Error("FASTA has a short internal line; a standard .fai index cannot represent it.");
          }
          if (!current.lineBases) {
            current.lineBases = bytes.length;
            current.lineWidth = width;
          } else if (bytes.length > current.lineBases ||
              (bytes.length === current.lineBases && width !== current.lineWidth && offset + width < fasta.size)) {
            throw new Error("FASTA line wrapping/newlines are inconsistent.");
          }
          previousLength = bytes.length;
          current.length += bytes.length;
        }
        offset += width;
      }
      for await (const chunk of converter.streamChunks(fasta.stream())) {
        const bytes = new Uint8Array(pending.length + chunk.length);
        bytes.set(pending);
        bytes.set(chunk, pending.length);
        let start = 0;
        let end;
        while ((end = bytes.indexOf(10, start)) !== -1) {
          accept(bytes.subarray(start, end > start && bytes[end - 1] === 13 ? end - 1 : end), end - start + 1);
          start = end + 1;
        }
        pending = bytes.slice(start);
        if (pending.length > 4 * 1024 * 1024) throw new Error("FASTA line exceeds 4 MiB. Use a standard wrapped reference.");
        const percent = Math.floor(offset / fasta.size * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          onStatus(`Indexing reference FASTA locally: ${percent}%. This one-time scan can take several minutes.`);
        }
      }
      if (pending.length) accept(pending, pending.length);
      finish();
      if (!entries.length) throw new Error("No sequences found in the target reference FASTA.");
      return new Blob(entries, { type: "text/plain" });
    }

    async function readFai(index, fasta) {
      if (index.size > 16 * 1024 * 1024) throw new Error("FASTA index exceeds the 16 MiB safety limit.");
      const byChromosome = new Map();
      const seen = new Set();
      for (const line of (await index.text()).split(/\r?\n/)) {
        if (!line) continue;
        const fields = line.split("\t");
        if (fields.length !== 5 || seen.has(fields[0])) throw new Error("Invalid or duplicate FASTA index entry.");
        seen.add(fields[0]);
        const [length, offset, lineBases, lineWidth] = fields.slice(1).map(text => integer(text, "FASTA index number"));
        if (!length || !lineBases || lineWidth < lineBases || lineWidth > lineBases + 2) throw new Error("Invalid FASTA index line widths.");
        const lastByte = offset + Math.floor((length - 1) / lineBases) * lineWidth + (length - 1) % lineBases;
        if (!Number.isSafeInteger(lastByte) || lastByte >= fasta.size) throw new Error("FASTA index offsets exceed the selected FASTA. Select its matching .fai file.");
        const chr = canonical(fields[0]);
        if (chr) {
          if (byChromosome.has(chr)) throw new Error("Ambiguous chromosome names in FASTA index.");
          byChromosome.set(chr, { length, offset, lineBases, lineWidth });
        }
      }
      if (!byChromosome.size) throw new Error("No primary chromosomes in the target FASTA index.");
      return byChromosome;
    }

    async function decompressReference(file, handle, onStatus) {
      let writable;
      try {
        writable = await handle.createWritable();
      } catch (error) {
        throw new Error(`Cannot open temporary reference storage for writing: ${error.message}. Enable browser storage or extract the reference yourself and select the .fa file.`);
      }
      const buffer = new Uint8Array(1024 * 1024);
      let filled = 0;
      let written = 0;
      let lastReport = -1;
      try {
        for await (const chunk of converter.gzipChunks(file.stream())) {
          let start = 0;
          while (start < chunk.length) {
            const size = Math.min(buffer.length - filled, chunk.length - start);
            buffer.set(chunk.subarray(start, start + size), filled);
            start += size;
            filled += size;
            if (filled === buffer.length) {
              await writable.write(buffer);
              written += filled;
              filled = 0;
              const mib = Math.floor(written / buffer.length);
              if (mib - lastReport >= 8) {
                lastReport = mib;
                onStatus(`Decompressing target FASTA locally: ${mib} MiB written to temporary browser storage. Keep this tab open.`);
              }
            }
          }
        }
        if (filled) await writable.write(buffer.subarray(0, filled));
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch (abortError) {
          throw new Error(`Target FASTA decompression failed: ${error.message}. Temporary write abort also failed: ${abortError.message}.`);
        }
        throw new Error(`Target FASTA decompression failed: ${error.message}. If browser storage is full or unavailable, extract the reference yourself and select the .fa file.`);
      }
      const unpacked = await handle.getFile();
      const magic = new Uint8Array(await unpacked.slice(0, 1).arrayBuffer());
      if (magic[0] !== 62) throw new Error("Decompressed target reference is not a FASTA beginning with >.");
      return unpacked;
    }

    async function prepare({ chainFile, fastaFile, indexFile, temporaryName }, onStatus = () => {}, onIndex = () => {}) {
      if (!chainFile || !fastaFile) throw new Error("Select the hg38-to-hg19 chain and an hg19 FASTA (.fa or .fa.gz).");
      const magic = new Uint8Array(await fastaFile.slice(0, 2).arrayBuffer());
      const gzip = magic[0] === 31 && magic[1] === 139;
      if (/\.gz$/i.test(fastaFile.name) && !gzip) throw new Error("The selected target FASTA .gz file has no gzip header.");
      if (!gzip && magic[0] !== 62) throw new Error("Target reference must be a FASTA beginning with > or a gzip-compressed FASTA.");
      onStatus("Loading the GRCh38-to-hg19 chain locally...");
      const chains = await readChain(chainFile);
      if (gzip) {
        if (!/^sequenceconvert-reference-[a-f0-9-]{36}\.fa$/.test(temporaryName || "")) {
          throw new Error("A temporary reference storage name is required for compressed FASTA.");
        }
        if (typeof navigator === "undefined" || !navigator.storage ||
            typeof navigator.storage.getDirectory !== "function") {
          throw new Error("Compressed reference reading needs browser file storage. Use current Chrome/Edge with site storage enabled, or extract .fa.gz yourself and select the .fa file.");
        }
        onStatus("Preparing temporary browser storage for compressed FASTA. Several GB of free storage may be needed...");
        let handle;
        try {
          const directory = await navigator.storage.getDirectory();
          handle = await directory.getFileHandle(temporaryName);
        } catch (error) {
          throw new Error(`Cannot create temporary reference storage: ${error.message}. Enable browser storage or extract the reference yourself and select the .fa file.`);
        }
        fastaFile = await decompressReference(fastaFile, handle, onStatus);
      }
      if (!indexFile) {
        indexFile = await buildFai(fastaFile, onStatus);
        onIndex(indexFile);
      }
      const index = await readFai(indexFile, fastaFile);
      let cacheStart = -1;
      let cache = null;
      async function baseAt(chr, position, size) {
        const entry = index.get(chr);
        if (!entry || entry.length !== size) {
          throw new Error(`Target FASTA/index does not match the chain's chromosome ${chr} length (${size}). Use the matching UCSC hg19 reference; hg19 and some GRCh37 references differ at MT.`);
        }
        const zero = position - 1;
        const byteOffset = entry.offset + Math.floor(zero / entry.lineBases) * entry.lineWidth + zero % entry.lineBases;
        if (!cache || byteOffset < cacheStart || byteOffset >= cacheStart + cache.length) {
          cacheStart = Math.floor(byteOffset / 262144) * 262144;
          cache = new Uint8Array(await fastaFile.slice(cacheStart, cacheStart + 262144).arrayBuffer());
        }
        const byte = cache[byteOffset - cacheStart];
        if (byte === undefined) throw new Error("Unexpected end of target reference FASTA.");
        const base = String.fromCharCode(byte).toUpperCase();
        if (!/^[ACGTRYSWKMBDHVN]$/.test(base)) throw new Error("FASTA index points to non-sequence data. Select the correct .fai file.");
        return base;
      }
      return {
        async map(chr, position, ref) {
          const blocks = chains.get(chr);
          if (!blocks) return { reason: "unmapped" };
          const zero = position - 1;
          let lo = 0;
          let hi = blocks.length;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (blocks[mid].start <= zero) lo = mid + 1;
            else hi = mid;
          }
          let match = null;
          for (let i = lo - 1; i >= 0 && blocks[i].maxEnd > zero; i--) {
            if (blocks[i].end <= zero) continue;
            if (match) return { reason: "ambiguousMapping" };
            match = blocks[i];
          }
          if (!match || !match.destination) return { reason: "unmapped" };
          // Cross-chromosome placements are excluded rather than changing ploidy/PAR semantics.
          if (match.destination !== chr) return { reason: "crossChromosome" };
          const q = match.q + zero - match.start;
          const targetPosition = match.reverse ? match.qSize - q : q + 1;
          const targetRef = match.reverse ? complement[ref] : ref;
          if (await baseAt(match.destination, targetPosition, match.qSize) !== targetRef) return { reason: "referenceMismatch" };
          return { chromosome: match.destination, position: targetPosition, reverse: match.reverse };
        }
      };
    }
    return { prepare, readChain, buildFai, readFai, decompressReference };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = createLiftover;
  else root.createLiftover = createLiftover;
})(typeof globalThis !== "undefined" ? globalThis : this);
