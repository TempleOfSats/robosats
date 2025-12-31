import { nip59, type EventTemplate, type Event } from 'nostr-tools';

export const LINK_REQUEST_TYPE = 'robosats.reputation.link.request.v1';
export const LINK_CONFIRM_TYPE = 'robosats.reputation.link.confirm.v1';

export interface NotarySender {
  relayUrl: string;
  notaryPubKey: string;
  sendEvent: (event: Event) => void;
}

export const sendReputationLink = ({
  notary,
  ephemeralSecKey,
  ephemeralPubKey,
  masterSecKey,
  masterPubKey,
}: {
  notary: NotarySender;
  ephemeralSecKey: Uint8Array;
  ephemeralPubKey: string;
  masterSecKey: Uint8Array;
  masterPubKey: string;
}): void => {
  if (!notary.relayUrl || !notary.notaryPubKey) return;

  const createdAt = Math.floor(Date.now() / 1000);

  const requestEvent: EventTemplate = {
    created_at: createdAt,
    kind: 14,
    tags: [['p', notary.notaryPubKey, notary.relayUrl]],
    content: JSON.stringify({
      type: LINK_REQUEST_TYPE,
      master_pubkey: masterPubKey,
      ephemeral_pubkey: ephemeralPubKey,
      created_at: createdAt,
    }),
  };

  const confirmEvent: EventTemplate = {
    created_at: createdAt,
    kind: 14,
    tags: [['p', notary.notaryPubKey, notary.relayUrl]],
    content: JSON.stringify({
      type: LINK_CONFIRM_TYPE,
      ephemeral_pubkey: ephemeralPubKey,
      created_at: createdAt,
    }),
  };

  try {
    const wrappedRequest = nip59.wrapEvent(requestEvent, ephemeralSecKey, notary.notaryPubKey);
    notary.sendEvent(wrappedRequest);

    const wrappedConfirm = nip59.wrapEvent(confirmEvent, masterSecKey, notary.notaryPubKey);
    notary.sendEvent(wrappedConfirm);
  } catch (error) {
    console.error('Reputation link error:', error);
  }
};

