---
name: trading
description: Use when the user wants to place, view, or cancel stock orders. Triggers on buy/sell/order requests like "sell 50 PLTR at 150", "buy 100 AAPL market", "show my orders", "cancel order".
---

# Trading Skill

Place, view, and cancel stock orders via Schwab using `pm-cli.sh`.

## Order Placement Flow

1. **Parse the request** — extract: action (buy/sell), quantity, symbol, order type (limit/market/stop), price, duration (DAY/GTC), and optional account hint (jia/monica/account number)
2. **Look up context** — run `./scripts/pm-cli.sh positions` to verify the position exists (for sells) and confirm account + current quantity
3. **Present order summary** to the user:

| Field | Value |
|-------|-------|
| Action | BUY/SELL |
| Symbol | PLTR |
| Quantity | 50 |
| Type | LIMIT @ $150.00 |
| Duration | DAY |
| Account | Name (number) |

4. **Ask for confirmation** — "Want me to submit this order?"
5. **Execute** — run the pm-cli.sh command with `--confirm` flag
6. **Report result** — show success/failure, suggest `pm-cli.sh orders` to verify

## Command Reference

```bash
# Limit orders
./scripts/pm-cli.sh sell 50 PLTR at 150 DAY
./scripts/pm-cli.sh buy 100 AAPL at 230 GTC monica

# Market orders
./scripts/pm-cli.sh sell 50 PLTR market DAY
./scripts/pm-cli.sh buy 100 AAPL market DAY

# Stop orders
./scripts/pm-cli.sh sell 50 PLTR stop 140 DAY

# View orders
./scripts/pm-cli.sh orders          # open/working orders
./scripts/pm-cli.sh orders all      # all orders (7 days)

# Cancel
./scripts/pm-cli.sh cancel-order <orderId>
```

## Account Resolution

- **Sells**: auto-resolved from which account holds the position
- **Buys**: defaults to Jia (8819), override with account name (`jia`, `monica`) or number
- If user mentions an account name, pass it as the last argument
- If symbol held in multiple accounts, user must specify

## Important Rules

- ALWAYS show order summary and get explicit user confirmation before executing
- Use `--confirm` flag when executing (skips CLI interactive prompt since user already confirmed in conversation)
- For sells, verify position exists and quantity is sufficient via `pm-cli.sh positions`
- Never place orders without explicit user approval
- After placing, run `./scripts/pm-cli.sh orders` to show confirmation
