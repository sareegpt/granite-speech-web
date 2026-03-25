const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const recordBtn = document.getElementById("record-btn");
const outputWrap = document.getElementById("output-wrap");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");
const exportBtn = document.getElementById("export-btn");
const clearBtn = document.getElementById("clear-btn");
const outputLangSelect = document.getElementById("output-lang");
const keywordsInput = document.getElementById("keywords");
const continuousToggle = document.getElementById("continuous-toggle");
const reviewPanel = document.getElementById("review-panel");
const reviewDetected = document.getElementById("review-detected");
const reviewTranslated = document.getElementById("review-translated");
const translationLabel = document.getElementById("translation-label");
const retranslateBtn = document.getElementById("retranslate-btn");
const acceptBtn = document.getElementById("accept-btn");
const discardBtn = document.getElementById("discard-btn");

let continuousMode = false;
let continuousRunning = false;
let isRecording = false;
let modelReady = false;
let lastAudio = null; // keep audio for re-translate

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const fileProgress = {};

worker.addEventListener("message", (e) => {
  const { type } = e.data;

  if (type === "status") statusEl.textContent = e.data.message;

  if (type === "progress") {
    progressWrap.hidden = false;
    const { file, loaded, total } = e.data;
    fileProgress[file] = { loaded, total };
    const totalLoaded = Object.values(fileProgress).reduce((s, f) => s + f.loaded, 0);
    const totalSize = Object.values(fileProgress).reduce((s, f) => s + f.total, 0);
    const pct = totalSize > 0 ? (totalLoaded / totalSize) * 100 : 0;
    progressBar.style.width = `${pct.toFixed(1)}%`;
    progressText.textContent = `${(totalLoaded / 1e6).toFixed(0)} / ${(totalSize / 1e6).toFixed(0)} MB`;
  }

  if (type === "ready") {
    progressWrap.hidden = true;
    modelReady = true;
    updateRecordButton();
  }

  if (type === "phase") {
    const el = e.data.phase === "detected" ? reviewDetected : reviewTranslated;
    el.classList.add("streaming");
  }

  if (type === "token") {
    const el = e.data.phase === "detected" ? reviewDetected : reviewTranslated;
    el.value += e.data.token;
    el.scrollTop = el.scrollHeight;
  }

  if (type === "phase-done") {
    const el = e.data.phase === "detected" ? reviewDetected : reviewTranslated;
    el.classList.remove("streaming");
  }

  if (type === "done") {
    if (e.data.isTranslation) {
      // Show review panel, let user edit both
      reviewPanel.hidden = false;
      retranslateBtn.hidden = false;
      acceptBtn.disabled = false;
      statusEl.textContent = "Review and edit, then Accept or Discard";
      updateRecordButton();
    } else {
      // Transcribe-only: straight to output
      outputWrap.hidden = false;
      outputEl.value += (outputEl.value ? "\n" : "") + reviewDetected.value;
      reviewDetected.value = "";
      reviewPanel.hidden = true;
      if (continuousMode && continuousRunning) {
        startRecording();
      } else {
        continuousRunning = false;
        updateRecordButton();
      }
    }
  }

  if (type === "error") {
    statusEl.textContent = `Error: ${e.data.message}`;
    updateRecordButton();
  }
});

worker.postMessage({ type: "load" });

function updateRecordButton() {
  if (!modelReady) {
    recordBtn.disabled = true;
    recordBtn.textContent = "Loading…";
    return;
  }
  recordBtn.disabled = false;
  if (continuousMode) {
    recordBtn.textContent = continuousRunning ? (isRecording ? "Recording…" : "Transcribing…") : "Start";
    recordBtn.classList.toggle("continuous", true);
  } else {
    recordBtn.textContent = "Hold to Record";
    recordBtn.classList.toggle("continuous", false);
  }
  statusEl.textContent = "Ready";
}

// --- Audio recording ---
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let audioChunks = [];

async function startRecording() {
  audioChunks = [];
  isRecording = true;
  recordBtn.classList.add("recording");
  recordBtn.textContent = "Recording…";
  statusEl.textContent = "Listening…";

  // Clear review fields for new recording
  reviewDetected.value = "";
  reviewTranslated.value = "";

  const isTranslation = outputLangSelect.value !== "transcribe";
  if (isTranslation) {
    reviewPanel.hidden = false;
    retranslateBtn.hidden = true;
    acceptBtn.disabled = true;
    translationLabel.textContent = `Translation (${outputLangSelect.options[outputLangSelect.selectedIndex].text})`;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  audioContext = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  processorNode.onaudioprocess = (e) => {
    if (!isRecording) return;
    audioChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function stopRecording() {
  isRecording = false;
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "Transcribing…";
  recordBtn.disabled = !continuousMode;

  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }

  const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
  const audio = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) { audio.set(chunk, offset); offset += chunk.length; }
  audioChunks = [];

  if (totalLength === 0) {
    statusEl.textContent = "No audio captured. Try again.";
    updateRecordButton();
    return;
  }

  // Keep a copy for re-translate
  lastAudio = audio.slice();

  statusEl.textContent = `Transcribing ${(totalLength / 16000).toFixed(1)}s of audio…`;
  worker.postMessage(
    { type: "transcribe", audio, outputLang: outputLangSelect.value, keywords: keywordsInput.value },
    [audio.buffer]
  );
}

// --- Hold to record (non-continuous) ---
recordBtn.addEventListener("mousedown", (e) => { if (!recordBtn.disabled && !continuousMode) { e.preventDefault(); startRecording(); } });
recordBtn.addEventListener("mouseup", () => { if (!continuousMode && isRecording) stopRecording(); });
recordBtn.addEventListener("mouseleave", () => { if (!continuousMode && isRecording) stopRecording(); });
recordBtn.addEventListener("touchstart", (e) => { if (!recordBtn.disabled && !continuousMode) { e.preventDefault(); startRecording(); } });
recordBtn.addEventListener("touchend", (e) => { e.preventDefault(); if (!continuousMode && isRecording) stopRecording(); });

// --- Continuous mode click ---
recordBtn.addEventListener("click", () => {
  if (!continuousMode || recordBtn.disabled) return;
  if (continuousRunning) {
    continuousRunning = false;
    if (isRecording) stopRecording();
    recordBtn.textContent = "Start";
  } else {
    continuousRunning = true;
    startRecording();
  }
});

// --- Continuous toggle ---
continuousToggle.addEventListener("click", () => {
  continuousMode = !continuousMode;
  continuousToggle.textContent = continuousMode ? "On" : "Off";
  continuousToggle.classList.toggle("active", continuousMode);
  if (isRecording) stopRecording();
  updateRecordButton();
});

// --- Review panel actions ---
acceptBtn.addEventListener("click", () => {
  outputWrap.hidden = false;
  const detected = reviewDetected.value.trim();
  const translated = reviewTranslated.value.trim();
  const entry = `[Detected] ${detected}\n[Translated] ${translated}`;
  outputEl.value += (outputEl.value ? "\n\n" : "") + entry;
  outputEl.scrollTop = outputEl.scrollHeight;

  reviewPanel.hidden = true;
  reviewDetected.value = "";
  reviewTranslated.value = "";
  lastAudio = null;

  if (continuousMode && continuousRunning) {
    startRecording();
  } else {
    continuousRunning = false;
    updateRecordButton();
  }
});

discardBtn.addEventListener("click", () => {
  reviewPanel.hidden = true;
  reviewDetected.value = "";
  reviewTranslated.value = "";
  lastAudio = null;
  updateRecordButton();
});

retranslateBtn.addEventListener("click", () => {
  if (!lastAudio) return;
  reviewTranslated.value = "";
  const audio = lastAudio.slice();
  worker.postMessage(
    { type: "transcribe", audio, outputLang: outputLangSelect.value, keywords: keywordsInput.value },
    [audio.buffer]
  );
});

// --- Copy / Export / Clear ---
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputEl.value).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  });
});

exportBtn.addEventListener("click", () => {
  const text = outputEl.value;
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript-${new Date().toISOString().slice(0, 16)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

clearBtn.addEventListener("click", () => {
  outputEl.value = "";
  outputWrap.hidden = true;
});
