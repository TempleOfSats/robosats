#!/usr/bin/env python3
"""
Seed a demo buyer reputation identity into a RoboSats notary relay.

Use-case: you want to see Buyer badges in the browser without completing real trades.

What it does:
1) Generates (or uses) a master key (nsec) = the portable reputation identity.
2) Generates an ephemeral key and links it to the master via NIP-59 giftwrap messages to the notary.
3) Publishes coordinator-signed success receipts (kind 38384) for that ephemeral pubkey.
4) Optionally publishes a scam report (kind 38386) for that ephemeral pubkey.

Once seeded, import the printed master nsec in the UI:
Garage -> (medal icon) -> Reputation -> Import.

Then do any BUY action; the app will link the new ephemeral pubkey to the master and the notary will
publish a badge for that trade.
"""

import argparse
import asyncio
import inspect
import json
import time
import uuid
from pathlib import Path

from nostr_sdk import (
    Alphabet,
    Client,
    Event,
    EventBuilder,
    Filter,
    HandleNotification,
    Keys,
    Kind,
    NostrSigner,
    PublicKey,
    SingleLetterTag,
    Tag,
    Timestamp,
    gift_wrap,
)

try:
    # nostr_sdk >= 0.43 exposes RelayUrl; older versions don't.
    from nostr_sdk import RelayUrl  # type: ignore
except Exception:  # pragma: no cover
    RelayUrl = None  # type: ignore


RECEIPT_KIND = 38384
BADGE_KIND = 38385
REPORT_KIND = 38386

LINK_REQUEST_TYPE = "robosats.reputation.link.request.v1"
LINK_CONFIRM_TYPE = "robosats.reputation.link.confirm.v1"

DEFAULT_RELAY_URL = "ws://127.0.0.1:7778"


def _tier_from_success_count_and_age(success_count: int, first_days: int) -> str:
    if success_count > 30 and first_days >= 120:
        return "experienced"
    if success_count > 10 and first_days >= 90:
        return "intermediate"
    if success_count > 5:
        return "beginner"
    return "none"


def _validate_hex_pubkey(value: str) -> str:
    v = (value or "").strip()
    if v.lower().startswith("nsec1"):
        raise argparse.ArgumentTypeError("Got an nsec, use --notary-nsec instead of --notary-pubkey")
    try:
        return PublicKey.parse(v).to_hex().lower()
    except Exception as e:
        raise argparse.ArgumentTypeError("Expected a nostr pubkey (64-hex or npub1...)") from e


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _write_reputation_notary_config(*, repo_root: Path, network: str, relay_url: str, notary_pubkey_hex: str) -> Path:
    path = repo_root / "frontend/static/reputation_notary.json"
    data = json.loads(path.read_text())
    if network not in data or not isinstance(data[network], dict):
        data[network] = {}
    data[network]["relayUrl"] = relay_url
    data[network]["nostrHexPubkey"] = notary_pubkey_hex
    path.write_text(json.dumps(data, indent=2) + "\n")
    return path


def _write_federation_json(*, out_path: Path, coord_pubkey_hex: str) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = {"local_seed": {"nostrHexPubkey": coord_pubkey_hex}}
    out_path.write_text(json.dumps(data, indent=2) + "\n")
    return out_path


async def _send_event_with_timeout(client: Client, event: Event, *, io_timeout_secs: int, purpose: str) -> None:
    try:
        await asyncio.wait_for(client.send_event(event), timeout=io_timeout_secs)
    except asyncio.TimeoutError as e:
        raise RuntimeError(
            f"Timed out waiting for relay ACK while {purpose}. "
            "Is the relay reachable and accepting writes?"
        ) from e


class _Collector(HandleNotification):
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self.queue: asyncio.Queue[tuple[str, Event]] = asyncio.Queue()

    async def handle(self, relay_url, subscription_id: str, event: Event) -> bool:
        self._loop.call_soon_threadsafe(self.queue.put_nowait, (subscription_id, event))
        return False

    async def handle_msg(self, relay_url, msg) -> bool:
        return False


async def _connect(relay_url: str, signer_keys: Keys, io_timeout_secs: int) -> Client:
    client = Client(NostrSigner.keys(signer_keys))
    try:
        if RelayUrl is not None:
            res = client.add_relay(RelayUrl.parse(relay_url))
        else:
            res = client.add_relay(relay_url)
    except TypeError:
        res = client.add_relay(relay_url)
    if inspect.isawaitable(res):
        await res
    await asyncio.wait_for(client.connect(), timeout=io_timeout_secs)
    return client


async def _send_link_handshake(
    client: Client,
    *,
    relay_url: str,
    notary_pubkey_hex: str,
    ephemeral: Keys,
    master: Keys,
    io_timeout_secs: int,
):
    notary_pk = PublicKey.parse(notary_pubkey_hex)
    created_at = int(time.time())

    request_payload = json.dumps(
        {
            "type": LINK_REQUEST_TYPE,
            "master_pubkey": master.public_key().to_hex().lower(),
            "ephemeral_pubkey": ephemeral.public_key().to_hex().lower(),
            "created_at": created_at,
        }
    )
    rumor_req = EventBuilder.private_msg_rumor(notary_pk, request_payload).build(ephemeral.public_key())
    gw_req = await gift_wrap(NostrSigner.keys(ephemeral), notary_pk, rumor_req, [Tag.parse(["p", notary_pubkey_hex, relay_url])])
    await _send_event_with_timeout(client, gw_req, io_timeout_secs=io_timeout_secs, purpose="sending link request")

    confirm_payload = json.dumps(
        {
            "type": LINK_CONFIRM_TYPE,
            "ephemeral_pubkey": ephemeral.public_key().to_hex().lower(),
            "created_at": created_at,
        }
    )
    rumor_conf = EventBuilder.private_msg_rumor(notary_pk, confirm_payload).build(master.public_key())
    gw_conf = await gift_wrap(NostrSigner.keys(master), notary_pk, rumor_conf, [Tag.parse(["p", notary_pubkey_hex, relay_url])])
    await _send_event_with_timeout(client, gw_conf, io_timeout_secs=io_timeout_secs, purpose="sending link confirm")


async def _send_receipts(
    client: Client,
    *,
    relay_url: str,
    coord_keys: Keys,
    buyer_pubkey_hex: str,
    network: str,
    count: int,
    first_days: int,
    io_timeout_secs: int,
):
    now = int(time.time())
    first_ts = now - int(first_days) * 86400

    for i in range(count):
        created_at = first_ts if i == 0 else now
        tags = [
            Tag.parse(["d", str(uuid.uuid4())]),
            Tag.parse(["p", buyer_pubkey_hex]),
            Tag.parse(["net", network]),
            Tag.parse(["v", "1"]),
        ]
        ev = (
            EventBuilder(Kind(RECEIPT_KIND), "")
            .custom_created_at(Timestamp.from_secs(created_at))
            .tags(tags)
            .sign_with_keys(coord_keys)
        )
        await _send_event_with_timeout(client, ev, io_timeout_secs=io_timeout_secs, purpose=f"sending receipt {i+1}/{count} to {relay_url}")


async def _send_report(
    client: Client,
    *,
    relay_url: str,
    coord_keys: Keys,
    buyer_pubkey_hex: str,
    network: str,
    note: str,
    io_timeout_secs: int,
):
    tags = [
        Tag.parse(["d", f"{network}:{buyer_pubkey_hex}"]),
        Tag.parse(["p", buyer_pubkey_hex]),
        Tag.parse(["net", network]),
        Tag.parse(["report", "scammer"]),
        Tag.parse(["v", "1"]),
    ]
    ev = EventBuilder(Kind(REPORT_KIND), note or "").tags(tags).sign_with_keys(coord_keys)
    await _send_event_with_timeout(client, ev, io_timeout_secs=io_timeout_secs, purpose=f"sending scam report to {relay_url}")


async def _wait_badge(
    *,
    relay_url: str,
    notary_pubkey_hex: str,
    buyer_pubkey_hex: str,
    network: str,
    expected_tier: str,
    expected_reported: bool,
    io_timeout_secs: int,
    timeout_secs: int,
) -> None:
    reader = await _connect(relay_url, Keys.generate(), io_timeout_secs)
    collector = _Collector(asyncio.get_running_loop())
    res = reader.handle_notifications(collector)
    # nostr_sdk has shipped both sync and async variants; the async one runs forever.
    if inspect.isawaitable(res):
        asyncio.create_task(res)

    buyer_pubkey_hex = buyer_pubkey_hex.lower()
    notary_pubkey_hex = notary_pubkey_hex.lower()
    network = network.lower()

    sub_id = f"seed-demo-{buyer_pubkey_hex[:8]}"
    since_window_secs = max(600, timeout_secs + 60)
    since = Timestamp.from_secs(int(time.time()) - since_window_secs)
    filt = (
        Filter()
        .kinds([Kind(BADGE_KIND)])
        .since(since)
        .limit(200)
    )
    await asyncio.wait_for(reader.subscribe_with_id(sub_id, filt), timeout=io_timeout_secs)

    deadline = time.time() + timeout_secs
    saw_any_badge = False
    last_seen: dict[str, object] = {}
    while time.time() < deadline:
        remaining = max(0.1, deadline - time.time())
        try:
            sid, ev = await asyncio.wait_for(collector.queue.get(), timeout=remaining)
        except asyncio.TimeoutError:
            break

        if sid != sub_id:
            continue
        if ev.author().to_hex().lower() != notary_pubkey_hex:
            continue
        p = next((t.as_vec()[1] for t in ev.tags().to_vec() if len(t.as_vec()) >= 2 and t.as_vec()[0] == "p"), None)
        if (p or "").lower() != buyer_pubkey_hex:
            continue
        net = next((t.as_vec()[1] for t in ev.tags().to_vec() if len(t.as_vec()) >= 2 and t.as_vec()[0] == "net"), "mainnet")
        if (net or "mainnet").lower() != network:
            continue
        tier = next((t.as_vec()[1] for t in ev.tags().to_vec() if len(t.as_vec()) >= 2 and t.as_vec()[0] == "tier"), "none")
        reported = next((t.as_vec()[1] for t in ev.tags().to_vec() if len(t.as_vec()) >= 2 and t.as_vec()[0] == "reported"), "")
        is_reported = reported in ("1", "true")

        last_seen = {"tier": tier, "reported": is_reported, "net": net, "p": p}
        if not saw_any_badge:
            saw_any_badge = True
            print(f"Observed badge from notary: tier={tier} reported={is_reported}")

        if tier == expected_tier and (not expected_reported or is_reported):
            await reader.unsubscribe_all()
            await reader.disconnect()
            return

    await reader.unsubscribe_all()
    await reader.disconnect()
    if saw_any_badge and last_seen:
        raise RuntimeError(
            "Timed out waiting for a matching badge tier from the notary. "
            f"Last badge seen: {last_seen}. "
            "This usually means the notary did not count your receipts (coordinator not trusted), "
            "or the age gate prevented the tier upgrade. "
            "Tip: re-run with --no-wait-badge to just publish events, or increase --timeout-secs."
        )
    raise RuntimeError(
        "Timed out waiting for any matching badge event from the notary. "
        "Make sure the notary aggregator is running, the relay URL is correct, "
        "and the notary is actually publishing kind 38385. "
        "Tip: re-run with --no-wait-badge to just publish events, or increase --timeout-secs."
    )


async def _run(args: argparse.Namespace) -> int:
    coord_keys = Keys.parse(args.coord_nsec)
    coord_pubkey_hex = coord_keys.public_key().to_hex().lower()
    if args.notary_nsec:
        notary_pk = Keys.parse(args.notary_nsec).public_key()
    else:
        notary_pk = PublicKey.parse(args.notary_pubkey.lower())
    notary_pubkey_hex = notary_pk.to_hex().lower()

    if args.master_nsec:
        master = Keys.parse(args.master_nsec)
    else:
        master = Keys.generate()

    ephemeral = Keys.generate()
    buyer_pubkey_hex = ephemeral.public_key().to_hex().lower()

    expected_tier = _tier_from_success_count_and_age(args.count, args.first_days)

    print("\nDemo identity:")
    print(f"  relay_url: {args.relay_url}")
    print(f"  coordinator_pubkey_hex: {coord_pubkey_hex}")
    print(f"  coordinator_npub: {coord_keys.public_key().to_bech32()}")
    print(f"  notary_pubkey_hex: {notary_pubkey_hex}")
    print(f"  notary_npub: {notary_pk.to_bech32()}")
    print(f"  master_npub: {master.public_key().to_bech32()}")
    print(f"  master_nsec: {master.secret_key().to_bech32()}")
    print(f"  seeded_ephemeral_pubkey_hex: {buyer_pubkey_hex}")
    print(f"  expected_tier: {expected_tier}  (count={args.count}, first_days={args.first_days})")
    if args.report:
        print("  expected_reported: true")
    print("")

    writer = await _connect(args.relay_url, coord_keys, args.io_timeout_secs)

    # Seed receipts first, then link; on link finalization the notary publishes a badge for this pubkey.
    await _send_receipts(
        writer,
        relay_url=args.relay_url,
        coord_keys=coord_keys,
        buyer_pubkey_hex=buyer_pubkey_hex,
        network=args.network,
        count=args.count,
        first_days=args.first_days,
        io_timeout_secs=args.io_timeout_secs,
    )
    await _send_link_handshake(
        writer,
        relay_url=args.relay_url,
        notary_pubkey_hex=notary_pubkey_hex,
        ephemeral=ephemeral,
        master=master,
        io_timeout_secs=args.io_timeout_secs,
    )
    if args.report:
        await _send_report(
            writer,
            relay_url=args.relay_url,
            coord_keys=coord_keys,
            buyer_pubkey_hex=buyer_pubkey_hex,
            network=args.network,
            note=args.report_note,
            io_timeout_secs=args.io_timeout_secs,
        )

    await writer.disconnect()

    if args.wait_badge:
        await _wait_badge(
            relay_url=args.relay_url,
            notary_pubkey_hex=notary_pubkey_hex,
            buyer_pubkey_hex=buyer_pubkey_hex,
            network=args.network,
            expected_tier=expected_tier,
            expected_reported=args.report,
            io_timeout_secs=args.io_timeout_secs,
            timeout_secs=args.timeout_secs,
        )
        print("Badge event observed on relay.")

    repo_root = _repo_root()

    if args.quick_setup or args.write_frontend_config:
        updated = _write_reputation_notary_config(
            repo_root=repo_root,
            network=args.network,
            relay_url=args.relay_url,
            notary_pubkey_hex=notary_pubkey_hex,
        )
        print(f"\nUpdated frontend notary config: {updated}")

    federation_out = None
    if args.federation_json_out:
        federation_out = _write_federation_json(out_path=Path(args.federation_json_out), coord_pubkey_hex=coord_pubkey_hex)
        print(f"\nWrote notary federation allowlist: {federation_out}")
    elif args.quick_setup:
        federation_out = _write_federation_json(
            out_path=repo_root / "scripts/reputation_seed_federation.json",
            coord_pubkey_hex=coord_pubkey_hex,
        )
        print(f"\nWrote notary federation allowlist: {federation_out}")

    print("\nNext steps (browser):")
    if not (args.quick_setup or args.write_frontend_config):
        print("  1) Set frontend/static/reputation_notary.json relayUrl + nostrHexPubkey (notary pubkey).")
        print(f"     - relayUrl: {args.relay_url}")
        print(f"     - nostrHexPubkey: {notary_pubkey_hex}")
    else:
        print("  1) Frontend notary config already updated by this script.")
    print("  2) In UI: Garage -> medal icon -> Reputation -> Import the master_nsec above.")
    print("  3) Create/take a BUY order and reload the order page; Buyer badge should show the tier.")
    print("")

    if federation_out:
        print("Next steps (notary service allowlist):")
        print(f"  - export FEDERATION_JSON_PATH='{federation_out}'")
        print("  - run: python reputation_notary/main.py")
    else:
        print("Next steps (notary service allowlist):")
        print("  - The notary only trusts coordinator pubkeys from FEDERATION_JSON_PATH.")
        print("  - Minimal federation JSON for this coordinator:")
        print(json.dumps({"local_seed": {"nostrHexPubkey": coord_pubkey_hex}}, indent=2))
        print("")
        print("  - Then run notary with:")
        print("      export FEDERATION_JSON_PATH='/path/to/that.json'")
        print("      python reputation_notary/main.py")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--relay-url", default=DEFAULT_RELAY_URL, help=f"ws(s)://... nostr relay URL (default {DEFAULT_RELAY_URL})")
    parser.add_argument("--network", default="mainnet", choices=["mainnet", "testnet"])
    notary = parser.add_mutually_exclusive_group(required=True)
    notary.add_argument("--notary-nsec", default=None, help="Notary private key (nsec...) (pubkey is derived automatically)")
    notary.add_argument("--notary-pubkey", default=None, type=_validate_hex_pubkey, help="Notary pubkey (hex or npub)")
    parser.add_argument("--coord-nsec", required=True, help="Coordinator private key (nsec...) used to sign receipts")
    parser.add_argument("--master-nsec", default="", help="Optional master identity to use (nsec...)")
    parser.add_argument("--count", type=int, default=31, help="How many success receipts to seed")
    parser.add_argument("--first-days", type=int, default=130, help="Backdate the first receipt by N days (age gate)")
    parser.add_argument("--report", action="store_true", help="Also publish a scam report and expect reported=1")
    parser.add_argument("--report-note", default="", help="Optional scam report note (content)")
    parser.add_argument(
        "--quick-setup",
        action="store_true",
        help="Also write frontend/static/reputation_notary.json and scripts/reputation_seed_federation.json",
    )
    parser.add_argument(
        "--write-frontend-config",
        action="store_true",
        help="Write frontend/static/reputation_notary.json for the selected network",
    )
    parser.add_argument(
        "--federation-json-out",
        default=None,
        help="Write a minimal federation.json allowlist for the notary at this path",
    )
    parser.add_argument(
        "--no-wait-badge",
        action="store_false",
        dest="wait_badge",
        default=True,
        help="Do not wait for the badge event to appear on the relay",
    )
    parser.add_argument(
        "--io-timeout-secs",
        type=int,
        default=15,
        help="Timeout for relay IO (connect/send/subscribe)",
    )
    parser.add_argument("--timeout-secs", type=int, default=20, help="Wait timeout for badge event")
    args = parser.parse_args()

    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
