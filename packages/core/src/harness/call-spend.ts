import type { LLMResponse, RoundUsage, UsageCharge } from '@noetic-tools/types';

/** What one round used and cost. */
export interface Bill {
  usage: RoundUsage;
  cost: number;
}

/** The bill of a round the provider never reported on. */
export const noBill: Bill = {
  usage: {
    inputTokens: 0,
    outputTokens: 0,
  },
  cost: 0,
};

interface Round extends Bill {
  /** Replayed from the round ledger: paid for by an earlier attempt. */
  replayed: boolean;
}

/**
 * What one model call's rounds used and cost. Every round the provider answered
 * counts, including one the loop rejected and asked again: the provider billed it.
 * A rejected round's bill is held and folded into the round the loop goes on from,
 * so `rounds` lists the rounds the conversation kept, and `rounds[0]` still reports
 * on the first view the model answered.
 */
export class CallSpend {
  private readonly rounds: Round[] = [];
  /** Bills counted since the last round the loop went on from. */
  private held: Bill | undefined;

  /** Count a round the provider answered, whether or not the loop keeps it. */
  count(usage: RoundUsage, cost: number): void {
    this.held = addBills(this.held, {
      usage,
      cost,
    });
  }

  /**
   * The loop goes on from the round just counted, or from a steered round that has
   * no bill of its own. Returns its bill, held rejected rounds included, for the
   * round ledger to record.
   */
  keep(): Bill {
    const bill = this.held ?? noBill;
    if (this.held) {
      this.rounds.push({
        ...this.held,
        replayed: false,
      });
      this.held = undefined;
    }
    return bill;
  }

  /** Count a round replayed from the round ledger. */
  replay({ usage, cost }: Bill): void {
    this.rounds.push({
      usage,
      cost,
      replayed: true,
    });
  }

  totals(): Pick<LLMResponse, 'usage' | 'rounds' | 'cost' | 'billedCost'> {
    const bills: Bill[] = this.held
      ? [
          ...this.rounds,
          this.held,
        ]
      : this.rounds;
    const usage = sumUsage(bills.map((bill) => bill.usage));
    const cost = sum(bills.map((bill) => bill.cost));
    const replayed = this.rounds.filter((round) => round.replayed);
    return {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
      },
      rounds: bills.map((bill) => bill.usage),
      cost: cost > 0 ? cost : undefined,
      ...(replayed.length > 0
        ? {
            billedCost: cost - sum(replayed.map((round) => round.cost)),
          }
        : {}),
    };
  }

  /**
   * What a call that throws must charge: every round paid for now. A replayed round
   * was charged by the attempt that paid for it.
   */
  charge(): UsageCharge {
    const paid = this.rounds.filter((round) => !round.replayed);
    const bill = addBills(this.held, ...paid) ?? noBill;
    return {
      ...bill.usage,
      cost: bill.cost,
    };
  }
}

function addBills(...bills: Array<Bill | undefined>): Bill | undefined {
  const present = bills.filter((bill): bill is Bill => bill !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return {
    usage: sumUsage(present.map((bill) => bill.usage)),
    cost: sum(present.map((bill) => bill.cost)),
  };
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
