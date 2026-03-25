import {
  GraniteSpeechForConditionalGeneration,
  AutoProcessor,
  TextStreamer,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/granite-4.0-1b-speech-ONNX";

const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French",
  de: "German", pt: "Portuguese", ja: "Japanese",
};

let model = null;
let processor = null;

async function runInference(audio, prompt, tokenCallback) {
  const messages = [{ role: "user", content: `<|audio|>${prompt}` }];
  const text = processor.tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  });
  const inputs = await processor(text, audio);
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: tokenCallback,
  });
  await model.generate({
    ...inputs,
    max_new_tokens: 256,
    streamer,
    repetition_penalty: 1.2,
    no_repeat_ngram_size: 4,
  });
}

self.addEventListener("message", async (e) => {
  const { type, audio, outputLang, keywords } = e.data;

  if (type === "load") {
    try {
      self.postMessage({ type: "status", message: "Downloading model…" });
      const progressCallback = (progress) => {
        if (progress.status === "progress") {
          self.postMessage({ type: "progress", file: progress.file, loaded: progress.loaded, total: progress.total });
        }
      };
      const [m, p] = await Promise.all([
        GraniteSpeechForConditionalGeneration.from_pretrained(MODEL_ID, {
          dtype: { audio_encoder: "q4f16", embed_tokens: "q4f16", decoder_model_merged: "q4f16" },
          device: "webgpu",
          progress_callback: progressCallback,
        }),
        AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progressCallback }),
      ]);
      model = m;
      processor = p;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  if (type === "transcribe") {
    if (!model || !processor) return self.postMessage({ type: "error", message: "Model not loaded" });
    try {
      const isTranslation = outputLang && outputLang !== "transcribe";
      // Sanitize keywords: allow only alphanumeric, spaces, commas, hyphens, apostrophes
      const rawKw = (keywords || "").trim().replace(/[^\w\s,\-']/g, "");
      let kw = rawKw ? ` Keywords: ${rawKw}` : "";

      // Step 1: Always transcribe first
      self.postMessage({ type: "status", message: "Transcribing…" });
      self.postMessage({ type: "phase", phase: "detected" });
      await runInference(audio, `Transcribe the speech to text${kw}`, (token) => {
        self.postMessage({ type: "token", phase: "detected", token });
      });
      self.postMessage({ type: "phase-done", phase: "detected" });

      // Step 2: If translation, run second pass
      if (isTranslation) {
        self.postMessage({ type: "status", message: `Translating to ${LANG_NAMES[outputLang]}…` });
        self.postMessage({ type: "phase", phase: "translated" });
        await runInference(audio, `Translate the speech to ${LANG_NAMES[outputLang]}${kw}`, (token) => {
          self.postMessage({ type: "token", phase: "translated", token });
        });
        self.postMessage({ type: "phase-done", phase: "translated" });
      }

      self.postMessage({ type: "done", isTranslation });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  }
});
