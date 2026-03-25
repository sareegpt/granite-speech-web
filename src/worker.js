import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

let transcriber = null;

self.addEventListener("message", async (e) => {
  const { type, audio } = e.data;

  if (type === "load") {
    try {
      self.postMessage({ type: "status", message: "Downloading model…" });
      transcriber = await pipeline(
        "automatic-speech-recognition",
        "onnx-community/granite-4.0-1b-speech-ONNX",
        {
          dtype: "q4",
          device: "webgpu",
          progress_callback: (progress) => {
            if (progress.status === "progress") {
              self.postMessage({
                type: "progress",
                file: progress.file,
                loaded: progress.loaded,
                total: progress.total,
              });
            } else if (progress.status === "done") {
              self.postMessage({ type: "progress-done", file: progress.file });
            }
          },
        }
      );
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  if (type === "transcribe") {
    if (!transcriber) {
      self.postMessage({ type: "error", message: "Model not loaded" });
      return;
    }
    try {
      self.postMessage({ type: "status", message: "Transcribing…" });
      const result = await transcriber(audio, {
        language: "en",
        return_timestamps: false,
      });
      self.postMessage({ type: "result", text: result.text });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  }
});
