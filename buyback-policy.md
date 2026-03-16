# AIVA Buyback Policy

> Treasury Operations Reference — Transparency Document

---

**DISCLAIMER:** This document describes the AIVA system's configurable buyback mechanics.
Buybacks are conditional, rules-based treasury operations funded exclusively by onchain agent
revenue. They are **not** a guarantee of token price appreciation, holder returns, or future
buyback activity. All parameters described herein are configurable by system operators and may
be changed without notice. This is not financial advice.

---

## Purpose

The buyback module provides a transparent, rules-based mechanism by which a portion of AIVA's
realized trading revenue can be used to purchase AIVA tokens from the open market. The purpose
of this mechanism is to create an observable link between agent performance and treasury behavior
— not to manufacture artificial price support or guarantee any outcome.

Every buyback evaluation is logged with reason codes. Every skipped evaluation is logged with
the reason it was skipped. The full history is queryable via the `/api/v1/buybacks` endpoint.

---

## Capital Flow

Realized trading PnL flows into the treasury and is split into three buckets:

```
Realized PnL (SOL)
        │
        ▼
┌─────────────────────────────────────┐
│           Treasury Engine           │
│                                     │
│  Reserve Bucket  ──── 50% (default) │
│  Operating Bucket ─── 30% (default) │
│  Buyback Budget ──── 20% (default)  │
└─────────────────────────────────────┘
```

The reserve bucket is funded first. If the reserve is below its configured floor,
the operating and buyback buckets each contribute proportionally to cover the deficit
before any buyback budget is credited.

**The reserve floor is never touched by buyback operations.** Buyback execution draws
only from the buyback budget bucket.

---

## Activation Conditions

A buyback is evaluated at the end of each agent tick. The evaluation gates are checked in order:

### Gate 1: Policy Enabled
```
BUYBACK_ENABLED = true/false
```
If the policy flag is disabled, evaluation returns immediately with `BUYBACK_WINDOW_CLOSED`.

### Gate 2: Epoch Budget
```
BUYBACK_MAX_SPEND_PER_EPOCH_SOL = 2.0
BUYBACK_EPOCH_HOURS = 24
```
The total amount spent on buybacks within a rolling epoch window is tracked.
If the epoch budget is exhausted, evaluation returns `BUYBACK_BUDGET_EXHAUSTED`.

### Gate 3: Reserve Floor Protection
```
TREASURY_RESERVE_FLOOR_SOL = 20.0
```
If the reserve bucket is below the configured floor, the buyback is skipped with
`BUYBACK_SKIPPED_RESERVE` and `TREASURY_RESERVE_PROTECTED`. The reserve floor
takes absolute precedence over buyback execution.

### Gate 4: Cooldown Period
```
BUYBACK_COOLDOWN_HOURS = 6
```
A minimum interval is enforced between buyback executions. If a buyback was
executed within the cooldown window, evaluation returns `BUYBACK_COOLDOWN_ACTIVE`.

### Gate 5: Market Liquidity
```
BUYBACK_MIN_LIQUIDITY_SOL = 50.0
```
If the AIVA token's on-chain liquidity is below the minimum threshold, execution is
skipped with `BUYBACK_SKIPPED_LIQUIDITY`. Buybacks during illiquid conditions would
result in disproportionate price impact and are not in the treasury's interest.

### Gate 6: Volatility Check
```
BUYBACK_VOLATILITY_THRESHOLD = 0.08
```
If the 24-hour price change of the AIVA token exceeds the volatility threshold
(absolute value), the buyback is skipped with `BUYBACK_SKIPPED_VOLATILITY`.
Buying into extreme volatility — whether up or down — increases execution risk.

---

## Execution

When all gates pass, the system emits `BUYBACK_WINDOW_OPEN`. The spend amount
is the minimum of the remaining epoch budget and the current buyback bucket balance.

In paper/backtest mode, execution is simulated and tagged with `EXECUTION_SIMULATION_ONLY`.
In live mode, the execution engine routes the buy through the configured DEX aggregator.

Every executed buyback produces a `BuybackRecord` with:
- Epoch ID
- Budget available
- Amount spent
- Tokens acquired (if available from router)
- Average execution price
- Transaction signature (live mode)
- Timestamp
- All reason codes

---

## What Happens to Purchased Tokens

The disposition of purchased tokens (hold in treasury, burn, distribute) is a separate
configurable policy layer that is **not implemented in this version** of AIVA. This is
intentional: the buyback module handles acquisition only. Treasury token management
is a governance-level decision beyond the scope of the trading agent.

---

## Anti-Abuse Design

The buyback module is designed to prevent misuse:

- **No market making loop:** The agent does not buy and sell the same token in coordinated
  patterns. Buybacks are evaluated independently of trading signals.

- **No self-dealing:** The buyback budget can only be funded by realized revenue from
  trading unrelated assets. There is no mechanism for the treasury to fund buybacks
  from borrowed or synthetic capital.

- **No wash trading:** The system has no mechanism to create artificial volume. All
  trades are executed against real market liquidity with slippage tracking.

- **Reserve floor supremacy:** The reserve cannot be drawn down to fund buybacks.
  The reserve exists to protect operational continuity, not to maximize token purchasing.

- **Transparency by default:** Every evaluation — executed or skipped — is logged.
  There is no concept of a "silent" buyback or a "private" treasury operation.

---

## Reason Code Reference

| Code | Meaning |
|------|---------|
| `BUYBACK_WINDOW_OPEN` | All gates passed; buyback execution authorized |
| `BUYBACK_WINDOW_CLOSED` | Policy flag is disabled |
| `BUYBACK_EXECUTED` | Buyback completed successfully |
| `BUYBACK_SKIPPED_LIQUIDITY` | Market liquidity below minimum threshold |
| `BUYBACK_SKIPPED_VOLATILITY` | Token volatility above threshold |
| `BUYBACK_SKIPPED_RESERVE` | Reserve bucket below floor; operation blocked |
| `BUYBACK_SKIPPED_COOLDOWN` | Within cooldown window from last execution |
| `BUYBACK_BUDGET_EXHAUSTED` | Epoch spending cap reached |
| `BUYBACK_COOLDOWN_ACTIVE` | Cooldown period in effect |
| `EXECUTION_SIMULATION_ONLY` | Executed in simulation mode; no real transaction |
| `TREASURY_RESERVE_PROTECTED` | Reserve floor enforcement applied |

---

## Configuration Reference

| Parameter | Default | Description |
|-----------|---------|-------------|
| `BUYBACK_ENABLED` | `true` | Master on/off switch |
| `BUYBACK_EPOCH_HOURS` | `24` | Epoch window for spend cap |
| `BUYBACK_MAX_SPEND_PER_EPOCH_SOL` | `2.0` | Max SOL per epoch |
| `BUYBACK_MIN_LIQUIDITY_SOL` | `50.0` | Min market liquidity |
| `BUYBACK_VOLATILITY_THRESHOLD` | `0.08` | Max allowed 24h vol |
| `BUYBACK_COOLDOWN_HOURS` | `6` | Min interval between executions |
| `TREASURY_RESERVE_FLOOR_SOL` | `20.0` | Reserve floor (absolute) |

---

*This document is generated from the AIVA codebase and reflects the current implementation.
It is not a legal document, prospectus, or financial product disclosure. AIVA token holders
should not rely on this document as a basis for investment decisions.*
