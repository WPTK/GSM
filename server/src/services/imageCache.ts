/**
 * Small in-memory LRU cache for proxied images, bounded by total bytes.
 * A Map keeps insertion order, so the first key is always the least recently used.
 */
export interface CachedImage {
  body: Buffer;
  contentType: string;
}

interface Entry extends CachedImage {
  expiresAt: number;
}

export class ImageCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, now: number = Date.now()): CachedImage | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    // Move to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { body: entry.body, contentType: entry.contentType };
  }

  set(key: string, value: CachedImage, now: number = Date.now()): void {
    if (value.body.length > this.maxBytes) return;
    this.delete(key);
    this.entries.set(key, { ...value, expiresAt: now + this.ttlMs });
    this.totalBytes += value.body.length;
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.body.length;
    this.entries.delete(key);
  }
}
