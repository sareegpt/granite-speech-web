const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progress-wrap");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const recordBtn = document.getElementById("record-btn");
const outputWrap = document.getElementById("output-wrap");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");

// --- Worker setup ---
const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

const fileProgress = {};

worker.addEventListener("message", (e) => {
  const { type } = e.data;

  if (type === "status") {
    statusEl.textContent = e.data.message;
  }

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

  if (type === "progress-done") {
    // individual file done
  }

  if (type === "ready") {
    progressWrap.hidden = true;
    statusEl.textContent = "Ready — hold button to record";
    recordBtn.disabled = false;
  }

  if (type === "result") {
    outputWrap.hidden = false;
    outputEl.value += (outputEl.value ? "\n" : "") + e.data.text;
    statusEl.textContent = "Ready — hold button to record";
    recordBtn.disabled = false;
    recordBtn.textContent = "Hold to Record";
  }

  if (type === "error") {
    statusEl.textContent = `Error: ${e.data.message}`;
    recordBtn.disabled = false;
    recordBtn.textContent = "Hold to Record";
  }
});

// Load model
worker.postMessage({ type: "load" });

// --- Audio recording ---
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let audioChunks = [];
let isRecording = false;

async function startRecording() {
  audioChunks = [];
  isRecording = true;
  recordBtn.classList.add("recording");
  recordBtn.textContent = "Recording…";

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
    },
  });

  audioContext = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Use ScriptProcessor to capture raw PCM (AudioWorklet would be better but more setup)
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  processorNode.onaudioprocess = (e) => {
    if (!isRecording) return;
    const data = e.inputBuffer.getChannelData(0);
    audioChunks.push(new Float32Array(data));
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function stopRecording() {
  isRecording = false;
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "Transcribing…";
  recordBtn.disabled = true;

  // Cleanup audio
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  // Combine chunks into single Float32Array
  const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
  const audio = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  audioChunks = [];

  if (totalLength === 0) {
    statusEl.textContent = "No audio captured. Try again.";
    recordBtn.disabled = false;
    recordBtn.textContent = "Hold to Record";
    return;
  }

  statusEl.textContent = `Transcribing ${(totalLength / 16000).toFixed(1)}s of audio…`;
  worker.postMessage({ type: "transcribe", audio }, [audio.buffer]);
}

// --- Button events (hold to record) ---
recordBtn.addEventListener("mousedown", (e) => {
  if (recordBtn.disabled) return;
  e.preventDefault();
  startRecording();
});
recordBtn.addEventListener("mouseup", () => {
  if (isRecording) stopRecording();
});
recordBtn.addEventListener("mouseleave", () => {
  if (isRecording) stopRecording();
});

// Touch support
recordBtn.addEventListener("touchstart", (e) => {
  if (recordBtn.disabled) return;
  e.preventDefault();
  startRecording();
});
recordBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  if (isRecording) stopRecording();
});

// --- Copy button ---
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputEl.value).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  });
});
