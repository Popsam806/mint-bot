export class DestinationNonceManager {
  private readonly tails = new Map<string, Promise<void>>();
  async serialize<T>(chainId: number, wallet: string, operation: () => Promise<T>): Promise<T> {
    const key = `${chainId}:${wallet.toLowerCase()}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}
