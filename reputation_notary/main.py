import asyncio
import inspect
import json
import os
import signal
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

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
    UnwrappedGift,
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
GIFT_WRAP_KIND = 1059

LINK_REQUEST_TYPE = "robosats.reputation.link.request.v1"
LINK_CONFIRM_TYPE = "robosats.reputation.link.confirm.v1"
STATS_REQUEST_TYPE = "robosats.reputation.stats.request.v1"
STATS_RESPONSE_TYPE = "robosats.reputation.stats.response.v1"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _is_hex_pubkey(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if len(value) != 64:
        return False
    v = value.lower()
    return all(c in "0123456789abcdef" for c in v)


def _tier_from_success_count_and_age(success_count: int, first_success_at: Optional[int], now: int) -> str:
    age_days = 0
    if first_success_at:
        age_days = max(0, int((now - first_success_at) / 86400))

    if success_count > 30 and age_days >= 120:
        return "experienced"
    if success_count > 10 and age_days >= 90:
        return "intermediate"
    if success_count > 5:
        return "beginner"
    return "none"


@dataclass(frozen=True)
class NotaryConfig:
    nsec: str
    relay_urls: list[str]
    trusted_coordinator_pubkeys: set[str]
    db_path: Path
    since_secs: int
    giftwrap_since_secs: int
    io_timeout_secs: int


class NotaryStore:
    def __init__(self, db_path: Path):
        self._conn = sqlite3.connect(str(db_path))
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS links (
              ephemeral_pubkey TEXT PRIMARY KEY,
              master_pubkey TEXT NOT NULL,
              linked_at INTEGER NOT NULL
            );
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_link_requests (
              ephemeral_pubkey TEXT PRIMARY KEY,
              master_pubkey TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_link_confirms (
              ephemeral_pubkey TEXT PRIMARY KEY,
              master_pubkey TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS receipts (
              receipt_key TEXT PRIMARY KEY,
              coordinator_pubkey TEXT NOT NULL,
              buyer_pubkey TEXT NOT NULL,
              network TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
              report_key TEXT PRIMARY KEY,
              coordinator_pubkey TEXT NOT NULL,
              buyer_pubkey TEXT NOT NULL,
              network TEXT NOT NULL,
              report TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_receipts_buyer_net ON receipts(buyer_pubkey, network);"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_links_master ON links(master_pubkey);"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_buyer_net ON reports(buyer_pubkey, network);"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_reports_coord ON reports(coordinator_pubkey);"
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def upsert_receipt(
        self,
        receipt_key: str,
        coordinator_pubkey: str,
        buyer_pubkey: str,
        network: str,
        created_at: int,
    ) -> bool:
        cur = self._conn.cursor()
        cur.execute(
            """
            INSERT OR IGNORE INTO receipts(receipt_key, coordinator_pubkey, buyer_pubkey, network, created_at)
            VALUES(?, ?, ?, ?, ?);
            """,
            (receipt_key, coordinator_pubkey, buyer_pubkey, network, created_at),
        )
        inserted = cur.rowcount > 0
        self._conn.commit()
        return inserted

    def upsert_report(
        self,
        coordinator_pubkey: str,
        buyer_pubkey: str,
        network: str,
        report: str,
        created_at: int,
    ) -> bool:
        report_key = f"{coordinator_pubkey}:{network}:{buyer_pubkey}:{report}"
        cur = self._conn.cursor()
        cur.execute(
            """
            INSERT OR IGNORE INTO reports(report_key, coordinator_pubkey, buyer_pubkey, network, report, created_at)
            VALUES(?, ?, ?, ?, ?, ?);
            """,
            (report_key, coordinator_pubkey, buyer_pubkey, network, report, created_at),
        )
        inserted = cur.rowcount > 0
        self._conn.commit()
        return inserted

    def get_master_for_ephemeral(self, ephemeral_pubkey: str) -> Optional[str]:
        cur = self._conn.cursor()
        cur.execute("SELECT master_pubkey FROM links WHERE ephemeral_pubkey = ?;", (ephemeral_pubkey,))
        row = cur.fetchone()
        return row[0] if row else None

    def is_ephemeral_reported(self, ephemeral_pubkey: str) -> bool:
        cur = self._conn.cursor()
        cur.execute("SELECT 1 FROM reports WHERE buyer_pubkey = ? LIMIT 1;", (ephemeral_pubkey,))
        return cur.fetchone() is not None

    def is_master_reported(self, master_pubkey: str) -> bool:
        cur = self._conn.cursor()
        cur.execute(
            """
            SELECT 1
            FROM reports r
            JOIN links l ON l.ephemeral_pubkey = r.buyer_pubkey
            WHERE l.master_pubkey = ?
            LIMIT 1;
            """,
            (master_pubkey,),
        )
        return cur.fetchone() is not None

    def list_ephemerals_for_master(self, master_pubkey: str) -> list[str]:
        cur = self._conn.cursor()
        cur.execute("SELECT ephemeral_pubkey FROM links WHERE master_pubkey = ?;", (master_pubkey,))
        return [row[0] for row in cur.fetchall()]

    def upsert_pending_request(self, ephemeral_pubkey: str, master_pubkey: str, created_at: int) -> None:
        self._conn.execute(
            """
            INSERT INTO pending_link_requests(ephemeral_pubkey, master_pubkey, created_at)
            VALUES(?, ?, ?)
            ON CONFLICT(ephemeral_pubkey) DO UPDATE SET master_pubkey=excluded.master_pubkey, created_at=excluded.created_at;
            """,
            (ephemeral_pubkey, master_pubkey, created_at),
        )
        self._conn.commit()

    def upsert_pending_confirm(self, ephemeral_pubkey: str, master_pubkey: str, created_at: int) -> None:
        self._conn.execute(
            """
            INSERT INTO pending_link_confirms(ephemeral_pubkey, master_pubkey, created_at)
            VALUES(?, ?, ?)
            ON CONFLICT(ephemeral_pubkey) DO UPDATE SET master_pubkey=excluded.master_pubkey, created_at=excluded.created_at;
            """,
            (ephemeral_pubkey, master_pubkey, created_at),
        )
        self._conn.commit()

    def try_finalize_link(self, ephemeral_pubkey: str) -> Optional[str]:
        cur = self._conn.cursor()
        cur.execute(
            """
            SELECT r.master_pubkey AS master_from_request, c.master_pubkey AS master_from_confirm
            FROM pending_link_requests r
            JOIN pending_link_confirms c ON c.ephemeral_pubkey = r.ephemeral_pubkey
            WHERE r.ephemeral_pubkey = ?;
            """,
            (ephemeral_pubkey,),
        )
        row = cur.fetchone()
        if not row:
            return None

        master_from_request, master_from_confirm = row
        if master_from_request != master_from_confirm:
            return None

        linked_at = int(Timestamp.now().as_secs())
        self._conn.execute(
            """
            INSERT INTO links(ephemeral_pubkey, master_pubkey, linked_at)
            VALUES(?, ?, ?)
            ON CONFLICT(ephemeral_pubkey) DO UPDATE SET master_pubkey=excluded.master_pubkey, linked_at=excluded.linked_at;
            """,
            (ephemeral_pubkey, master_from_request, linked_at),
        )
        self._conn.execute("DELETE FROM pending_link_requests WHERE ephemeral_pubkey = ?;", (ephemeral_pubkey,))
        self._conn.execute("DELETE FROM pending_link_confirms WHERE ephemeral_pubkey = ?;", (ephemeral_pubkey,))
        self._conn.commit()
        return master_from_request

    def success_count_for_master(self, master_pubkey: str, network: str) -> int:
        cur = self._conn.cursor()
        cur.execute(
            """
            SELECT COUNT(*)
            FROM receipts r
            JOIN links l ON l.ephemeral_pubkey = r.buyer_pubkey
            WHERE l.master_pubkey = ? AND r.network = ?;
            """,
            (master_pubkey, network),
        )
        row = cur.fetchone()
        return int(row[0]) if row else 0

    def first_success_at_for_master(self, master_pubkey: str, network: str) -> Optional[int]:
        cur = self._conn.cursor()
        cur.execute(
            """
            SELECT MIN(r.created_at)
            FROM receipts r
            JOIN links l ON l.ephemeral_pubkey = r.buyer_pubkey
            WHERE l.master_pubkey = ? AND r.network = ?;
            """,
            (master_pubkey, network),
        )
        row = cur.fetchone()
        return int(row[0]) if row and row[0] is not None else None


def _load_trusted_coordinator_pubkeys(path: Path) -> set[str]:
    data = json.loads(path.read_text())
    pubkeys: set[str] = set()
    for coord in data.values():
        pubkey = coord.get("nostrHexPubkey")
        if _is_hex_pubkey(pubkey):
            pubkeys.add(pubkey.lower())
    return pubkeys


def _parse_relay_urls() -> list[str]:
    urls = _env("NOTARY_RELAY_URLS")
    if urls:
        return [u.strip() for u in urls.split(",") if u.strip()]
    url = _env("NOTARY_RELAY_URL")
    return [url] if url else []


def load_config() -> NotaryConfig:
    nsec = _env("NOTARY_NSEC")
    if not nsec:
        raise RuntimeError("Missing NOTARY_NSEC")

    relay_urls = _parse_relay_urls()
    if len(relay_urls) == 0:
        raise RuntimeError("Missing NOTARY_RELAY_URL or NOTARY_RELAY_URLS")

    db_path = Path(_env("NOTARY_DB_PATH", "notary.sqlite3"))

    federation_json_path = Path(_env("FEDERATION_JSON_PATH", "frontend/static/federation.json"))
    trusted_coordinator_pubkeys = _load_trusted_coordinator_pubkeys(federation_json_path)
    if len(trusted_coordinator_pubkeys) == 0:
        raise RuntimeError(f"No trusted coordinator pubkeys loaded from {federation_json_path}")

    since_secs = int(_env("NOTARY_SINCE_SECS", "0"))
    # NIP-59 giftwrap events may be backdated by clients for privacy. Do NOT use a tight
    # recent `since` window for giftwrap, or you will miss link handshakes.
    giftwrap_since_secs = int(_env("NOTARY_GIFTWRAP_SINCE_SECS", "0"))
    io_timeout_secs = int(_env("NOTARY_IO_TIMEOUT_SECS", "15"))

    return NotaryConfig(
        nsec=nsec,
        relay_urls=relay_urls,
        trusted_coordinator_pubkeys=trusted_coordinator_pubkeys,
        db_path=db_path,
        since_secs=since_secs,
        giftwrap_since_secs=giftwrap_since_secs,
        io_timeout_secs=io_timeout_secs,
    )


def _get_tag_value(tags: list[list[str]], key: str) -> Optional[str]:
    for t in tags:
        if len(t) >= 2 and t[0] == key:
            return t[1]
    return None


class NotaryNotificationHandler(HandleNotification):
    def __init__(self, *, loop: asyncio.AbstractEventLoop, service: "NotaryService"):
        self._loop = loop
        self._service = service

    async def handle(self, relay_url, subscription_id: str, event: Event) -> bool:
        # nostr_sdk (UniFFI) awaits this callback. Keep it fast and never raise.
        try:
            self._loop.call_soon_threadsafe(asyncio.create_task, self._service.process_event(event))
        except Exception:
            # As a fallback (e.g. if the loop differs), schedule on the current loop.
            asyncio.create_task(self._service.process_event(event))
        return False

    async def handle_msg(self, relay_url, msg) -> bool:
        # unused
        return False


class NotaryService:
    def __init__(self, config: NotaryConfig):
        self._config = config
        self._store = NotaryStore(config.db_path)
        self._keys = Keys.parse(config.nsec)
        self._signer = NostrSigner.keys(self._keys)
        self._client = Client(self._signer)
        self._notifications_task: Optional[asyncio.Task] = None
        self._debug = _env("NOTARY_DEBUG", "0").lower() in ("1", "true", "yes", "y", "on")

    async def start(self) -> None:
        for url in self._config.relay_urls:
            try:
                if RelayUrl is not None:
                    res = self._client.add_relay(RelayUrl.parse(url))
                else:
                    res = self._client.add_relay(url)
            except TypeError:
                res = self._client.add_relay(url)
            if inspect.isawaitable(res):
                await res
        await asyncio.wait_for(self._client.connect(), timeout=self._config.io_timeout_secs)

        handler = NotaryNotificationHandler(loop=asyncio.get_running_loop(), service=self)
        res = self._client.handle_notifications(handler)
        # nostr_sdk has shipped both sync and async variants; the async one runs forever.
        if inspect.isawaitable(res):
            self._notifications_task = asyncio.create_task(res)

        since = Timestamp.from_secs(self._config.since_secs)
        giftwrap_since = Timestamp.from_secs(self._config.giftwrap_since_secs)

        receipt_filter = (
            Filter()
            .kinds([Kind(RECEIPT_KIND)])
            .authors([PublicKey.parse(p) for p in self._config.trusted_coordinator_pubkeys])
            .since(since)
        )
        report_filter = (
            Filter()
            .kinds([Kind(REPORT_KIND)])
            .authors([PublicKey.parse(p) for p in self._config.trusted_coordinator_pubkeys])
            .since(since)
        )
        # NOTE: giftwrap `created_at` is often backdated; use a separate (usually older) since.
        gift_filter = Filter().kinds([Kind(GIFT_WRAP_KIND)]).since(giftwrap_since)
        if not self._debug:
            gift_filter = gift_filter.custom_tag(
                SingleLetterTag.lowercase(Alphabet.P), self._keys.public_key().to_hex().lower()
            )

        await asyncio.wait_for(self._client.subscribe_with_id("receipts", receipt_filter), timeout=self._config.io_timeout_secs)
        await asyncio.wait_for(self._client.subscribe_with_id("reports", report_filter), timeout=self._config.io_timeout_secs)
        await asyncio.wait_for(self._client.subscribe_with_id("links", gift_filter), timeout=self._config.io_timeout_secs)

        notary_pubkey_hex = self._keys.public_key().to_hex().lower()
        try:
            notary_npub = self._keys.public_key().to_bech32()
        except Exception:
            notary_npub = ""

        print("Notary service running")
        print(f"  notary_pubkey_hex: {notary_pubkey_hex}")
        if notary_npub:
            print(f"  notary_npub: {notary_npub}")
        print(f"  relay_urls: {', '.join(self._config.relay_urls)}")
        print(f"  trusted_coordinator_pubkeys: {len(self._config.trusted_coordinator_pubkeys)}")
        print(f"  since_secs: {self._config.since_secs}")
        print(f"  giftwrap_since_secs: {self._config.giftwrap_since_secs}  (debug subscribes unfiltered)")

    async def stop(self) -> None:
        try:
            if self._notifications_task:
                self._notifications_task.cancel()
            await self._client.unsubscribe_all()
        except Exception:
            pass
        try:
            await self._client.disconnect()
        except Exception:
            pass
        self._store.close()

    async def process_event(self, event: Event) -> None:
        try:
            kind = int(event.kind().as_u16())
            if kind == RECEIPT_KIND:
                await self._process_receipt(event)
            elif kind == REPORT_KIND:
                await self._process_report(event)
            elif kind == GIFT_WRAP_KIND:
                await self._process_gift_wrap(event)
        except Exception as e:
            # Never bubble exceptions to the notification loop task.
            print(f"Error processing event: {e}")

    async def _process_receipt(self, event: Event) -> None:
        coordinator_pubkey = event.author().to_hex().lower()
        if coordinator_pubkey not in self._config.trusted_coordinator_pubkeys:
            return

        tags = [t.as_vec() for t in event.tags().to_vec()]
        d = _get_tag_value(tags, "d")
        buyer_pubkey = _get_tag_value(tags, "p")
        network = (_get_tag_value(tags, "net") or "mainnet").lower()

        if not d or not buyer_pubkey or not _is_hex_pubkey(buyer_pubkey):
            return
        buyer_pubkey = buyer_pubkey.lower()

        receipt_key = f"{coordinator_pubkey}:{d}"
        inserted = self._store.upsert_receipt(
            receipt_key=receipt_key,
            coordinator_pubkey=coordinator_pubkey,
            buyer_pubkey=buyer_pubkey,
            network=network,
            created_at=int(event.created_at().as_secs()),
        )
        if not inserted:
            return
        if self._debug:
            print(f"[receipt] net={network} buyer={buyer_pubkey[:8]}… coord={coordinator_pubkey[:8]}… d={d}")

        master = self._store.get_master_for_ephemeral(buyer_pubkey)
        if not master:
            return

        await self._publish_badge_for_ephemeral(buyer_pubkey, network, master_pubkey=master)

    async def _process_report(self, event: Event) -> None:
        coordinator_pubkey = event.author().to_hex().lower()
        if coordinator_pubkey not in self._config.trusted_coordinator_pubkeys:
            return

        tags = [t.as_vec() for t in event.tags().to_vec()]
        buyer_pubkey = _get_tag_value(tags, "p")
        network = (_get_tag_value(tags, "net") or "mainnet").lower()
        report = _get_tag_value(tags, "report") or "scammer"

        if not buyer_pubkey or not _is_hex_pubkey(buyer_pubkey):
            return

        buyer_pubkey = buyer_pubkey.lower()
        inserted = self._store.upsert_report(
            coordinator_pubkey=coordinator_pubkey,
            buyer_pubkey=buyer_pubkey,
            network=network,
            report=report,
            created_at=int(event.created_at().as_secs()),
        )
        if not inserted:
            return
        if self._debug:
            print(f"[report] net={network} buyer={buyer_pubkey[:8]}… coord={coordinator_pubkey[:8]}… report={report}")

        master = self._store.get_master_for_ephemeral(buyer_pubkey)
        if master:
            await self._publish_badges_for_master(master)
        else:
            # Publish for the reported pubkey even if it's not linked (tier will be "none", but flagged).
            for net in ("mainnet", "testnet"):
                await self._publish_badge_for_ephemeral(buyer_pubkey, net, master_pubkey=None)

    async def _process_gift_wrap(self, event: Event) -> None:
        if self._debug:
            try:
                tags = [t.as_vec() for t in event.tags().to_vec()]
                p = _get_tag_value(tags, "p")
                print(
                    f"[giftwrap] id={event.id().to_hex()[:8]}… created_at={int(event.created_at().as_secs())} p={(p or '')[:16]}…"
                )
            except Exception:
                pass
        try:
            maybe_unwrapped = UnwrappedGift.from_gift_wrap(self._signer, event)
            unwrapped = await maybe_unwrapped if inspect.isawaitable(maybe_unwrapped) else maybe_unwrapped
        except Exception:
            if self._debug:
                print("[giftwrap] failed to unwrap")
            return

        rumor = unwrapped.rumor()
        # Normalize to lowercase hex to avoid case-mismatch across nostr_sdk versions.
        sender_pubkey = rumor.author().to_hex().lower()
        content = rumor.content()

        try:
            payload = json.loads(content) if content else {}
        except Exception:
            return

        msg_type = payload.get("type")
        created_at = int(payload.get("created_at") or rumor.created_at().as_secs())

        if msg_type == LINK_REQUEST_TYPE:
            master_pubkey = payload.get("master_pubkey")
            if not _is_hex_pubkey(master_pubkey):
                return
            master_pubkey = master_pubkey.lower()
            ephemeral_pubkey = sender_pubkey
            self._store.upsert_pending_request(ephemeral_pubkey, master_pubkey, created_at)
            if self._debug:
                print(f"[link:req] eph={ephemeral_pubkey[:8]}… master={master_pubkey[:8]}…")
            master = self._store.try_finalize_link(ephemeral_pubkey)
            if master:
                if self._debug:
                    print(f"[link:final] eph={ephemeral_pubkey[:8]}… master={master[:8]}…")
                if self._store.is_master_reported(master):
                    await self._publish_badges_for_master(master)
                else:
                    await self._publish_badges_for_new_link(ephemeral_pubkey, master)
        elif msg_type == LINK_CONFIRM_TYPE:
            ephemeral_pubkey = payload.get("ephemeral_pubkey")
            if not _is_hex_pubkey(ephemeral_pubkey):
                return
            ephemeral_pubkey = ephemeral_pubkey.lower()
            master_pubkey = sender_pubkey
            self._store.upsert_pending_confirm(ephemeral_pubkey, master_pubkey, created_at)
            if self._debug:
                print(f"[link:conf] eph={ephemeral_pubkey[:8]}… master={master_pubkey[:8]}…")
            master = self._store.try_finalize_link(ephemeral_pubkey)
            if master:
                if self._debug:
                    print(f"[link:final] eph={ephemeral_pubkey[:8]}… master={master[:8]}…")
                if self._store.is_master_reported(master):
                    await self._publish_badges_for_master(master)
                else:
                    await self._publish_badges_for_new_link(ephemeral_pubkey, master)
        elif msg_type == STATS_REQUEST_TYPE:
            reply_pubkey = payload.get("reply_pubkey")
            if not _is_hex_pubkey(reply_pubkey):
                return
            reply_pubkey = reply_pubkey.lower()

            network = (payload.get("network") or "mainnet").lower()
            if network not in ("mainnet", "testnet"):
                return

            request_id = payload.get("request_id")
            if request_id is not None and not isinstance(request_id, str):
                return

            master_pubkey = sender_pubkey
            now = int(Timestamp.now().as_secs())
            count = self._store.success_count_for_master(master_pubkey, network)
            first_success_at = self._store.first_success_at_for_master(master_pubkey, network)
            reported = self._store.is_master_reported(master_pubkey)
            tier = _tier_from_success_count_and_age(count, first_success_at, now)

            await self._send_stats_response(
                reply_pubkey=reply_pubkey,
                network=network,
                success_count=count,
                first_success_at=first_success_at,
                tier=tier,
                reported=reported,
                request_id=request_id,
            )
            if self._debug:
                print(
                    f"[stats] net={network} master={master_pubkey[:8]}… count={count} tier={tier} reported={reported}"
                )

    async def _publish_badges_for_new_link(self, ephemeral_pubkey: str, master_pubkey: str) -> None:
        # Publish for both networks so clients can query on either.
        for network in ("mainnet", "testnet"):
            await self._publish_badge_for_ephemeral(ephemeral_pubkey, network, master_pubkey=master_pubkey)

    async def _publish_badges_for_master(self, master_pubkey: str) -> None:
        ephemerals = self._store.list_ephemerals_for_master(master_pubkey)
        for ephemeral in ephemerals:
            for network in ("mainnet", "testnet"):
                await self._publish_badge_for_ephemeral(ephemeral, network, master_pubkey=master_pubkey)

    async def _publish_badge_for_ephemeral(
        self, ephemeral_pubkey: str, network: str, master_pubkey: Optional[str] = None
    ) -> None:
        ephemeral_pubkey = ephemeral_pubkey.lower()
        network = network.lower()
        now = int(Timestamp.now().as_secs())

        reported = False
        count = 0
        first_success_at = None
        if master_pubkey:
            count = self._store.success_count_for_master(master_pubkey, network)
            first_success_at = self._store.first_success_at_for_master(master_pubkey, network)
            reported = self._store.is_master_reported(master_pubkey)
        else:
            reported = self._store.is_ephemeral_reported(ephemeral_pubkey)

        tier = (
            _tier_from_success_count_and_age(count, first_success_at, now)
            if master_pubkey
            else "none"
        )

        tags = [
            Tag.parse(["d", f"{network}:{ephemeral_pubkey}"]),
            Tag.parse(["p", ephemeral_pubkey]),
            Tag.parse(["tier", tier]),
            Tag.parse(["net", network]),
            Tag.parse(["v", "1"]),
        ]
        if reported:
            tags.append(Tag.parse(["reported", "1"]))
        event = EventBuilder(Kind(BADGE_KIND), "").tags(tags).sign_with_keys(self._keys)
        try:
            await asyncio.wait_for(self._client.send_event(event), timeout=self._config.io_timeout_secs)
        except asyncio.TimeoutError:
            # Don't block the whole service if a relay doesn't ACK.
            print(f"Timed out sending badge event for {ephemeral_pubkey} on {network}")
            return
        if self._debug:
            print(f"[badge] net={network} eph={ephemeral_pubkey[:8]}… tier={tier} reported={reported}")

    async def _send_stats_response(
        self,
        *,
        reply_pubkey: str,
        network: str,
        success_count: int,
        first_success_at: Optional[int],
        tier: str,
        reported: bool,
        request_id: Optional[str],
    ) -> None:
        receiver_pubkey_hex = reply_pubkey.lower()
        receiver_pk = PublicKey.parse(receiver_pubkey_hex)

        payload: dict[str, object] = {
            "type": STATS_RESPONSE_TYPE,
            "network": network,
            "success_count": success_count,
            "tier": tier,
            "reported": reported,
            "created_at": int(Timestamp.now().as_secs()),
        }
        if first_success_at is not None:
            payload["first_success_at"] = first_success_at
        if request_id is not None:
            payload["request_id"] = request_id

        rumor = EventBuilder.private_msg_rumor(receiver_pk, json.dumps(payload)).build(self._keys.public_key())
        relay_hint = self._config.relay_urls[0] if self._config.relay_urls else ""
        extra_tags = [Tag.parse(["p", receiver_pubkey_hex, relay_hint])] if relay_hint else [Tag.parse(["p", receiver_pubkey_hex])]
        maybe_wrapped = gift_wrap(self._signer, receiver_pk, rumor, extra_tags)
        wrapped = await maybe_wrapped if inspect.isawaitable(maybe_wrapped) else maybe_wrapped

        try:
            await asyncio.wait_for(self._client.send_event(wrapped), timeout=self._config.io_timeout_secs)
        except asyncio.TimeoutError:
            # Don't block the whole service if a relay doesn't ACK.
            if self._debug:
                print(f"Timed out sending stats response to {receiver_pubkey_hex[:8]}… on {network}")


async def _run() -> None:
    config = load_config()
    service = NotaryService(config)

    stop_event = asyncio.Event()

    def _stop(*_args):
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _stop)

    await service.start()
    await stop_event.wait()
    await service.stop()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
