import pygeohash
import hashlib
import uuid
import inspect

from secp256k1 import PrivateKey
from asgiref.sync import sync_to_async
from nostr_sdk import Keys, Client, EventBuilder, NostrSigner, Kind, Tag, PublicKey
from api.models import Order
from decouple import config

try:
    # nostr_sdk >= 0.43 exposes RelayUrl; older versions don't.
    from nostr_sdk import RelayUrl  # type: ignore
except Exception:  # pragma: no cover
    RelayUrl = None  # type: ignore


async def _add_relay(client: Client, url: str) -> None:
    """
    nostr_sdk compatibility shim:
    - Newer versions require a RelayUrl instance: RelayUrl.parse("ws(s)://...")
    - Older versions accept a plain string.
    """
    try:
        if RelayUrl is not None:
            res = client.add_relay(RelayUrl.parse(url))
        else:
            res = client.add_relay(url)
    except TypeError:
        res = client.add_relay(url)

    if inspect.isawaitable(res):
        await res


class Nostr:
    """Simple nostr events manager to be used as a cache system for clients"""

    async def send_order_event(self, order):
        """Creates the event and sends it to the coordinator relay"""

        # Publish only public orders
        if order.password is not None:
            return

        if config("NOSTR_NSEC", cast=str, default="") == "":
            return

        print("Sending nostr ORDER event")

        keys = Keys.parse(config("NOSTR_NSEC", cast=str))
        client = await self.initialize_client(keys)

        robot_name = await self.get_user_name(order)
        robot_hash_id = await self.get_robot_hash_id(order)
        currency = await self.get_robot_currency(order)

        content = order.description if order.description is not None else ""

        event = (
            EventBuilder(Kind(38383), content)
            .tags(self.generate_tags(order, robot_name, robot_hash_id, currency))
            .sign_with_keys(keys)
        )
        await client.send_event(event)
        print(f"Nostr ORDER event sent: {event.as_json()}")

    async def send_notification_event(self, robot, order, text):
        """Creates the notification event and sends it to the coordinator relay"""
        if config("NOSTR_NSEC", cast=str, default="") == "":
            return

        print("Sending nostr NOTIFICATION event")

        keys = Keys.parse(config("NOSTR_NSEC", cast=str))
        client = await self.initialize_client(keys)

        tags = [
            Tag.parse(
                [
                    "order_id",
                    f"{config('COORDINATOR_ALIAS', cast=str).lower()}/{order.id}",
                ]
            ),
            Tag.parse(["status", str(order.status)]),
        ]

        await client.send_private_msg(PublicKey.parse(robot.nostr_pubkey), text, tags)
        print("Nostr NOTIFICATION event sent")

    async def initialize_client(self, keys):
        # Initialize with coordinator Keys
        signer = NostrSigner.keys(keys)
        client = Client(signer)

        # Add relays and connect
        await _add_relay(client, "ws://localhost:7777")
        strfry_port = config("STRFRY_PORT", cast=str, default="7778")
        await _add_relay(client, f"ws://localhost:{strfry_port}")
        await client.connect()

        return client

    async def send_buyer_success_receipt(self, order):
        """
        Creates a buyer success receipt event and sends it to the notary relay.

        This is used for cross-coordinator buyer reputation badges.
        """
        if getattr(order, "is_swap", False):
            return

        if config("NOSTR_NSEC", cast=str, default="") == "":
            return

        notary_relays = self.get_notary_relays()
        if len(notary_relays) == 0:
            return

        buyer_pubkey = await self.get_buyer_nostr_pubkey(order)
        if not buyer_pubkey:
            return

        keys = Keys.parse(config("NOSTR_NSEC", cast=str))
        client = await self.initialize_notary_client(keys, notary_relays)

        network = str(config("NETWORK", cast=str))
        tags = [
            Tag.parse(["d", str(order.reference)]),
            Tag.parse(["p", str(buyer_pubkey)]),
            Tag.parse(["net", network]),
            Tag.parse(["v", "1"]),
        ]

        event = (
            EventBuilder(Kind(38384), "")
            .tags(tags)
            .sign_with_keys(keys)
        )
        await client.send_event(event)
        print(f"Nostr BUYER SUCCESS receipt sent: {event.as_json()}")

    async def send_buyer_scam_report(self, buyer_pubkey_hex: str, note: str = ""):
        """
        Creates a buyer scam report event and sends it to the notary relay.

        Coordinators can send this for any buyer ephemeral pubkey, even after a trade concluded.
        """
        if not buyer_pubkey_hex:
            return

        if config("NOSTR_NSEC", cast=str, default="") == "":
            return

        notary_relays = self.get_notary_relays()
        if len(notary_relays) == 0:
            return

        keys = Keys.parse(config("NOSTR_NSEC", cast=str))
        client = await self.initialize_notary_client(keys, notary_relays)

        network = str(config("NETWORK", cast=str))
        buyer_pubkey_hex = buyer_pubkey_hex.lower()
        tags = [
            Tag.parse(["d", f"{network}:{buyer_pubkey_hex}"]),
            Tag.parse(["p", buyer_pubkey_hex]),
            Tag.parse(["net", network]),
            Tag.parse(["report", "scammer"]),
            Tag.parse(["v", "1"]),
        ]

        event = (
            EventBuilder(Kind(38386), note or "")
            .tags(tags)
            .sign_with_keys(keys)
        )
        await client.send_event(event)
        print(f"Nostr BUYER SCAM report sent: {event.as_json()}")

    def get_notary_relays(self):
        relays_str = config("NOSTR_NOTARY_RELAY_URLS", cast=str, default="").strip()
        if relays_str:
            return [u.strip() for u in relays_str.split(",") if u.strip()]
        relay = config("NOSTR_NOTARY_RELAY_URL", cast=str, default="").strip()
        return [relay] if relay else []

    async def initialize_notary_client(self, keys, relays):
        signer = NostrSigner.keys(keys)
        client = Client(signer)
        for relay in relays:
            await _add_relay(client, relay)
        await client.connect()
        return client

    @sync_to_async
    def get_buyer_nostr_pubkey(self, order):
        if order.type == Order.Types.BUY:
            user = order.maker
        else:
            user = order.taker
        if not user:
            return None
        try:
            return str(user.robot.nostr_pubkey)
        except Exception:
            return None

    @sync_to_async
    def get_user_name(self, order):
        return order.maker.username

    @sync_to_async
    def get_robot_hash_id(self, order):
        return order.maker.robot.hash_id

    @sync_to_async
    def get_robot_currency(self, order):
        return str(order.currency)

    def generate_tags(self, order, robot_name, robot_hash_id, currency):
        hashed_id = hashlib.md5(
            f"{config('COORDINATOR_ALIAS', cast=str)}{order.id}".encode("utf-8")
        ).hexdigest()

        tags = [
            Tag.parse(["d", str(uuid.UUID(hashed_id))]),
            Tag.parse(["name", robot_name, robot_hash_id]),
            Tag.parse(["k", "sell" if order.type == Order.Types.SELL else "buy"]),
            Tag.parse(["f", currency]),
            Tag.parse(["s", self.get_status_tag(order)]),
            Tag.parse(["amt", "0"]),
            Tag.parse(
                ["fa"]
                + (
                    [str(order.amount)]
                    if not order.has_range
                    else [str(order.min_amount), str(order.max_amount)]
                )
            ),
            Tag.parse(["pm"] + order.payment_method.split(" ")),
            Tag.parse(["premium", str(order.premium)]),
            Tag.parse(
                [
                    "source",
                    f"http://{config('HOST_NAME')}/order/{config('COORDINATOR_ALIAS', cast=str).lower()}/{order.id}",
                ]
            ),
            Tag.parse(
                [
                    "expiration",
                    str(int(order.expires_at.timestamp())),
                    str(order.escrow_duration),
                ]
            ),
            Tag.parse(["y", "robosats", config("COORDINATOR_ALIAS", cast=str).lower()]),
            Tag.parse(["network", str(config("NETWORK"))]),
            Tag.parse(["layer"] + self.get_layer_tag(order)),
            Tag.parse(["bond", str(order.bond_size)]),
            Tag.parse(["z", "order"]),
        ]

        if order.latitude and order.longitude:
            tags.extend(
                [Tag.parse(["g", pygeohash.encode(order.latitude, order.longitude)])]
            )

        return tags

    def get_status_tag(self, order):
        if order.status == Order.Status.PUB:
            return "pending"
        else:
            return "success"

    def get_layer_tag(self, order):
        if order.type == Order.Types.SELL and not config(
            "DISABLE_ONCHAIN", cast=bool, default=True
        ):
            return ["onchain", "lightning"]
        else:
            return ["lightning"]
            return False

    def sign_message(text: str) -> str:
        try:
            keys = Keys.parse(config("NOSTR_NSEC", cast=str))
            secret_key_hex = keys.secret_key().to_hex()
            private_key = PrivateKey(bytes.fromhex(secret_key_hex))
            signature = private_key.schnorr_sign(
                text.encode("utf-8"), bip340tag=None, raw=True
            )

            return signature.hex()
        except Exception:
            return ""
