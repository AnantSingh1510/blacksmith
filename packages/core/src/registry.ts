export class RuntimeRegistry {
  private readonly values = new Map<string, unknown>();

  set<TValue>(key: string, value: TValue): void {
    this.values.set(key, value);
  }

  get<TValue>(key: string): TValue | undefined {
    return this.values.get(key) as TValue | undefined;
  }

  require<TValue>(key: string): TValue {
    const value = this.get<TValue>(key);
    if (value === undefined) {
      throw new Error(`Blacksmith registry value "${key}" has not been registered.`);
    }

    return value;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}
