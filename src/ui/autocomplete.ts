import { searchPlaces } from '../geocoding/photon';
import type { Place } from '../types';

/** Campo de endereço com sugestões (debounce + cancelamento + teclado). */
export class AddressField {
  readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private items: Place[] = [];
  private active = -1;
  private timer = 0;
  private controller: AbortController | null = null;

  constructor(
    root: HTMLElement,
    private readonly onSelect: (place: Place) => void,
    private readonly onClear: () => void,
  ) {
    this.input = root.querySelector('input')!;
    this.list = root.querySelector('.suggestions')!;

    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      const q = this.input.value.trim();
      if (q.length === 0) this.onClear();
      if (q.length < 3) return this.close();
      this.timer = window.setTimeout(() => void this.search(q), 280);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => window.setTimeout(() => this.close(), 150));
    this.list.addEventListener('mousedown', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li) this.choose(Number(li.dataset.i));
    });
  }

  set value(text: string) {
    this.input.value = text;
  }

  private async search(q: string): Promise<void> {
    this.controller?.abort();
    this.controller = new AbortController();
    try {
      this.items = await searchPlaces(q, this.controller.signal);
      this.active = -1;
      this.paint();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.close();
    }
  }

  private paint(): void {
    if (this.items.length === 0) {
      this.list.innerHTML = '<li class="empty">Nenhum endereço encontrado em São Paulo</li>';
    } else {
      this.list.innerHTML = this.items
        .map(
          (p, i) =>
            `<li role="option" data-i="${i}" class="${i === this.active ? 'is-active' : ''}"><strong>${esc(p.label)}</strong>${p.detail ? `<span>${esc(p.detail)}</span>` : ''}</li>`,
        )
        .join('');
    }
    this.list.classList.add('is-open');
  }

  private close(): void {
    this.list.classList.remove('is-open');
  }

  private choose(i: number): void {
    const place = this.items[i];
    if (!place) return;
    this.input.value = place.label;
    this.close();
    this.onSelect(place);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.list.classList.contains('is-open') || this.items.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.items.length;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      this.paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.choose(this.active < 0 ? 0 : this.active);
    } else if (e.key === 'Escape') {
      this.close();
    }
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
