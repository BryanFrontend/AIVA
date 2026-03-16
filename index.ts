/**
 * @aiva/strategies
 * AIVA Strategy Framework
 *
 * Strategies are pure signal generators. They consume market data and indicators,
 * produce a directional signal with a confidence score and reason codes,
 * and know nothing about execution or position sizing.
 *
 * The strategy interface is designed to be pluggable. Adding a new strategy
 * requires implementing IStrategy and registering it with the ensemble.
 */

import type {
  Signal,
  SignalDirection,
  SignalReason,
  Candle,
  DerivedIndicators,
  Ticker,
  ReasonCode,
} from '@aiva/common';
import { generateId, nowMs, clamp } from '@aiva/common';

// =============================================================================
// STRATEGY INTERFACE
// =============================================================================

export interface StrategyContext {
  symbol: string;
  candles: Candle[]; // most recent last
  indicators: DerivedIndicators;
  ticker: Ticker;
  sentimentScore?: number; // -1 to 1
}

export interface IStrategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultWeight: number;

  /**
   * Evaluate current market context and return a signal.
   * Must always return a signal (direction: neutral if no view).
   * Signal lifetime (expiresAt) is strategy-specific.
   */
  evaluate(ctx: StrategyContext): Signal;
}

// =============================================================================
// HELPERS
// =============================================================================

function makeSignal(
  strategyId: string,
  symbol: string,
  direction: SignalDirection,
  confidence: number,
  reasons: SignalReason[],
  ttlMs = 60 * 60 * 1000
): Signal {
  const now = nowMs();
  return {
    id: generateId('sig'),
    strategyId,
    symbol,
    direction,
    confidence: clamp(confidence, 0, 1),
    score: direction === 'neutral' ? 0 : direction === 'long' ? confidence : -confidence,
    reasons,
    timestamp: now,
    expiresAt: now + ttlMs,
  };
}

function reason(code: ReasonCode, description: string, value?: number, threshold?: number): SignalReason {
  return { code, description, value, threshold };
}

// =============================================================================
// STRATEGY: MOMENTUM BREAKOUT
// Identifies assets breaking out above recent swing highs with volume confirmation.
// =============================================================================

export class MomentumBreakoutStrategy implements IStrategy {
  readonly id = 'momentum_breakout';
  readonly name = 'Momentum Breakout';
  readonly description =
    'Identifies directional momentum breakouts confirmed by above-average volume. ' +
    'Enters on RSI momentum and price breaking above recent highs.';
  readonly defaultWeight = 0.30;

  evaluate(ctx: StrategyContext): Signal {
    const { symbol, indicators, candles, ticker } = ctx;
    const reasons: SignalReason[] = [];

    if (candles.length < 20) {
      return makeSignal(this.id, symbol, 'neutral', 0, [
        reason('REGIME_UNCERTAIN', 'Insufficient candle history'),
      ]);
    }

    // RSI momentum check
    const rsiLong = indicators.rsi14 > 55 && indicators.rsi14 < 80;
    const rsiShort = indicators.rsi14 < 45 && indicators.rsi14 > 20;

    // Price vs SMA
    const aboveSma20 = ticker.price > indicators.sma20;
    const aboveSma50 = ticker.price > indicators.sma50;
    const belowSma20 = ticker.price < indicators.sma20;
    const belowSma50 = ticker.price < indicators.sma50;

    // Volume confirmation
    const volumeConfirmed = indicators.volumeRatio > 1.3;

    // Momentum
    const momentumPositive = indicators.momentum10 > 0.02;
    const momentumNegative = indicators.momentum10 < -0.02;

    // ADX trend strength
    const strongTrend = indicators.adx14 > 25;

    let confidence = 0;
    let direction: SignalDirection = 'neutral';

    if (rsiLong && aboveSma20 && aboveSma50 && momentumPositive) {
      direction = 'long';
      confidence = 0.5;

      if (volumeConfirmed) {
        confidence += 0.2;
        reasons.push(reason('VOLUME_CONFIRMED', `Volume ratio ${indicators.volumeRatio.toFixed(2)}x`, indicators.volumeRatio, 1.3));
      }
      if (strongTrend) {
        confidence += 0.15;
        reasons.push(reason('REGIME_TREND_POSITIVE', `ADX ${indicators.adx14.toFixed(1)} indicates strong trend`, indicators.adx14, 25));
      }
      reasons.push(reason('MOMENTUM_CONFIRMED', `RSI ${indicators.rsi14.toFixed(1)}, momentum ${(indicators.momentum10 * 100).toFixed(2)}%`, indicators.rsi14));

    } else if (rsiShort && belowSma20 && belowSma50 && momentumNegative) {
      direction = 'short';
      confidence = 0.5;

      if (volumeConfirmed) {
        confidence += 0.2;
        reasons.push(reason('VOLUME_CONFIRMED', `Volume ratio ${indicators.volumeRatio.toFixed(2)}x`, indicators.volumeRatio, 1.3));
      }
      if (strongTrend) {
        confidence += 0.15;
        reasons.push(reason('REGIME_TREND_NEGATIVE', `ADX ${indicators.adx14.toFixed(1)} in downtrend`, indicators.adx14, 25));
      }
      reasons.push(reason('MOMENTUM_CONFIRMED', `RSI ${indicators.rsi14.toFixed(1)}, momentum ${(indicators.momentum10 * 100).toFixed(2)}%`, indicators.rsi14));

    } else {
      reasons.push(reason('MOMENTUM_REJECTED', `No breakout confirmed. RSI: ${indicators.rsi14.toFixed(1)}`));
    }

    if (!volumeConfirmed && direction !== 'neutral') {
      confidence *= 0.7;
      reasons.push(reason('VOLUME_INSUFFICIENT', `Volume ratio ${indicators.volumeRatio.toFixed(2)}x below 1.3x threshold`, indicators.volumeRatio, 1.3));
    }

    return makeSignal(this.id, symbol, direction, confidence, reasons);
  }
}

// =============================================================================
// STRATEGY: MEAN REVERSION
// Fades overextended moves when price deviates from its mean.
// =============================================================================

export class MeanReversionStrategy implements IStrategy {
  readonly id = 'mean_reversion';
  readonly name = 'Mean Reversion';
  readonly description =
    'Fades extreme deviations from the 20-period mean using Bollinger Bands and RSI extremes. ' +
    'Designed for ranging market regimes.';
  readonly defaultWeight = 0.25;

  evaluate(ctx: StrategyContext): Signal {
    const { symbol, indicators, ticker } = ctx;
    const reasons: SignalReason[] = [];

    // Only valid in ranging/low-ADX markets
    if (indicators.adx14 > 30) {
      return makeSignal(this.id, symbol, 'neutral', 0, [
        reason('REGIME_TREND_POSITIVE', `ADX ${indicators.adx14.toFixed(1)} too high for mean reversion`, indicators.adx14, 30),
      ]);
    }

    const bbWidth = indicators.bbWidth;
    const belowLower = ticker.price < indicators.bbLower;
    const aboveUpper = ticker.price > indicators.bbUpper;
    const rsiOversold = indicators.rsi14 < 35;
    const rsiOverbought = indicators.rsi14 > 65;

    // BB deviation normalized
    const bbDeviation = Math.abs(ticker.price - indicators.bbMiddle) / (bbWidth * indicators.bbMiddle + 0.0001);

    let direction: SignalDirection = 'neutral';
    let confidence = 0;

    if (belowLower && rsiOversold) {
      direction = 'long';
      confidence = 0.45 + Math.min(bbDeviation * 0.3, 0.25);
      reasons.push(
        reason('MEAN_REVERSION_ENTRY', `Price below lower BB, RSI oversold at ${indicators.rsi14.toFixed(1)}`, indicators.rsi14, 35),
        reason('REGIME_RANGING', `ADX ${indicators.adx14.toFixed(1)} - ranging regime confirmed`, indicators.adx14, 30)
      );
    } else if (aboveUpper && rsiOverbought) {
      direction = 'short';
      confidence = 0.45 + Math.min(bbDeviation * 0.3, 0.25);
      reasons.push(
        reason('MEAN_REVERSION_ENTRY', `Price above upper BB, RSI overbought at ${indicators.rsi14.toFixed(1)}`, indicators.rsi14, 65),
        reason('REGIME_RANGING', `ADX ${indicators.adx14.toFixed(1)} - ranging regime confirmed`, indicators.adx14, 30)
      );
    } else {
      reasons.push(reason('REGIME_RANGING', 'No mean reversion setup present'));
    }

    return makeSignal(this.id, symbol, direction, confidence, reasons, 30 * 60 * 1000); // 30min TTL
  }
}

// =============================================================================
// STRATEGY: TREND CONTINUATION
// Follows established trends using EMA alignment.
// =============================================================================

export class TrendContinuationStrategy implements IStrategy {
  readonly id = 'trend_continuation';
  readonly name = 'Trend Continuation';
  readonly description =
    'Follows established directional trends by requiring EMA alignment and ' +
    'price confirmation above or below key moving averages.';
  readonly defaultWeight = 0.25;

  evaluate(ctx: StrategyContext): Signal {
    const { symbol, indicators, ticker } = ctx;
    const reasons: SignalReason[] = [];

    // Need strong ADX for trend continuation
    if (indicators.adx14 < 20) {
      return makeSignal(this.id, symbol, 'neutral', 0, [
        reason('REGIME_UNCERTAIN', `ADX ${indicators.adx14.toFixed(1)} below trend threshold`, indicators.adx14, 20),
      ]);
    }

    const aboveEma = ticker.price > indicators.ema14;
    const aboveSma20 = ticker.price > indicators.sma20;
    const aboveSma50 = ticker.price > indicators.sma50;
    const emaAboveSma20 = indicators.ema14 > indicators.sma20;
    const sma20AboveSma50 = indicators.sma20 > indicators.sma50;

    // Full bullish alignment
    const bullishAlignment = aboveEma && aboveSma20 && aboveSma50 && emaAboveSma20 && sma20AboveSma50;
    // Full bearish alignment
    const bearishAlignment = !aboveEma && !aboveSma20 && !aboveSma50 && !emaAboveSma20 && !sma20AboveSma50;

    let direction: SignalDirection = 'neutral';
    let confidence = 0;

    if (bullishAlignment) {
      direction = 'long';
      confidence = 0.40 + (indicators.adx14 - 20) / 100;
      reasons.push(
        reason('TREND_CONTINUATION', 'Full bullish EMA/SMA alignment confirmed'),
        reason('REGIME_TREND_POSITIVE', `ADX ${indicators.adx14.toFixed(1)}`, indicators.adx14, 20)
      );
    } else if (bearishAlignment) {
      direction = 'short';
      confidence = 0.40 + (indicators.adx14 - 20) / 100;
      reasons.push(
        reason('TREND_CONTINUATION', 'Full bearish EMA/SMA alignment confirmed'),
        reason('REGIME_TREND_NEGATIVE', `ADX ${indicators.adx14.toFixed(1)}`, indicators.adx14, 20)
      );
    } else {
      reasons.push(reason('REGIME_UNCERTAIN', 'Mixed MA alignment, no trend continuation signal'));
    }

    return makeSignal(this.id, symbol, direction, clamp(confidence, 0, 0.80), reasons, 2 * 60 * 60 * 1000); // 2h TTL
  }
}

// =============================================================================
// STRATEGY: VOLATILITY REGIME
// Adjusts position bias based on volatility expansion/contraction.
// =============================================================================

export class VolatilityRegimeStrategy implements IStrategy {
  readonly id = 'volatility_regime';
  readonly name = 'Volatility Regime';
  readonly description =
    'Identifies volatility contraction setups (coiling) that precede expansionary moves. ' +
    'Generates directional signals when price breaks out of a low-volatility consolidation.';
  readonly defaultWeight = 0.20;

  evaluate(ctx: StrategyContext): Signal {
    const { symbol, indicators, ticker } = ctx;
    const reasons: SignalReason[] = [];

    // Volatility contraction = BB width below 2% of price
    const bbWidthPct = indicators.bbWidth;
    const contracting = bbWidthPct < 0.02;

    // Expansion = price breaking out of BB after contraction
    const breakingUp = ticker.price > indicators.bbUpper && indicators.momentum10 > 0;
    const breakingDown = ticker.price < indicators.bbLower && indicators.momentum10 < 0;

    let direction: SignalDirection = 'neutral';
    let confidence = 0;

    if (contracting && breakingUp) {
      direction = 'long';
      confidence = 0.55;
      reasons.push(
        reason('VOLATILITY_CONTRACTION', `BB width ${(bbWidthPct * 100).toFixed(2)}% - coiling detected`, bbWidthPct, 0.02),
        reason('VOLATILITY_EXPANSION', 'Price breaking above BB upper after contraction')
      );
    } else if (contracting && breakingDown) {
      direction = 'short';
      confidence = 0.55;
      reasons.push(
        reason('VOLATILITY_CONTRACTION', `BB width ${(bbWidthPct * 100).toFixed(2)}% - coiling detected`, bbWidthPct, 0.02),
        reason('VOLATILITY_EXPANSION', 'Price breaking below BB lower after contraction')
      );
    } else if (contracting) {
      reasons.push(reason('VOLATILITY_CONTRACTION', 'Coiling detected, awaiting breakout direction'));
    } else {
      reasons.push(reason('REGIME_VOLATILE', `BB width ${(bbWidthPct * 100).toFixed(2)}% - no contraction setup`));
    }

    return makeSignal(this.id, symbol, direction, confidence, reasons, 45 * 60 * 1000); // 45min TTL
  }
}

// =============================================================================
// ENSEMBLE
// Combines multiple strategies with configurable weights.
// =============================================================================

export interface EnsembleConfig {
  strategies: { strategy: IStrategy; weight: number }[];
  minConfidenceThreshold: number;
  requireConsensus: boolean; // if true, majority must agree on direction
}

export class StrategyEnsemble {
  private config: EnsembleConfig;

  constructor(config: EnsembleConfig) {
    this.config = config;
  }

  /**
   * Evaluate all strategies and return a weighted ensemble signal.
   */
  evaluate(ctx: StrategyContext): Signal {
    const signals = this.config.strategies.map(({ strategy, weight }) => ({
      signal: strategy.evaluate(ctx),
      weight,
    }));

    // Compute weighted directional score
    let longScore = 0;
    let shortScore = 0;
    let totalWeight = 0;
    const allReasons: SignalReason[] = [];

    for (const { signal, weight } of signals) {
      totalWeight += weight;
      allReasons.push(...signal.reasons);

      if (signal.direction === 'long') {
        longScore += signal.confidence * weight;
      } else if (signal.direction === 'short') {
        shortScore += signal.confidence * weight;
      }
    }

    const normalizedLong = longScore / totalWeight;
    const normalizedShort = shortScore / totalWeight;
    const netScore = normalizedLong - normalizedShort;

    let direction: SignalDirection = 'neutral';
    let confidence = 0;

    if (Math.abs(netScore) > this.config.minConfidenceThreshold) {
      direction = netScore > 0 ? 'long' : 'short';
      confidence = Math.abs(netScore);

      // Check consensus requirement
      if (this.config.requireConsensus) {
        const agreeing = signals.filter((s) => s.signal.direction === direction).length;
        const total = signals.length;
        if (agreeing / total < 0.5) {
          direction = 'neutral';
          confidence = 0;
          allReasons.push(reason('REGIME_UNCERTAIN', `No consensus: ${agreeing}/${total} strategies agree`));
        }
      }
    }

    return {
      id: generateId('ens'),
      strategyId: 'ensemble',
      symbol: ctx.symbol,
      direction,
      confidence: clamp(confidence, 0, 1),
      score: netScore,
      reasons: allReasons,
      timestamp: nowMs(),
      expiresAt: nowMs() + 30 * 60 * 1000,
    };
  }
}

// =============================================================================
// DEFAULT ENSEMBLE
// =============================================================================

export function createDefaultEnsemble(): StrategyEnsemble {
  const strategies: IStrategy[] = [
    new MomentumBreakoutStrategy(),
    new MeanReversionStrategy(),
    new TrendContinuationStrategy(),
    new VolatilityRegimeStrategy(),
  ];

  return new StrategyEnsemble({
    strategies: strategies.map((s) => ({ strategy: s, weight: s.defaultWeight })),
    minConfidenceThreshold: 0.25,
    requireConsensus: false,
  });
}

export {
  MomentumBreakoutStrategy,
  MeanReversionStrategy,
  TrendContinuationStrategy,
  VolatilityRegimeStrategy,
};
