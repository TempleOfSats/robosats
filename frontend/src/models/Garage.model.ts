import { type Federation, Order } from '.';
import { genKey } from '../pgp';
import { systemClient } from '../services/System';
import { genBase62Token, saveAsJson } from '../utils';
import Slot from './Slot.model';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { getPublicKey, nip19 } from 'nostr-tools';

type GarageHooks = 'onSlotUpdate';

class Garage {
  constructor() {
    this.slots = {};
    this.currentSlot = null;
    this.reputationMasterNsec = null;
    this.reputationEnabled = null;

    this.hooks = {
      onSlotUpdate: [],
    };

    this.loadSlots();
  }

  slots: Record<string, Slot>;
  currentSlot: string | null;
  private reputationMasterNsec: string | null;
  private reputationEnabled: boolean | null;

  hooks: Record<GarageHooks, Array<() => void>>;

  // Hooks
  registerHook = (hookName: GarageHooks, fn: () => void): void => {
    this.hooks[hookName]?.push(fn);
  };

  triggerHook = (hookName: GarageHooks): void => {
    this.save();
    this.hooks[hookName]?.forEach((fn) => {
      fn();
    });
  };

  // Storage
  download = (client: 'mobile' | 'web' | 'desktop' | string): void => {
    const keys = Object.keys(this.slots);
    saveAsJson(`garage_slots_${new Date().toISOString()}.json`, keys, client);
  };

  save = (): void => {
    systemClient.setItem('garage_slots', JSON.stringify(this.slots));
    if (this.currentSlot) systemClient.setItem('garage_current_slot', this.currentSlot);
  };

  delete = (): void => {
    this.slots = {};
    this.currentSlot = null;
    systemClient.deleteItem('garage_slots');
    systemClient.deleteItem('garage_current_slot');
    this.triggerHook('onSlotUpdate');
  };

  loadSlots = async (): Promise<void> => {
    this.slots = {};
    const slotsDump: string = (await systemClient.getItem('garage_slots')) ?? '';

    if (slotsDump !== '') {
      const rawSlots: Record<string, object> = JSON.parse(slotsDump);
      Object.values(rawSlots).forEach((rawSlot: object) => {
        if (rawSlot?.token) {
          const robotAttributes = Object.values(rawSlot.robots)[0] as object;
          this.slots[rawSlot.token] = new Slot(
            rawSlot.token,
            Object.keys(rawSlot.robots),
            {
              pubKey: robotAttributes?.pubKey,
              encPrivKey: robotAttributes?.encPrivKey,
            },
            () => {
              this.triggerHook('onSlotUpdate');
            },
          );
          this.slots[rawSlot.token].reputationMasterPubKey =
            (rawSlot as { reputationMasterPubKey?: string | null }).reputationMasterPubKey ??
            null;
          this.slots[rawSlot.token].updateSlotFromOrder(new Order(rawSlot.lastOrder));
          this.slots[rawSlot.token].updateSlotFromOrder(new Order(rawSlot.activeOrder));
        }
      });

      this.currentSlot =
        (await systemClient.getItem('garage_current_slot')) ?? Object.keys(rawSlots)[0];
      console.log('Robot Garage was loaded from local storage');
      this.triggerHook('onSlotUpdate');
    }
  };

  // Reputation master identity (buyer reputation system)
  getReputationEnabled = async (): Promise<boolean> => {
    if (this.reputationEnabled != null) return this.reputationEnabled;
    const stored = (await systemClient.getItem('garage_reputation_enabled')) ?? '';
    // Default is opt-out (badge is optional).
    this.reputationEnabled = stored === '1' || stored === 'true';
    return this.reputationEnabled;
  };

  setReputationEnabled = async (enabled: boolean): Promise<void> => {
    systemClient.setItem('garage_reputation_enabled', enabled ? '1' : '0');
    this.reputationEnabled = enabled;
    this.triggerHook('onSlotUpdate');
  };

  hasReputationMasterKey = async (): Promise<boolean> => {
    const storedNsec = (await systemClient.getItem('garage_reputation_master_nsec')) ?? '';
    if (storedNsec.trim() !== '') return true;
    const legacyToken = (await systemClient.getItem('garage_reputation_master_token')) ?? '';
    return legacyToken.trim() !== '';
  };

  ensureReputationMasterKey = async (): Promise<void> => {
    if (this.reputationMasterNsec) return;

    const storedNsec = (await systemClient.getItem('garage_reputation_master_nsec')) ?? '';
    if (storedNsec !== '') {
      this.reputationMasterNsec = storedNsec;
      return;
    }

    // Legacy migration: if the old token exists, convert it once to a nostr nsec and persist it.
    const legacyToken = (await systemClient.getItem('garage_reputation_master_token')) ?? '';
    if (legacyToken !== '') {
      const legacySecKey = sha256Hash(sha512(legacyToken));
      const nsec = nip19.nsecEncode(legacySecKey);
      systemClient.setItem('garage_reputation_master_nsec', nsec);
      this.reputationMasterNsec = nsec;
      return;
    }
  };

  getReputationMaster = async (): Promise<
    { nsec: string; secKey: Uint8Array; pubKey: string } | null
  > => {
    const enabled = await this.getReputationEnabled();
    if (!enabled) return null;
    await this.ensureReputationMasterKey();
    if (!this.reputationMasterNsec) return null;

    try {
      const decoded = nip19.decode(this.reputationMasterNsec);
      if (decoded.type !== 'nsec') return null;
      const secKey = decoded.data as Uint8Array;
      const pubKey = getPublicKey(secKey);
      return { nsec: this.reputationMasterNsec, secKey, pubKey };
    } catch {
      return null;
    }
  };

  setReputationMasterNsec = async (nsec: string): Promise<boolean> => {
    const trimmed = (nsec ?? '').trim();
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== 'nsec') return false;
      systemClient.setItem('garage_reputation_master_nsec', trimmed);
      this.reputationMasterNsec = trimmed;
      this.triggerHook('onSlotUpdate');
      return true;
    } catch {
      return false;
    }
  };

  regenerateReputationMaster = async (): Promise<void> => {
    let secKey: Uint8Array | null = null;
    try {
      secKey = globalThis.crypto?.getRandomValues(new Uint8Array(32)) ?? null;
    } catch {
      secKey = null;
    }
    if (!secKey) {
      const token = genBase62Token(36);
      secKey = sha256Hash(sha512(token));
    }

    const nsec = nip19.nsecEncode(secKey);
    systemClient.setItem('garage_reputation_master_nsec', nsec);
    this.reputationMasterNsec = nsec;
    this.triggerHook('onSlotUpdate');
  };

  // Slots
  getSlot: (token?: string) => Slot | null = (token) => {
    const currentToken = token ?? this.currentSlot;
    return currentToken ? (this.slots[currentToken] ?? null) : null;
  };

  deleteSlot: (token?: string) => void = (token) => {
    const targetIndex = token ?? this.currentSlot;
    if (targetIndex) {
      Reflect.deleteProperty(this.slots, targetIndex);
      this.currentSlot = Object.keys(this.slots)[0] ?? null;
      this.save();
      this.triggerHook('onSlotUpdate');
    }
  };

  setCurrentSlot: (currentSlot: string) => void = (currentSlot) => {
    this.currentSlot = currentSlot;
    this.save();
    this.triggerHook('onSlotUpdate');
  };

  getSlotByOrder: (coordinator: string, orderID: number) => Slot | null = (
    coordinator,
    orderID,
  ) => {
    return (
      Object.values(this.slots).find((slot) => {
        const robot = slot.getRobot(coordinator);
        return slot.activeOrder?.shortAlias === coordinator && robot?.activeOrderId === orderID;
      }) ?? null
    );
  };

  getSlotByNostrPubKey: (nostrHexPubkey: string) => Slot | null = (nostrHexPubkey) => {
    return (
      Object.values(this.slots).find((slot) => {
        return slot.nostrPubKey === nostrHexPubkey;
      }) ?? null
    );
  };

  // Robots
  createRobot: (
    federation: Federation,
    token: string,
    skipSelect?: boolean,
    shortAliases?: string[],
  ) => Promise<void> = async (federation, token, skipSelect, shortAliases) => {
      if (!token) return;

      if (this.getSlot(token) === null) {
        try {
          const key = await genKey(token);
          const robotAttributes = {
            token,
            pubKey: key.publicKeyArmored,
            encPrivKey: key.encryptedPrivateKeyArmored,
          };

          if (!skipSelect) this.setCurrentSlot(token);

          const coordinatorAliases =
            shortAliases && shortAliases.length > 0
              ? shortAliases
              : federation.getCoordinatorsAlias();

          this.slots[token] = new Slot(
            token,
            coordinatorAliases,
            robotAttributes,
            () => {
              this.triggerHook('onSlotUpdate');
            },
          );
          void this.fetchRobot(federation, token);
          this.save();
        } catch (error) {
          console.error('Error:', error);
        }
      }
    };

  fetchRobot = async (federation: Federation, token: string): Promise<void> => {
    const slot = this.getSlot(token);

    if (slot != null) {
      await slot.fetchRobot(federation);
      this.save();
      this.triggerHook('onSlotUpdate');
    }
  };

  // Coordinators
  syncCoordinator: (federation: Federation, shortAlias: string) => void = (
    federation,
    shortAlias,
  ) => {
    Object.values(this.slots).forEach((slot) => {
      slot.syncCoordinator(federation, shortAlias);
    });
    this.save();
  };
}

export default Garage;
