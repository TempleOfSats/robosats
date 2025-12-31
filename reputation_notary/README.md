# RoboSats Reputation Notary (operator notes)

This folder contains the **notary aggregator service** (`reputation_notary/main.py`).

Running a notary requires:

1) A nostr **relay** (e.g. strfry) reachable by coordinators and clients.
2) This **aggregator process**, which:
   - subscribes to coordinator success receipts (`kind:38384`)
   - subscribes to coordinator scam reports (`kind:38386`)
   - subscribes to gift-wrapped link messages to the notary (`kind:1059`)
   - publishes buyer badge assertions (`kind:38385`)
   - responds to client stats requests (gift-wrapped) with an encrypted successful-BUY count (owner-only, cross-device)

## Environment variables

- `NOTARY_NSEC` (required): notary private key (keep secret)
- `NOTARY_RELAY_URL` or `NOTARY_RELAY_URLS` (required): relay websocket URL(s), comma-separated for `_URLS`
- `FEDERATION_JSON_PATH` (optional, default `frontend/static/federation.json`): coordinator allowlist source (expects `nostrHexPubkey` fields)
- `NOTARY_DB_PATH` (optional, default `notary.sqlite3`): sqlite path
- `NOTARY_SINCE_SECS` (optional, default `0`): initial `since` filter (unix seconds)
- `NOTARY_GIFTWRAP_SINCE_SECS` (optional, default `0`): `since` filter for giftwrap subscription (should be old; giftwrap events may be backdated)
- `NOTARY_DEBUG` (optional, default `0`): set to `1` to log receipts/links/badges as they are processed

## Run

```bash
export NOTARY_NSEC='nsec1...'
export NOTARY_RELAY_URL='wss://your-notary-relay.example/relay/'
export NOTARY_DB_PATH='/var/lib/robosats-notary/notary.sqlite3'
python reputation_notary/main.py
```

## Relay policy (recommended)

To reduce spam/spoofing, configure your relay write policy to:

- accept `kind:38384` only from trusted coordinator pubkeys
- accept `kind:38386` only from trusted coordinator pubkeys
- accept `kind:38385` only from the notary pubkey
- accept `kind:1059` (giftwrap) from anyone (clients)
