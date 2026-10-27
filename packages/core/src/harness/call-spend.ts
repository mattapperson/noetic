import type { LLMResponse, RoundUsage, UsageCharge } from '@noetic-tools/types';

interface Bill {
  usage: RoundUsage;
  cost: number;
}

/**
 * What one model call's rounds used and cost. Every round the provider answered
 * counts, including one the loop rejected and asked again: the provider billed it.
 */
export class CallSpend {
  private readonly bills: Bill[] = [];
  /** What replayed rounds supplied, so the response can report what was paid now. */
  private replayed: number | undefined;
  /** The first bill the round ledger has not recorded. */
  private recorded = 0;

  count(usage: RoundUsage, cost: number): void {
    this.bills.push({
      usage,
      cost,
    });
  }

  /** Count a round replayed from the round ledger; its record already holds it. */
  replay(usage: RoundUsage, cost: number): void {
    this.count(usage, cost);
    this.replayed = (this.replayed ?? 0) + cost;
    this.recorded = this.bills.length;
  }

  /**
   * The usage and cost to record for the round the loop goes on from: it plus any
   * rejected rounds before it, so a resumed loop that replays the record still
   * counts their bills.
   */
  takeUnrecorded(): Bill {
    const bill = this.unrecorded();
    this.recorded = this.bills.length;
    return bill;
  }

  totals(): Pick<LLMResponse, 'usage' | 'rounds' | 'cost' | 'billedCost'> {
    const rounds = this.bills.map((bill) => bill.usage);
    const usage = sumUsage(rounds);
    const cost = sum(this.bills.map((bill) => bill.cost));
    return {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
      },
      rounds,
      cost: cost > 0 ? cost : undefined,
      ...(this.replayed !== undefined
        ? {
            billedCost: cost - this.replayed,
          }
        : {}),
    };
  }

  /**
   * What a call that throws must charge: the bills no round record holds. A recorded
   * round is charged when a retry or resume replays it, so charging it here too
   * would count it twice.
   */
  charge(): UsageCharge {
    const { usage, cost } = this.unrecorded();
    return {
      ...usage,
      cost,
    };
  }

  private unrecorded(): Bill {
    const bills = this.bills.slice(this.recorded);
    return {
      usage: sumUsage(bills.map((bill) => bill.usage)),
      cost: sum(bills.map((bill) => bill.cost)),
    };
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Add rounds' usage. A cache figure stays `undefined` when no round reported one, so
 * callers can tell "this provider says nothing about caching" from "nothing was cached".
 */
function sumUsage(rounds: RoundUsage[]): RoundUsage {
  const [only] = rounds;
  if (rounds.length === 1 && only) {
    return only;
  }
  return {
    inputTokens: sum(rounds.map((r) => r.inputTokens)),
    outputTokens: sum(rounds.map((r) => r.outputTokens)),
    cachedTokens: sumReported(rounds.map((r) => r.cachedTokens)),
    cacheWriteTokens: sumReported(rounds.map((r) => r.cacheWriteTokens)),
  };
}

function sumReported(values: Array<number | undefined>): number | undefined {
  const reported = values.filter((value): value is number => value !== undefined);
  return reported.length > 0 ? sum(reported) : undefined;
}
