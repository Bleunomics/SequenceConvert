# SequenceConvert

**Recommended on Windows:** double-click `Start-SequenceConvert.cmd`, then use
**http://127.0.0.1:8765** in current Chrome or Edge. Keep the launcher window open;
Ctrl+C stops the local server. Node.js 22+ is required; no packages are needed.
Alternatively run `node server.js` and open that URL manually.

Opening `index.html` directly still works for uncompressed target references,
but some browsers block temporary reference storage on `file:` pages and in
restricted browser previews. Use the launcher for `.fa.gz` target references.
Allow browser site storage and several GB of free space.

The server binds only to loopback and serves an explicit list of application
assets. It does not expose a directory listing, genomic files, reference files,
or upload endpoints. Chosen data is processed in the browser, never sent to the
local server. Do not expose this port through a tunnel or port-forward.
Drag in a `.vcf` or `.vcf.gz`, select the sample, confirm the actual **human
GRCh37/hg19 or GRCh38/hg38** source build, convert, then save the text file.
GRCh38 requires the additional local reference files below.
A multi-sample VCF requires an explicit sample choice.
The source file is never modified. The application does not send files, genotypes,
or filenames over the network, and uses no external scripts, fonts, or analytics.
All dependencies are browser built-ins.

## Important: structural variants are not ancestry SNPs

An `.sv.vcf.gz` filename normally indicates a **structural-variant VCF**. Such a
file alone generally cannot produce a useful ancestry upload. Request your
provider's **SNP/small-variant VCF, annotated with dbSNP rsIDs, using human
GRCh37/hg19 forward-reference coordinates**. The app does not download annotation
databases or transmit your DNA to annotation services.

The output is **23andMe-style**, not an official 23andMe test or a recreation of
its SNP chip. No acceptance or useful result from ExploreYourDNA, Ararat, or any
other service is guaranteed. Check the destination's accepted build, marker
coverage, minimum count, and privacy terms independently. Never upload another
person's genetic data without their permission.

## Local GRCh38-to-hg19 conversion

Select **GRCh38 / hg38**, then supply:

1. The [UCSC hg38-to-hg19 chain](https://hgdownload.soe.ucsc.edu/goldenPath/hg38/liftOver/hg38ToHg19.over.chain.gz)
   (`.chain.gz` or decompressed `.chain`). Check the
   [UCSC chain licensing terms](https://hgdownload.soe.ucsc.edu/goldenPath/hg38/liftOver/)
   before downloading or using it. The app does not bundle or redistribute chains.
2. The [UCSC hg19 reference FASTA](https://hgdownload.soe.ucsc.edu/goldenPath/hg19/bigZips/hg19.fa.gz).
   Select **`hg19.fa.gz` directly**, or an already extracted `hg19.fa`.
   Ordinary gzip and BGZF-compressed references are supported. Compressed
   references are streamed to a temporary file in the browser's origin-private
   file system (OPFS), then read using the same indexed access as plain FASTA.
   The full reference is never held in JavaScript memory. Allow several GB
   of free browser storage. Current Chrome/Edge with site storage enabled is
   recommended. If storage is blocked or full, extraction with an archive
   utility such as 7-Zip followed by selecting `hg19.fa` remains supported.
3. Optionally, its matching `.fai` FASTA index. If omitted, the app streams the
   reference once to create an index locally and offers it for download/reuse.
   The initial scan may take several minutes. Only fixed-width wrapped FASTA
   is supported by the automatic indexer. A standard `samtools faidx hg19.fa`
   index is also accepted. For `.fa.gz` inputs, the index must describe the exact
   **decompressed FASTA bytes**, not compressed offsets; no `.gzi` is needed.

Each conversion decompresses the selected compressed reference again. Temporary
public reference files are removed after success, errors or cancellation; a
visible warning and retry button are shown if cleanup fails. No genomic input
or exported genotypes are written to OPFS. Closing the page attempts cleanup,
but an abrupt shutdown can leave a temporary reference behind. Clear this
page's browser site storage to reclaim it after closing other converter tabs.

The app never downloads references itself or sends DNA to a liftover service.
Reference links are ordinary external downloads opened only when clicked.
After indexing, small FASTA regions are read on demand with a bounded cache;
the reference is not loaded entirely into memory. The chain block index is
kept in memory (up to five million blocks).

Chain parsing follows the [UCSC chain specification](https://genome.ucsc.edu/goldenPath/help/chain.html).
For this direction, chain **t** coordinates are the GRCh38 input, and **q**
coordinates are the hg19 output. Recognized primary chromosome lengths must
match that direction. Only uniquely aligned bases are used. Query-strand
negative mappings reverse coordinates and complement both genotype alleles.
The transformed source REF must match the target FASTA base exactly.
Reference switches/REF mismatches are **skipped**, not rescued by allele swapping.

Unmapped sites, ambiguous placements (including overlapping chains),
cross-chromosome mappings, and target REF mismatches are skipped and counted.
MT is excluded from this liftover mode: UCSC hg19's original chrM is not the
GRCh37/rCRS mitochondrial reference used by consumer raw tests. This avoids
mislabeling mitochondrial coordinates. Indels, gVCF reference blocks, missing
rsIDs and absent SNP-chip positions are not filled in.

This is a conservative **SNP-only** conversion, not a general VCF liftover
replacement or validation of a consumer SNP panel. User-selected reference
files must be authentic, unmodified and mutually matching. Chromosome-length
checks and local REF checks do not certify every aspect of an assembly.

## Export rules and limitations

- Four tab-separated columns: `rsid`, `chromosome`, `position`, `genotype`, with
  `#` comment headers. Primary chromosomes use `1`-`22`, `X`, `Y`, and `MT`.
  Rows retain source order; the app does not synthesize a sorted chip panel.
- Only explicit, fully called A/C/G/T SNP genotypes with an `rs` identifier are
  exported. REF and ALT are assumed to use the VCF forward reference strand.
  All allele indices, including multiallelic and phased calls, are decoded.
  Phasing is discarded and diploid alleles are alphabetized.
- Haploid calls are retained as a single base on X, Y, and MT, never artificially
  doubled. Haploid autosomes and calls with more than two alleles are skipped.
  No sex inference or pseudoautosomal-region normalization is performed.
- `PASS` and `.` FILTER values are accepted (`.` means filters were not applied,
  **not** that quality is validated). Other FILTER values are skipped. No
  additional depth, genotype quality, allele balance, or variant quality cutoff
  is applied. These should be handled in an appropriate upstream QC workflow.
- Indels, structural variants, breakends, non-primary contigs, missing or partial
  calls, and records without rsIDs are skipped and counted.
- gVCF symbolic alleles `<NON_REF>` and `<*>` are allowed only as unused allele
  placeholders. A genotype selecting one is skipped. Reference blocks are not
  expanded; unlisted sites are never assumed to be homozygous reference.
  Explicit `0/0` SNP-site calls can be exported if the record has an rsID.
- Identical duplicate rsID calls are counted once. If eligible calls disagree
  on genotype or coordinates for an rsID, **all calls for that rsID are
  excluded** and conversion continues. Later calls never restore it.
  The results and output header report the number of conflicting rsIDs removed;
  no call is chosen by order, majority, or quality. Duplicate checks compare
  final output coordinates/genotypes, after liftover when enabled. Records
  already rejected by other filters do not participate. If conflicts leave
  no usable calls, conversion reports an error instead of offering an empty file.
- Source-build selection must agree with recognized reference/contig header
  hints. Conflicting or unsupported older build hints block conversion.
  GRCh38 requires the local liftover inputs above; GRCh37 retains original
  coordinates. Missing or unrecognized hints require explicit source-build
  confirmation. Header detection is a hint, not reference verification.
- No-output cases, invalid headers, corrupt gzip, malformed records, and invalid
  allele indices are reported as errors. No partial download is offered.

The VCF is streamed in a local background worker, including ordinary gzip and
BGZF (blocked gzip, commonly used for genomic `.vcf.gz` files) decompression.
BGZF members are decoded separately because browser gzip decoders may otherwise
report "Junk found after end of compressed data." Invalid block sizes, truncated
blocks, and gzip checksum errors stop conversion; they are not ignored.
Output text and an rsID duplicate map remain in memory until completion.
Extremely large exports can exceed browser memory; this is not a disk-backed
whole-genome pipeline. There are safety limits of 8 MiB per header and 4 MiB per
record. Cancel terminates the worker and discards any pending output. Saved
downloads remain on disk until you remove them yourself.

## Development

There are no packages to install. Run synthetic parser tests with Node 22+:

```text
node --test converter.test.js liftover.test.js server.test.js
```

Tests generate fictional records in memory; no user genomic files are accessed.
