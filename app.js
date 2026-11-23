(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([
    "file-input", "drop-zone", "file-label", "sv-warning", "header-status", "sample",
    "build", "confirm", "reference-hint", "convert", "cancel", "status", "progress",
    "error", "results", "summary", "counts", "download", "liftover-options",
    "chain-file", "fasta-file", "fai-file", "save-index", "storage-warning", "retry-cleanup"
  ].map(id => [id, $(id)]));
  let file = null;
  let header = null;
  let worker = null;
  let workerUrl = null;
  let outputUrl = null;
  let busy = false;
  let generatedIndex = null;
  let indexUrl = null;
  let temporaryName = null;
  const pendingCleanup = new Set();

  async function removeTemporaryReference(name) {
    try {
      const directory = await navigator.storage.getDirectory();
      // Worker termination may take a moment to release its writable file.
      for (let attempt = 0; ; attempt++) {
        try {
          await directory.removeEntry(name);
          break;
        } catch (error) {
          if (error.name === "NotFoundError") break;
          if (!["InvalidStateError", "NoModificationAllowedError"].includes(error.name) || attempt >= 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      pendingCleanup.delete(name);
      ui["storage-warning"].hidden = pendingCleanup.size === 0;
      ui["retry-cleanup"].hidden = pendingCleanup.size === 0;
    } catch (error) {
      ui["storage-warning"].textContent = `Temporary public reference storage could not be removed: ${error.message}. Use Retry cleanup, or clear this page's browser site storage after closing other converter tabs.`;
      ui["storage-warning"].hidden = false;
      ui["retry-cleanup"].hidden = false;
    }
  }

  function workerMain(createConverter, createLiftover) {
    const converter = createConverter();
    self.onmessage = async ({ data }) => {
      try {
        const magic = new Uint8Array(await data.file.slice(0, 2).arrayBuffer());
        const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
        if (/\.gz$/i.test(data.file.name) && !gzip) throw new Error("This .gz file does not have a gzip header.");
        const stream = data.file.stream();
        const chunks = gzip ? converter.gzipChunks(stream) : converter.streamChunks(stream);
        if (data.mode === "inspect") {
          self.postMessage({ type: "header", header: await converter.inspect(chunks) });
        } else {
          if (data.options.build === "38") {
            data.options.mapper = await createLiftover(converter).prepare(
              data.references,
              message => self.postMessage({ type: "reference-status", message }),
              blob => self.postMessage({ type: "reference-index", blob })
            );
            self.postMessage({ type: "reference-status", message: "Reference ready. Streaming SNP calls and checking mapped target bases locally..." });
          }
          const result = await converter.convert(chunks, data.options, counts => {
            self.postMessage({ type: "progress", counts });
          });
          const blob = new Blob(result.parts, { type: "text/plain;charset=utf-8" });
          self.postMessage({ type: "result", blob, counts: result.counts });
        }
      } catch (error) {
        self.postMessage({ type: "error", message: error.message || "Conversion failed. No output was saved." });
      }
    };
  }

  function stopWorker() {
    if (worker) worker.terminate();
    if (temporaryName) {
      const name = temporaryName;
      temporaryName = null;
      pendingCleanup.add(name);
      void removeTemporaryReference(name);
    }
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    worker = null;
    workerUrl = null;
    busy = false;
    ui.cancel.disabled = true;
    ui.progress.hidden = true;
    ui.sample.disabled = !header;
    ui.build.disabled = false;
    ui.confirm.disabled = false;
    for (const id of ["chain-file", "fasta-file", "fai-file"]) ui[id].disabled = false;
    updateReady();
  }

  function clearOutput() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
    ui.download.removeAttribute("href");
    ui.results.hidden = true;
    ui.error.hidden = true;
    ui.error.textContent = "";
  }

  function showError(message) {
    stopWorker();
    clearOutput();
    ui.error.textContent = message;
    ui.error.hidden = false;
    ui.status.textContent = "Stopped. No output is available.";
  }

  function updateReady() {
    const build = ui.build.value;
    ui["liftover-options"].hidden = build !== "38";
    ui.convert.disabled = busy || !header || ui.sample.value === "" ||
      !["37", "38"].includes(build) || !ui.confirm.checked ||
      header.builds.some(value => value !== build) ||
      (build === "38" && (!ui["chain-file"].files.length || !ui["fasta-file"].files.length));
  }

  async function launch(mode) {
    busy = true;
    ui.cancel.disabled = false;
    ui.sample.disabled = true;
    ui.build.disabled = true;
    ui.confirm.disabled = true;
    for (const id of ["chain-file", "fasta-file", "fai-file"]) ui[id].disabled = true;
    updateReady();
    let activeWorker = null;
    try {
      workerUrl = URL.createObjectURL(new Blob(
        [`(${workerMain.toString()})(${window.createConverter.toString()}, ${window.createLiftover.toString()});`],
        { type: "text/javascript" }
      ));
      worker = new Worker(workerUrl);
      activeWorker = worker;
      worker.onerror = event => {
        event.preventDefault();
        showError("The local processing worker failed. Open this folder's index.html in an up-to-date Chrome or Edge. No file was uploaded.");
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "error") {
          if (mode === "inspect") ui["header-status"].textContent = `Header check failed: ${data.message}`;
          showError(data.message);
        } else if (data.type === "header") {
          header = data.header;
          ui.sample.replaceChildren();
          if (header.samples.length > 1) ui.sample.add(new Option("Choose a sample", ""));
          header.samples.forEach((name, i) => ui.sample.add(new Option(name, String(i))));
          const detected = header.builds;
          ui["reference-hint"].textContent = detected.length
            ? `Header build hint: ${detected.map(build => build === "other" ? "unsupported older build" : `GRCh${build}`).join(", ")}. Confirm with your provider.`
            : "No recognized build in the header. Check your provider's documentation; do not guess.";
          ui["header-status"].textContent = `Header read locally. ${header.samples.length} sample(s) found.`;
          stopWorker();
          if (detected.includes("other") || detected.length > 1) {
            showError("The header indicates an unsupported or conflicting build. Obtain a VCF with one consistent GRCh37 or GRCh38 reference.");
          } else {
            if (detected.length === 1) ui.build.value = detected[0];
            updateReady();
            ui.status.textContent = detected[0] === "38"
              ? "GRCh38 detected. Select the local chain and target hg19 FASTA below, then confirm the source build."
              : "Choose the sample and confirm the source build to continue.";
          }
        } else if (data.type === "reference-status") {
          ui.status.textContent = data.message;
        } else if (data.type === "reference-index") {
          if (indexUrl) URL.revokeObjectURL(indexUrl);
          generatedIndex = new File([data.blob], "hg19.fa.fai", { type: "text/plain" });
          indexUrl = URL.createObjectURL(generatedIndex);
          ui["save-index"].href = indexUrl;
          ui["save-index"].hidden = false;
        } else if (data.type === "progress") {
          ui.status.textContent = `${data.counts.records.toLocaleString()} records examined; ${data.counts.exported.toLocaleString()} SNPs retained.`;
        } else if (data.type === "result") {
          stopWorker();
          outputUrl = URL.createObjectURL(data.blob);
          ui.download.href = outputUrl;
          ui.summary.textContent = `${data.counts.exported.toLocaleString()} SNP genotypes exported from ${data.counts.records.toLocaleString()} records.`;
          const labels = {
            nonPrimary: "Non-primary contigs skipped", nonSnp: "Non-SNP / structural records skipped",
            filtered: "Failed FILTER records skipped", noRsid: "Records without an rsID skipped",
            missingCall: "Missing / uncallable genotypes skipped", unsupportedPloidy: "Unsupported ploidy skipped",
            duplicates: "Identical duplicate calls skipped before any conflict",
            conflictingRsids: "rsIDs excluded entirely due to conflicting calls or positions",
            lifted: "Exported SNPs lifted from GRCh38 to hg19",
            unmapped: "Sites without a primary target mapping skipped",
            ambiguousMapping: "Ambiguous chain mappings skipped",
            referenceMismatch: "Target reference-base mismatches skipped",
            crossChromosome: "Cross-chromosome mappings skipped",
            mitochondrialSkipped: "MT sites excluded from hg38-to-hg19 liftover"
          };
          ui.counts.replaceChildren();
          for (const [key, label] of Object.entries(labels)) {
            const term = document.createElement("dt");
            const value = document.createElement("dd");
            term.textContent = label;
            value.textContent = data.counts[key].toLocaleString();
            ui.counts.append(term, value);
          }
          ui.results.hidden = false;
          ui.status.textContent = "Conversion finished locally. Review the counts and limitations before saving.";
        }
      };
      if (mode === "convert" && ui.build.value === "38") {
        const reference = ui["fasta-file"].files[0];
        const magic = new Uint8Array(await reference.slice(0, 2).arrayBuffer());
        if (worker !== activeWorker) return;
        if (magic[0] === 31 && magic[1] === 139) {
          ui.status.textContent = "Checking temporary reference storage access...";
          let directory;
          try {
            directory = await navigator.storage.getDirectory();
          } catch (error) {
            throw new Error(`Cannot access temporary reference storage: ${error.message}. ${
              location.protocol === "file:"
                ? "Close this file tab, double-click Start-SequenceConvert.cmd in the application folder, and use http://127.0.0.1:8765 in Chrome or Edge."
                : "Allow site storage in Chrome or Edge (not a restricted preview/private session), or extract hg19.fa.gz yourself and select hg19.fa."
            } No temporary reference file was created.`);
          }
          if (worker !== activeWorker) return;
          const name = `sequenceconvert-reference-${crypto.randomUUID()}.fa`;
          try {
            await directory.getFileHandle(name, { create: true });
          } catch (error) {
            throw new Error(`Cannot create temporary reference storage: ${error.message}. Use Start-SequenceConvert.cmd with Chrome or Edge and allow site storage, or select an extracted hg19.fa. No temporary reference file was created.`);
          }
          if (worker !== activeWorker) {
            pendingCleanup.add(name);
            void removeTemporaryReference(name);
            return;
          }
          temporaryName = name;
        }
      }
      activeWorker.postMessage({
        mode, file, options: { build: ui.build.value, sampleIndex: Number(ui.sample.value) },
        references: {
          chainFile: ui["chain-file"].files[0],
          fastaFile: ui["fasta-file"].files[0],
          indexFile: ui["fai-file"].files[0] || generatedIndex,
          temporaryName
        }
      });
    } catch (error) {
      if (!activeWorker || worker === activeWorker) showError(`Could not start local processing: ${error.message}`);
    }
  }

  function selectFile(selected) {
    stopWorker();
    clearOutput();
    header = null;
    file = selected;
    ui.confirm.checked = false;
    ui.build.value = "";
    ui.sample.replaceChildren(new Option("Select a file first", ""));
    ui.sample.disabled = true;
    ui["header-status"].textContent = "";
    ui["reference-hint"].textContent = "The header will be checked locally for reference-build hints.";
    ui["sv-warning"].hidden = true;
    updateReady();
    ui["file-label"].textContent = file ? file.name : "No file selected.";
    if (!file) return;
    if (!/\.vcf(?:\.gz)?$/i.test(file.name)) {
      showError("Choose a .vcf or .vcf.gz file. Other genomic formats are not supported.");
      return;
    }
    if (!file.size) { showError("The selected file is empty."); return; }
    ui["sv-warning"].hidden = !/\.sv\.vcf(?:\.gz)?$/i.test(file.name);
    ui["header-status"].textContent = "Reading only the header locally...";
    ui.status.textContent = "Checking the VCF header. No network connection is used.";
    launch("inspect");
  }

  ui["file-input"].addEventListener("change", event => selectFile(event.target.files[0]));
  for (const name of ["dragenter", "dragover"]) {
    ui["drop-zone"].addEventListener(name, event => {
      event.preventDefault();
      ui["drop-zone"].classList.add("dragging");
    });
  }
  ui["drop-zone"].addEventListener("dragleave", () => ui["drop-zone"].classList.remove("dragging"));
  ui["drop-zone"].addEventListener("drop", event => {
    event.preventDefault();
    ui["drop-zone"].classList.remove("dragging");
    if (event.dataTransfer.files.length !== 1) { showError("Drop exactly one VCF file at a time."); return; }
    selectFile(event.dataTransfer.files[0]);
  });
  // Prevent a missed drop from navigating away and opening a private file in the tab.
  window.addEventListener("dragover", event => event.preventDefault());
  window.addEventListener("drop", event => event.preventDefault());
  for (const element of [ui.sample, ui.build, ui.confirm, ui["chain-file"], ui["fasta-file"], ui["fai-file"]]) {
    element.addEventListener("change", () => {
      if (element === ui.build) ui.confirm.checked = false;
      if (element === ui["fasta-file"]) {
        generatedIndex = null;
        ui["fai-file"].value = "";
        if (indexUrl) URL.revokeObjectURL(indexUrl);
        indexUrl = null;
        ui["save-index"].hidden = true;
        ui["save-index"].removeAttribute("href");
      }
      clearOutput();
      updateReady();
    });
  }
  ui.convert.addEventListener("click", () => {
    if (ui.convert.disabled) return;
    clearOutput();
    ui.status.textContent = "Streaming VCF records locally. Large WGS files can take several minutes.";
    ui.progress.hidden = false;
    ui.progress.removeAttribute("value");
    launch("convert");
  });
  ui.cancel.addEventListener("click", () => {
    const wasInspecting = !header;
    stopWorker();
    clearOutput();
    if (wasInspecting) ui["header-status"].textContent = "Header check cancelled. Reselect or drop the file again to retry.";
    ui.status.textContent = "Cancelled. No output was saved.";
  });
  ui["retry-cleanup"].addEventListener("click", () => {
    for (const name of pendingCleanup) void removeTemporaryReference(name);
  });
  window.addEventListener("pagehide", () => {
    stopWorker();
    clearOutput();
    if (indexUrl) URL.revokeObjectURL(indexUrl);
    indexUrl = null;
    generatedIndex = null;
    ui["save-index"].hidden = true;
    ui["save-index"].removeAttribute("href");
  });
})();
