import { type Event } from 'nostr-tools';
import { type Settings } from '../../models';
import notaryConfig from '../../../static/reputation_notary.json';
import { websocketClient, type WebsocketConnection, WebsocketState } from '../Websocket';

interface NotaryPoolEvents {
  onevent: (event: Event) => void;
  oneose: () => void;
}

interface NotaryNetworkConfig {
  relayUrl: string;
  nostrHexPubkey: string;
}

class NotaryPool {
  constructor(settings: Settings) {
    this.network = settings.network ?? 'mainnet';
    const cfg = (notaryConfig as Record<string, NotaryNetworkConfig>)[this.network];
    this.relayUrl = cfg?.relayUrl ?? '';
    this.notaryPubKey = cfg?.nostrHexPubkey ?? '';

    this.webSocket = null;
  }

  public relayUrl: string;
  public notaryPubKey: string;
  public network: 'testnet' | 'mainnet';

  private webSocket: WebsocketConnection | null;
  private readonly messageHandlers: Array<(event: MessageEvent) => void> = [];

  updateConfig = (settings: Settings): void => {
    const newNetwork = settings.network ?? 'mainnet';
    if (this.network === newNetwork) return;

    this.network = newNetwork;
    const cfg = (notaryConfig as Record<string, NotaryNetworkConfig>)[this.network];
    this.relayUrl = cfg?.relayUrl ?? '';
    this.notaryPubKey = cfg?.nostrHexPubkey ?? '';
    this.close();
    this.connect();
  };

  connect = (): void => {
    if (!this.relayUrl || this.webSocket != null) return;

    void websocketClient.open(this.relayUrl).then((connection) => {
      console.log(`Connected to notary relay ${this.relayUrl}`);

      connection.onMessage((event) => {
        this.messageHandlers.forEach((handler) => {
          handler(event);
        });
      });

      connection.onError((error) => {
        console.error(`WebSocket error on notary relay ${this.relayUrl}:`, error);
      });

      connection.onClose(() => {
        console.log(`Disconnected from notary relay ${this.relayUrl}`);
        this.webSocket = null;
      });

      this.webSocket = connection;
    });
  };

  close = (): void => {
    this.webSocket?.close();
    this.webSocket = null;
  };

  private sendMessage = (message: string): void => {
    const send = (): void => {
      const ws = this.webSocket;
      if (!ws || ws.getReadyState() === WebsocketState.CONNECTING) {
        setTimeout(send, 500);
      } else if (ws.getReadyState() === WebsocketState.OPEN) {
        ws.send(message);
      }
    };
    send();
  };

  sendEvent = (event: Event): void => {
    if (!this.relayUrl) return;
    this.connect();
    this.sendMessage(JSON.stringify(['EVENT', event]));
  };

  subscribeBuyerBadges = (events: NotaryPoolEvents, pubkeys: string[], id?: string): void => {
    if (!this.relayUrl) return;
    this.connect();

    const subId = `subscribeBuyerBadges${id ?? ''}`;
    this.sendMessage(JSON.stringify(['CLOSE', subId]));

    const request = ['REQ', subId, { kinds: [38385], '#p': pubkeys }];

    this.messageHandlers.push((messageEvent: MessageEvent) => {
      const jsonMessage = JSON.parse(messageEvent.data);
      if (subId !== jsonMessage[1]) return;

      if (jsonMessage[0] === 'EVENT') {
        events.onevent(jsonMessage[2]);
      } else if (jsonMessage[0] === 'EOSE') {
        events.oneose();
      }
    });

    this.sendMessage(JSON.stringify(request));
  };
}

export default NotaryPool;

