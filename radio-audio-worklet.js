// Small streaming sink for demodulated RTL-SDR audio blocks.
// Audio is produced in the main window and queued here off the UI thread.
class RadioWatchAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'reset') {
        this.blocks.length = 0;
        this.offset = 0;
        this.queuedSamples = 0;
        return;
      }
      const samples = event.data?.samples;
      if (!(samples instanceof Float32Array) || !samples.length) return;
      this.blocks.push(samples);
      this.queuedSamples += samples.length;
      // This is a live receiver: fresh audio is more important than replaying a
      // stale backlog after a browser scheduling pause.
      const maximumQueued = sampleRate * 0.05;
      while (this.queuedSamples > maximumQueued && this.blocks.length > 1) {
        const dropped = this.blocks.shift();
        this.queuedSamples -= dropped.length;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    let outputOffset = 0;
    while (outputOffset < output.length && this.blocks.length) {
      const block = this.blocks[0];
      const count = Math.min(output.length - outputOffset, block.length - this.offset);
      output.set(block.subarray(this.offset, this.offset + count), outputOffset);
      outputOffset += count;
      this.offset += count;
      this.queuedSamples -= count;
      if (this.offset >= block.length) {
        this.blocks.shift();
        this.offset = 0;
      }
    }
    if (outputOffset < output.length) output.fill(0, outputOffset);
    return true;
  }
}

registerProcessor('radio-watch-audio', RadioWatchAudioProcessor);
