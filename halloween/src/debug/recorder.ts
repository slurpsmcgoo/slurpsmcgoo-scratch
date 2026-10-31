// Recorder (key R): writes each perception tick to logs/ through the server,
// one JSON line of numbers per tick, never images. Logs replay with
// ?source=replay&log=<name>. Video is a development-only option for testing
// with your own household, and runs only when recorder.recordVideo is true.

import type { ShowConfig } from '../config.ts';
import type { ServerLink } from '../control/remoteClient.ts';
import { serializeFrame, type PerceptionFrame } from '../world/frame.ts';

export class Recorder {
  recording = false;
  private media: MediaRecorder | null = null;
  private firstChunk = true;

  constructor(
    private link: ServerLink,
    private cfg: () => ShowConfig,
  ) {
    if (cfg().recorder.enabled) this.start(null);
  }

  toggle(videoStream: MediaStream | null): void {
    if (this.recording) this.stop();
    else this.start(videoStream);
  }

  start(videoStream: MediaStream | null): void {
    this.recording = true;
    this.link.startLog();
    if (this.cfg().recorder.recordVideo && videoStream && typeof MediaRecorder !== 'undefined') {
      this.firstChunk = true;
      this.media = new MediaRecorder(videoStream, { mimeType: 'video/webm' });
      this.media.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        const start = this.firstChunk ? '?start=1' : '';
        this.firstChunk = false;
        void fetch(`/api/video${start}`, { method: 'POST', body: e.data }).catch(() => {});
      };
      this.media.start(2000);
      console.info('[recorder] development video recording is ON');
    }
  }

  stop(): void {
    this.recording = false;
    this.link.stopLog();
    this.media?.stop();
    this.media = null;
  }

  write(frame: PerceptionFrame): void {
    if (this.recording) this.link.logLine(serializeFrame(frame));
  }
}
