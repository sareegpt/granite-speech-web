import {
  GraniteSpeechForConditionalGeneration,
  AutoProcessor,
  TextStreamer,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/granite-4.0-1b-speech-ONNX";

let model = null;
let processor = null;

self.addEventListener("message", async (e) => {
  const { type, audio } = e.data;

  if (type === "load") {
    try {
      self.postMessage({ type: "status", message: "Downloading model…" });

      const progressCallback = (progress) => {
        if (progress.status === "progress") {
          self.postMessage({
            type: "progress",
            file: progress.file,
            loaded: progress.loaded,
            total: progress.total,
          });
        }
      };

      // Load model and processor in parallel
      const [loadedModel, loadedProcessor] = await Promise.all([
        GraniteSpeechForConditionalGeneration.from_pretrained(MODEL_ID, {
          dtype: {
            audio_encoder: "q4f16",
            embed_tokens: "q4f16",
            decoder_model_merged: "q4f16",
          },
          device: "webgpu",
          progress_callback: progressCallback,
        }),
        AutoProcessor.from_pretrained(MODEL_ID, {
          progress_callback: progressCallback,
        }),
      ]);

      model = loadedModel;
      processor = loadedProcessor;

      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  if (type === "transcribe") {
    if (!model || !processor) {
      self.postMessage({ type: "error", message: "Model not loaded" });
      return;
    }
    try {
      self.postMessage({ type: "status", message: "Transcribing…" });

      // Build the chat-style prompt with audio placeholder
      const messages = [
        {
          role: "user",
          content: [
            { type: "audio", audio },
            { type: "text", text: "Transcribe the speech to text" },
          ],
        },
      ];

      const inputs = await processor(messages);

      // Stream tokens back as they are generated
      const streamer = new TextStreamer(processor.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (token) => {
          self.postMessage({ type: "token", token });
        },
      });

      await model.generate({
        ...inputs,
        max_new_tokens: 512,
        streamer,
      });

      self.postMessage({ type: "done" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
  }
});
