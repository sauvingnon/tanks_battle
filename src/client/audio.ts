import { MAX_SPEED } from '../shared/constants.js';
import {
  BOOM_GROUND,
  BOOM_HIT,
  BOOM_KILL,
  BOOM_RICOCHET,
  type BoomKind,
} from '../shared/types.js';

type SampleName = 'engineSlow' | 'engineAverage' | 'engineFast' | 'cannonFire' | 'cannonHit' | 'metalRicochet';

const SAMPLE_URLS: Record<SampleName, string> = {
  engineSlow: new URL('./assets/audio/engine-slow.ogg', import.meta.url).href,
  engineAverage: new URL('./assets/audio/engine-average.ogg', import.meta.url).href,
  engineFast: new URL('./assets/audio/engine-fast.ogg', import.meta.url).href,
  cannonFire: new URL('./assets/audio/cannon-fire.ogg', import.meta.url).href,
  cannonHit: new URL('./assets/audio/cannon-hit.ogg', import.meta.url).href,
  metalRicochet: new URL('./assets/audio/metal-ricochet.wav', import.meta.url).href,
};

/**
 * Небольшой процедурный слой звука. Сэмплы сюда можно добавить позже, но для
 * первого прохода Web Audio хватает: он не грузит сеть и не создаёт файловый
 * пул, а события боя уже приходят из существующего снапшота.
 */
export class AudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOscillator: OscillatorNode | null = null;
  private engineHarmonic: OscillatorNode | null = null;
  private engineRumble: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private distortionCurve: Float32Array<ArrayBuffer> | null = null;
  private readonly samples: Partial<Record<SampleName, AudioBuffer>> = {};
  private samplesLoading = false;
  private sampleEngineSources: AudioBufferSourceNode[] = [];
  private sampleEngineGains: GainNode[] = [];
  private sampleEngineBus: GainNode | null = null;

  /** Браузер разрешает звук только после жеста пользователя. */
  unlock(): void {
    if (!this.context) {
      try {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.34;
        this.master.connect(this.context.destination);
      } catch {
        this.context = null;
        this.master = null;
        return;
      }
    }
    if (this.context.state === 'suspended') void this.context.resume();
    this.ensureEngine();
    void this.loadSamples();
  }

  /** Двигатель — единственный постоянный источник: только собственный танк. */
  updateEngine(speed: number, active: boolean): void {
    const context = this.runningContext();
    if (!context || !this.master) return;
    this.ensureEngine();
    if (!this.engineOscillator || !this.engineHarmonic || !this.engineRumble || !this.engineGain || !this.engineFilter) return;
    this.ensureSampleEngine();

    const t = context.currentTime;
    const movement = Math.min(1, Math.abs(speed) / MAX_SPEED);
    const sampleEngineReady = this.sampleEngineBus !== null;
    const targetGain = active && !sampleEngineReady ? 0.026 + movement * 0.085 : 0.0001;
    this.engineOscillator.frequency.linearRampToValueAtTime(24 + movement * 35, t + 0.08);
    this.engineHarmonic.frequency.linearRampToValueAtTime(48 + movement * 70, t + 0.08);
    this.engineRumble.frequency.linearRampToValueAtTime(12 + movement * 18, t + 0.08);
    this.engineFilter.frequency.linearRampToValueAtTime(300 + movement * 850, t + 0.08);
    this.engineGain.gain.linearRampToValueAtTime(targetGain, t + 0.08);
    if (this.sampleEngineBus) {
      const sampleLevel = active ? 0.22 + movement * 0.16 : 0.0001;
      const slow = Math.max(0, 1 - movement * 2.1);
      const average = Math.max(0, 1 - Math.abs(movement - 0.5) * 2.1);
      const fast = Math.max(0, (movement - 0.52) * 2.1);
      this.sampleEngineBus.gain.linearRampToValueAtTime(sampleLevel, t + 0.08);
      this.sampleEngineGains[0]?.gain.linearRampToValueAtTime(slow, t + 0.08);
      this.sampleEngineGains[1]?.gain.linearRampToValueAtTime(average, t + 0.08);
      this.sampleEngineGains[2]?.gain.linearRampToValueAtTime(fast, t + 0.08);
    }
  }

  stopEngine(): void {
    if (!this.engineGain || !this.context) return;
    this.engineGain.gain.cancelScheduledValues(this.context.currentTime);
    this.engineGain.gain.linearRampToValueAtTime(0.0001, this.context.currentTime + 0.08);
    if (this.sampleEngineBus) {
      this.sampleEngineBus.gain.cancelScheduledValues(this.context.currentTime);
      this.sampleEngineBus.gain.linearRampToValueAtTime(0.0001, this.context.currentTime + 0.08);
    }
  }

  playShot(distance = 0): void {
    const volume = this.attenuation(distance);
    if (this.playSample('cannonFire', volume, 0.96)) return;
    // Удар низом + перегруженная середина + сухой хлопок: именно перегруз
    // убирает ощущение «чистого синтезатора» и даёт тяжёлый ствол.
    this.playNoise(0.28, 0.92 * volume, 820);
    this.playNoise(0.09, 0.38 * volume, 3200, 'highpass');
    this.playRoughTone(44, 0.36, 0.68 * volume, 22);
    this.playRoughTone(94, 0.24, 0.44 * volume, 38);
  }

  playBoom(kind: BoomKind, distance: number): void {
    const volume = this.attenuation(distance);
    if (kind === BOOM_RICOCHET) {
      if (this.playSample('metalRicochet', 0.82 * volume, 1.04)) return;
      // Рикошет не должен напоминать взрыв: короткий удар металла, звон и
      // уходящий скрежет, как снаряд по броне или бетону.
      this.playRoughTone(620, 0.12, 0.2 * volume, 250);
      this.playTone(1480, 0.22, 0.16 * volume, 'triangle', 760);
      this.playNoise(0.15, 0.11 * volume, 3600, 'highpass');
      return;
    }

    const scale = kind === BOOM_KILL ? 1.3 : kind === BOOM_HIT ? 0.9 : 0.55;
    if (this.playSample('cannonHit', scale * volume * (kind === BOOM_GROUND ? 0.72 : 0.92), kind === BOOM_KILL ? 0.9 : 1)) return;
    this.playNoise(0.22 + scale * 0.13, 0.46 * scale * volume, 850);
    this.playTone(46, 0.28 + scale * 0.1, 0.3 * scale * volume, 'sine', 25);
    this.playTone(92, 0.2 + scale * 0.05, 0.16 * scale * volume, 'sawtooth', 38);
  }

  playHit(distance: number): void {
    const volume = this.attenuation(distance);
    if (this.playSample('metalRicochet', 0.36 * volume, 0.98)) return;
    this.playNoise(0.11, 0.28 * volume, 1700);
    this.playTone(180, 0.11, 0.13 * volume, 'triangle', 72);
  }

  private runningContext(): AudioContext | null {
    return this.context?.state === 'running' ? this.context : null;
  }

  private async loadSamples(): Promise<void> {
    if (this.samplesLoading || !this.context) return;
    this.samplesLoading = true;
    const context = this.context;
    const entries = Object.entries(SAMPLE_URLS) as Array<[SampleName, string]>;
    await Promise.all(entries.map(async ([name, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const data = await response.arrayBuffer();
        this.samples[name] = await context.decodeAudioData(data);
      } catch {
        // Процедурный fallback остаётся рабочим, если сеть или декодер недоступны.
      }
    }));
    this.samplesLoading = false;
  }

  private ensureSampleEngine(): void {
    if (this.sampleEngineBus || !this.context || !this.master) return;
    const buffers = [this.samples.engineSlow, this.samples.engineAverage, this.samples.engineFast];
    if (buffers.some((buffer) => !buffer)) return;

    this.sampleEngineBus = this.context.createGain();
    this.sampleEngineBus.gain.value = 0.0001;
    this.sampleEngineBus.connect(this.master);
    for (const buffer of buffers) {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer!;
      source.loop = true;
      gain.gain.value = 0.0001;
      source.connect(gain);
      gain.connect(this.sampleEngineBus);
      source.start();
      this.sampleEngineSources.push(source);
      this.sampleEngineGains.push(gain);
    }
  }

  private playSample(name: SampleName, volume: number, playbackRate: number): boolean {
    const context = this.runningContext();
    const buffer = this.samples[name];
    if (!context || !this.master || !buffer) return false;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    gain.gain.setValueAtTime(Math.max(0.0001, volume), context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + buffer.duration);
    source.connect(gain);
    gain.connect(this.master);
    source.start();
    source.stop(context.currentTime + buffer.duration + 0.02);
    return true;
  }

  private ensureEngine(): void {
    const context = this.context;
    if (!context || !this.master || this.engineOscillator) return;

    this.engineFilter = context.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 240;
    this.engineFilter.Q.value = 0.7;
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0.0001;
    this.engineOscillator = context.createOscillator();
    this.engineOscillator.type = 'sawtooth';
    this.engineOscillator.frequency.value = 54;
    this.engineHarmonic = context.createOscillator();
    this.engineHarmonic.type = 'triangle';
    this.engineHarmonic.frequency.value = 108;
    this.engineRumble = context.createOscillator();
    this.engineRumble.type = 'square';
    this.engineRumble.frequency.value = 19;

    this.engineOscillator.connect(this.engineFilter);
    this.engineHarmonic.connect(this.engineFilter);
    this.engineRumble.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOscillator.start();
    this.engineHarmonic.start();
    this.engineRumble.start();
  }

  private attenuation(distance: number): number {
    return 1 / (1 + Math.max(0, distance) * 0.035);
  }

  private playTone(
    startFrequency: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    endFrequency: number,
  ): void {
    const context = this.runningContext();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  /** Короткий перегруженный тон для ствола и жёстких металлических ударов. */
  private playRoughTone(
    startFrequency: number,
    duration: number,
    volume: number,
    endFrequency: number,
  ): void {
    const context = this.runningContext();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const shaper = context.createWaveShaper();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    shaper.curve = this.getDistortionCurve();
    shaper.oversample = '2x';
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1350, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(shaper);
    shaper.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private getDistortionCurve(): Float32Array<ArrayBuffer> {
    if (this.distortionCurve) return this.distortionCurve;
    const curve = new Float32Array(new ArrayBuffer(256 * Float32Array.BYTES_PER_ELEMENT));
    for (let i = 0; i < curve.length; i++) {
      const x = (i * 2) / (curve.length - 1) - 1;
      curve[i] = Math.tanh(x * 5.5);
    }
    this.distortionCurve = curve;
    return curve;
  }

  private playNoise(
    duration: number,
    volume: number,
    filterFrequency: number,
    filterType: BiquadFilterType = 'lowpass',
  ): void {
    const context = this.runningContext();
    if (!context || !this.master) return;
    const sampleCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = filterType;
    filter.frequency.value = filterFrequency;
    gain.gain.setValueAtTime(Math.max(0.0001, volume), context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start();
    source.stop(context.currentTime + duration + 0.02);
  }
}
