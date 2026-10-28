import { hourLabel, type HourFilter } from '../types';

export interface TimelineEvents {
  /** `live` = mudança durante a animação (só o visual precisa acompanhar). */
  onChange: (hour: HourFilter, live: boolean) => void;
  /** Animação parou: hora de recalcular o que é caro (risco, rotas). */
  onSettle: (hour: HourFilter) => void;
}

const STEP_MS = 850;

/**
 * Linha do tempo de 24 h: slider, "Todos", "Agora" e play. Também desenha o perfil
 * horário da cidade (barras) acima do slider.
 */
export class Timeline {
  private hour: HourFilter = 'todos';
  private lastHour = new Date().getHours();
  private timer = 0;
  private readonly range: HTMLInputElement;
  private readonly out: HTMLOutputElement;
  private readonly play: HTMLButtonElement;
  private readonly bars: HTMLElement;
  private readonly badge: HTMLElement;

  constructor(
    root: HTMLElement,
    badge: HTMLElement,
    private readonly ev: TimelineEvents,
  ) {
    this.range = root.querySelector('#hourRange')!;
    this.out = root.querySelector('#hourOut')!;
    this.play = root.querySelector('#playBtn')!;
    this.bars = root.querySelector('#hourBars')!;
    this.badge = badge;

    this.range.addEventListener('input', () => {
      this.stop(false);
      this.set(Number(this.range.value), true);
    });
    this.range.addEventListener('change', () => this.ev.onSettle(this.hour));
    root.querySelector('[data-hour="todos"]')!.addEventListener('click', () => {
      this.stop(false);
      this.set('todos', true);
      this.ev.onSettle(this.hour);
    });
    root.querySelector('[data-hour="agora"]')!.addEventListener('click', () => {
      this.stop(false);
      this.set(new Date().getHours(), true);
      this.ev.onSettle(this.hour);
    });
    this.play.addEventListener('click', () => (this.timer ? this.stop(true) : this.start()));
    this.bars.addEventListener('click', (e) => {
      const bar = (e.target as Element).closest<SVGElement>('[data-h]');
      if (!bar) return;
      this.stop(false);
      this.set(Number(bar.dataset.h), true);
      this.ev.onSettle(this.hour);
    });
  }

  get value(): HourFilter {
    return this.hour;
  }

  get playing(): boolean {
    return this.timer !== 0;
  }

  /** Define a hora sem disparar eventos (ex.: restaurar do link). */
  restore(hour: HourFilter): void {
    this.hour = hour;
    if (hour !== 'todos') this.lastHour = hour;
    this.paint();
  }

  set(hour: HourFilter, live: boolean): void {
    this.hour = hour;
    if (hour !== 'todos') this.lastHour = hour;
    this.paint();
    this.ev.onChange(hour, live);
  }

  start(): void {
    if (this.timer) return;
    document.body.classList.add('is-timelapse');
    this.play.setAttribute('aria-pressed', 'true');
    this.play.setAttribute('aria-label', 'Pausar animação');
    if (this.hour === 'todos') this.set(this.lastHour, true);
    this.timer = window.setInterval(() => {
      const h = this.hour === 'todos' ? this.lastHour : this.hour;
      this.set((h + 1) % 24, true);
    }, STEP_MS);
  }

  stop(settle: boolean): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = 0;
    document.body.classList.remove('is-timelapse');
    this.play.setAttribute('aria-pressed', 'false');
    this.play.setAttribute('aria-label', 'Animar as 24 horas');
    if (settle) this.ev.onSettle(this.hour);
  }

  /** Perfil da cidade por hora (barras clicáveis). */
  setProfile(byHour: number[]): void {
    const max = Math.max(...byHour, 1);
    const w = 240;
    const h = 34;
    const bw = w / 24;
    this.bars.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${byHour
      .map((v, i) => {
        const bh = Math.max(1.5, (v / max) * (h - 2));
        return `<rect data-h="${i}" x="${(i * bw + 0.8).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 1.6).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/>`;
      })
      .join('')}</svg>`;
    this.paint();
  }

  private paint(): void {
    const all = this.hour === 'todos';
    this.out.textContent = all ? 'Todos os horários' : `${hourLabel(this.hour)} – ${hourLabel(((this.hour as number) + 1) % 24)}`;
    this.range.value = String(all ? this.lastHour : this.hour);
    this.range.classList.toggle('is-dimmed', all);
    this.range.style.setProperty('--fill', `${((all ? this.lastHour : (this.hour as number)) / 23) * 100}%`);
    this.badge.textContent = all ? '' : hourLabel(this.hour);
    this.badge.hidden = all;
    document.querySelectorAll('[data-hour]').forEach((b) => {
      const k = (b as HTMLElement).dataset.hour;
      b.classList.toggle('is-on', k === 'todos' ? all : false);
    });
    this.bars.querySelectorAll('rect').forEach((r) => r.classList.toggle('is-active', !all && Number(r.dataset.h) === this.hour));
  }
}
