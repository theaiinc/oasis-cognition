/**
 * AudioWorklet processor for capturing PCM audio and sending to main thread.
 * Runs in a separate audio rendering thread for low-latency processing.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._active = true;
    this.port.onmessage = (e) => {
      if (e.data.type === 'stop') {
        this._active = false;
      }
    };
  }

  process(inputs) {
    if (!this._active) return false;

    const input = inputs[0];
    if (!input || !input[0]) return true;

    // input[0] is Float32Array of PCM samples for channel 0
    const samples = input[0];

    // Compute RMS energy for UI audio level display
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);

    // Send audio data + energy level to main thread
    // Transfer the buffer for zero-copy (can't reuse after this)
    const copy = new Float32Array(samples);
    this.port.postMessage(
      { type: 'audio', samples: copy.buffer, rms },
      [copy.buffer]
    );

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
