// Collects microphone samples on the audio thread and hands them to mic.js.
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }

  process(inputs, outputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    if (outputs[0]?.[0]) outputs[0][0].fill(0);
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
