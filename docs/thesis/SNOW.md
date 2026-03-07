# Snowflake Inc (SNOW)

**Tier:** Watchlist
**Accounts:** Schwab 6196 (1 share)
**Cost Basis:** $196.02
**Last Updated:** 2026-03-06

## Thesis

Tracking position. Cloud data platform — monitoring but conviction has weakened.

Snowflake is the leading cloud data warehouse. Consumption-based model means revenue scales with customer data usage. Originally had a thesis that Cortex AI (running AI agents inside the data warehouse) would be a hit product. After watching their demos and trying it firsthand, **the product thesis is wrong**.

The Cortex approach is: run LLM inference co-located with data to avoid moving data out. But the real problem isn't "run inference on single records 1B times" — that's costly and misses the point. The real value of AI + data warehousing is an agent that **reflectively generates the next SQL query to unlock the insight**. Snowflake's data warehouse remains the right machinery for distributed computing at TB-to-PB scale. But the AI agent layer? That doesn't need to live inside the warehouse. The problem was never "it's costly to move data out, so run compute co-located." The problem is knowing **what queries to run in the first place**.

**Why keep tracking:** As enterprises adopt AI, they increasingly need to run inferences on data that lives in the warehouse. That drives compute consumption — Snowflake's money engine. Cortex AI and integrations with foundation model labs (OpenAI, Anthropic, etc.) are catalysts and friction smoothers, not the core value. The core value is that AI adoption = more warehouse compute = more Snowflake revenue, regardless of who builds the AI agent layer.

## Invalidation Framework

### Watch For
- Consumption growth reaccelerating (AI-driven compute uplift)
- Enterprise AI adoption driving measurable warehouse usage increases
- Databricks competition eating share
- Partnerships with foundation model labs (friction reduction for AI workflows)

### Exit If
- Consumption model continues to slow despite AI adoption wave
- No differentiation vs Databricks emerging
- AI workloads run outside the warehouse (data moves to the model, not model to the data)

## Risk Notes

- 1 share = pure tracking. No meaningful capital at risk
- Watching to see if this earns a real position or gets dropped

## Decision Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-06 | Documented | 1-share tracking position, monitoring consumption trends |
