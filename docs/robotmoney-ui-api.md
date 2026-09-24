# RobotMoney UI API Additions

This note covers the API surfaces added for RobotMoney Inbox and money movement UI work.

## Accounts

The existing Ledger account and transaction endpoints remain the source for account rails. `GET /v1/ledger/accounts` lists accounts with balances. `GET /v1/ledger/accounts/{account_id}` reads account detail, and `GET /v1/ledger/transactions?account_id=...` pages recent activity. `POST /v1/ledger/deposit-instructions` returns tenant-scoped deposit instructions for ACH, wire, or on-chain receive flows.

## Money Movement

Outbound sends continue through `POST /v1/payment-intents`. The `exchange` action type adds optional quote metadata with `rate_lock_reference` and `destination_currency`, without changing approval semantics. `POST /v1/exchange/quote` creates a tenant-scoped quote row for UI rate lock display. `POST /v1/actions` accepts `invoice_link` to create a receivable invoice link without creating a PaymentIntent.

## Business Profile

`GET /v1/tenant/profile` and `PATCH /v1/tenant/profile` read and upsert legal name, DBA name, address, tax id, industry, jurisdiction, and fiscal year end. The table is tenant scoped with RLS and all fields are optional.

## Contacts

`/v1/contacts` is a UI alias over ledger counterparties. It supports list, create, read, update, and archive. Archive is implemented as `status = archived` with `deleted_at`, so existing ledger references remain intact.

## Settings

`/v1/tenant/notification-preferences` stores assistant proactive preference fields. `/v1/auth/two-factor` exposes per-user method state and enrollment helpers. `/v1/auth/trusted-devices` lists and revokes trusted devices. These tables are tenant scoped and user rows are filtered by authenticated principal.

## Agents Overview

`GET /v1/agents/overview` returns the 12 RobotMoney agents with authority summary from the internal agent catalog, active rule counts from `agent_authority_rules`, weekly proposal counts from `proposals`, and last activity from proposal or audit rows.

## Global Search

`POST /v1/search` searches proposals, Robo threads, accounts, contacts, and audit decision events with a bounded tenant-scoped query. It returns display rows with kind, id, title, optional subtitle, reference URL, and score.

## Migration

All new fields and tables are additive. Existing clients are unaffected. PaymentIntent approval authority, decision policy, and PaymentIntent status semantics are unchanged.
