import { sumStructuredUsage } from "../common/structured-output.js";
import { type Usage, UsageSchema } from "../contracts.js";
export class UsageLedger {
  private readonly calls = new Map<string, (Usage | null)[]>();
  private readonly warnings = new Set<string>();
  constructor(
    private readonly parent?: UsageLedger,
    private readonly stage?: string,
  ) {}
  add(stage: string, usage: Usage | null): void {
    if (this.parent) {
      this.parent.add(this.stage ?? stage, usage);
      return;
    }
    const items = this.calls.get(stage) ?? [];
    items.push(usage);
    this.calls.set(stage, items);
  }
  claimWarning(key: string): boolean {
    if (this.parent) return this.parent.claimWarning(key);
    if (this.warnings.has(key)) return false;
    this.warnings.add(key);
    return true;
  }
  scoped(stage: string): UsageLedger {
    return new UsageLedger(this, stage);
  }
  totals(): Record<string, Usage | null> {
    if (this.parent) return this.parent.totals();
    return Object.fromEntries(
      [...this.calls].map(([stage, items]) => {
        const known = items.filter((value): value is Usage => value !== null),
          unknown = items.length - known.length;
        if (unknown) known.push(UsageSchema.parse({ calls: unknown }));
        return [stage, sumStructuredUsage(known)];
      }),
    );
  }
}
