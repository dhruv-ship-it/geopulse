/**
 * Seeded pseudo-random number generation.
 *
 * `Math.random()` is banned in this service (CLAUDE.md rule 3): every number that reaches a
 * benchmark or an eval has to be re-derivable, and a run that cannot be reproduced cannot be
 * scored twice. Anywhere the scenarios want "an arbitrary but fixed choice" — which zones the
 * noise scenario picks, where the grid jitters a zone — they take it from here instead, so the
 * whole run is a pure function of its seed.
 *
 * The generator is splitmix32: 32-bit state, one multiply-xorshift round, well-distributed
 * enough for placement and selection, and crucially *specified in arithmetic that behaves
 * identically on every platform* (`Math.imul` and `>>>` are exact on 32-bit integers, unlike
 * anything routed through a double). A Mersenne Twister would be better-distributed and far
 * more code; nothing here is sensitive to the difference.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new Error(`seed must be an integer, got ${seed}`);
    }
    // >>> 0 keeps the state an unsigned 32-bit integer, including for negative seeds.
    this.state = seed >>> 0;
  }

  /**
   * Derive an independent stream from a label. Two scenarios, or two anomalies within one
   * scenario, must not share a stream: if they did, adding a parameter to the first would
   * silently shift every draw in the second, and "same seed, same run" would hold only until
   * the next edit. Each consumer names its own sub-stream instead.
   */
  static forStream(seed: number, label: string): Prng {
    let hash = 2166136261;
    for (let i = 0; i < label.length; i++) {
      hash ^= label.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return new Prng(((seed >>> 0) ^ (hash >>> 0)) >>> 0);
  }

  /** Next raw 32-bit unsigned integer. */
  nextUint32(): number {
    this.state = (this.state + 0x9e3779b9) | 0;
    let z = this.state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  }

  /** Next value in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Next value in [min, max). */
  nextInRange(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Next integer in [min, max], inclusive at both ends. */
  nextIntInclusive(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`invalid integer range [${min}, ${max}]`);
    }
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /**
   * Fisher-Yates over a copy. Returns a new array; the caller's ordering is never mutated,
   * because a scenario builder that reordered the zone list in place would change what every
   * later builder saw.
   */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextIntInclusive(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
