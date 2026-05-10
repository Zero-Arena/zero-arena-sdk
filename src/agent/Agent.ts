import type { Action, Observation } from '../types.js';

/**
 * Abstract base class for trading agents.
 *
 * Strategy lives in the user's subclass — `decide` is the only required method.
 * `toJSON` defaults to the class name only, so the agent's strategy does not leak
 * into `agentHash` unless the user explicitly opts in by overriding it.
 *
 * Override `toJSON` if you want the agent's hyperparameters to be part of its
 * cryptographic identity (so a re-tuned variant produces a different `agentHash`).
 *
 * @example
 * ```ts
 * class RsiAgent extends Agent {
 *   constructor(private oversold = 30, private overbought = 70) { super(); }
 *
 *   async decide(obs: Observation): Promise<Action> {
 *     if (obs.rsi14 < this.oversold)  return { direction:  1, size: 0.2 };
 *     if (obs.rsi14 > this.overbought) return { direction: -1, size: 0.2 };
 *     return { direction: 0, size: 0 };
 *   }
 *
 *   override toJSON() {
 *     return { className: 'RsiAgent', oversold: this.oversold, overbought: this.overbought };
 *   }
 * }
 * ```
 */
export abstract class Agent {
  abstract decide(obs: Observation): Promise<Action> | Action;

  toJSON(): Record<string, unknown> {
    return { className: this.constructor.name };
  }
}
