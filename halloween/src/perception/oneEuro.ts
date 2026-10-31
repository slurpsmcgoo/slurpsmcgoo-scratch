// One Euro filter (Casiez, Roussel and Vogel, 2012): an adaptive low-pass
// filter. It smooths heavily when a value is still and lightly when it moves
// fast, so it removes jitter without adding visible lag.

export interface OneEuroParams {
  minCutoff: number; // Hz; lower = smoother when still
  beta: number;      // how quickly the cutoff rises with speed
  dCutoff: number;   // Hz; cutoff for the speed estimate
}

function alpha(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastTimeS = 0;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, timeS: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastTimeS = timeS;
      return value;
    }
    const dt = timeS - this.lastTimeS;
    if (dt <= 0) return this.x;
    this.lastTimeS = timeS;
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
