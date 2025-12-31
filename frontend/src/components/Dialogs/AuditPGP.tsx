import React, { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogTitle,
  Tooltip,
  IconButton,
  TextField,
  DialogActions,
  DialogContent,
  DialogContentText,
  Button,
  Grid,
  Link,
  Tabs,
  Tab,
  FormControlLabel,
  Switch,
} from '@mui/material';

import { saveAsJson } from '../../utils';
import { systemClient } from '../../services/System';
import { websocketClient } from '../../services/Websocket';

// Icons
import KeyIcon from '@mui/icons-material/Key';
import ContentCopy from '@mui/icons-material/ContentCopy';
import ForumIcon from '@mui/icons-material/Forum';
import { ExportIcon, NewTabIcon } from '../Icons';
import { UseAppStoreType, AppContext } from '../../contexts/AppContext';
import { FederationContext, type UseFederationStoreType } from '../../contexts/FederationContext';
import { GarageContext, UseGarageStoreType } from '../../contexts/GarageContext';
import { Order, Slot } from '../../models';
import { getPublicKey, nip19, nip59 } from 'nostr-tools';
import { EncryptedChatMessage } from '../TradeBox/EncryptedChat';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';

function CredentialTextfield(props): React.JSX.Element {
  return (
    <Grid item align='center' xs={12}>
      <Tooltip placement='top' enterTouchDelay={200} enterDelay={200} title={props.tooltipTitle}>
        <TextField
          sx={{ width: '100%', maxWidth: '550px' }}
          disabled
          label={<b>{props.label}</b>}
          value={props.value}
          variant='filled'
          size='small'
          InputProps={{
            endAdornment: (
              <Tooltip disableHoverListener enterTouchDelay={0} title={props.copiedTitle}>
                <IconButton
                  onClick={() => {
                    systemClient.copyToClipboard(props.value);
                  }}
                >
                  <ContentCopy />
                </IconButton>
              </Tooltip>
            ),
          }}
        />
      </Tooltip>
    </Grid>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  order?: Order;
  messages?: EncryptedChatMessage[];
  peerPubKey?: string;
  initialTab?: 'nostr' | 'pgp' | 'reputation';
  onClickBack: () => void;
}

const AuditPGPDialog = ({
  open,
  onClose,
  order,
  messages,
  peerPubKey,
  onClickBack,
  initialTab,
}: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const { client } = useContext<UseAppStoreType>(AppContext);
  const { federation } = useContext<UseFederationStoreType>(FederationContext);
  const { garage } = useContext<UseGarageStoreType>(GarageContext);
  const [tab, setTab] = useState<'nostr' | 'pgp' | 'reputation'>(initialTab ?? 'nostr');
  const [slot, setSlot] = useState<Slot | null>();
  const [reputationMasterNpub, setReputationMasterNpub] = useState<string>('');
  const [reputationMasterNsec, setReputationMasterNsec] = useState<string>('');
  const [reputationEnabled, setReputationEnabled] = useState<boolean>(false);
  const [reputationStep, setReputationStep] = useState<1 | 2 | 3>(1);
  const [reputationSetupMode, setReputationSetupMode] = useState<'choice' | 'import'>('choice');
  const [importMasterNsec, setImportMasterNsec] = useState<string>('');
  const [importMasterValid, setImportMasterValid] = useState<boolean>(false);
  const [importMasterResult, setImportMasterResult] = useState<
    'idle' | 'success' | 'error'
  >('idle');
  const [reputationSuccessCount, setReputationSuccessCount] = useState<number | null>(null);
  const [reputationSuccessCountLoading, setReputationSuccessCountLoading] =
    useState<boolean>(false);
  const importMasterFieldRef = useRef<HTMLInputElement | null>(null);
  // PGP
  const [ownPubKey, setOwnPubKey] = useState<string>();
  const [ownEncPrivKey, setOwnEncPrivKey] = useState<string>();
  const [passphrase, setPassphrase] = useState<string>();

  const refreshReputationMaster = (): void => {
    void garage.getReputationMaster().then((master) => {
      if (!master?.pubKey || !master?.nsec) {
        setReputationMasterNpub('');
        setReputationMasterNsec('');
        return;
      }
      setReputationMasterNpub(nip19.npubEncode(master.pubKey));
      setReputationMasterNsec(master.nsec);
    });
  };

  const backupReputationMasterKey = (): void => {
    const object = {
      master_public_key: reputationMasterNpub,
      master_private_key: reputationMasterNsec,
    };
    if (!reputationMasterNsec) return;
    return client === 'mobile'
      ? systemClient.copyToClipboard(JSON.stringify(object))
      : saveAsJson(`reputation_master_key.json`, object, client);
  };

  const refreshReputationSuccessCount = async (): Promise<void> => {
    if (!federation.notaryPool.relayUrl) {
      setReputationSuccessCount(null);
      return;
    }
    if (!reputationEnabled) {
      setReputationSuccessCount(null);
      return;
    }
    if (!reputationMasterNsec) {
      setReputationSuccessCount(null);
      return;
    }

    const master = await garage.getReputationMaster();
    if (!master?.pubKey || !master?.secKey) {
      setReputationSuccessCount(null);
      return;
    }

    const encoder = new TextEncoder();
    const contextBytes = encoder.encode('robosats.reputation.stats.v1');
    const input = new Uint8Array(contextBytes.length + master.secKey.length);
    input.set(contextBytes, 0);
    input.set(master.secKey, contextBytes.length);
    const statsSecKey = sha256Hash(input);
    const statsPubKey = getPublicKey(statsSecKey);

    type NostrEvent = {
      kind: number;
      pubkey: string;
      created_at: number;
      tags: string[][];
      content: string;
    };

    const requestId = Math.random().toString(16).slice(2);
    const network = federation.network ?? 'mainnet';

    const connection = await websocketClient.open(federation.notaryPool.relayUrl);
    const subId = `reputationStats:${requestId}`;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) reject(new Error('Timed out'));
      }, 15000);

      const finish = (fn: () => void): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        try {
          connection.send(JSON.stringify(['CLOSE', subId]));
        } catch {
          // ignore
        }
        try {
          connection.close();
        } catch {
          // ignore
        }
        fn();
      };

      connection.onMessage((messageEvent: MessageEvent) => {
        try {
          const json = JSON.parse(messageEvent.data as string);
          if (!Array.isArray(json) || json[1] !== subId) return;

          if (json[0] !== 'EVENT') return;
          const event = json[2] as NostrEvent;
          if (event.kind !== 1059) return;

          let unwrapped: any;
          try {
            unwrapped = nip59.unwrapEvent(event as any, statsSecKey);
          } catch {
            return;
          }

          const rumor = (unwrapped?.rumor ?? unwrapped) as { content?: string };
          const content = rumor?.content ?? '';
          const payload = JSON.parse(content) as {
            type?: string;
            network?: string;
            success_count?: number;
            request_id?: string;
          };
          if (payload?.type !== 'robosats.reputation.stats.response.v1') return;
          if (payload?.network !== network) return;
          if (payload?.request_id !== requestId) return;
          if (typeof payload.success_count !== 'number') return;

          setReputationSuccessCount(payload.success_count);
          finish(resolve);
        } catch {
          // ignore
        }
      });

      connection.onError(() => {
        finish(() => reject(new Error('WebSocket error')));
      });

      connection.send(JSON.stringify(['REQ', subId, { kinds: [1059], '#p': [statsPubKey], limit: 50 }]));

      const now = Math.floor(Date.now() / 1000);
      const requestEvent = {
        created_at: now,
        kind: 14,
        tags: [['p', federation.notaryPool.notaryPubKey, federation.notaryPool.relayUrl]],
        content: JSON.stringify({
          type: 'robosats.reputation.stats.request.v1',
          network,
          reply_pubkey: statsPubKey,
          request_id: requestId,
          created_at: now,
        }),
      };

      const wrappedRequest = nip59.wrapEvent(
        requestEvent as any,
        master.secKey,
        federation.notaryPool.notaryPubKey,
      );
      connection.send(JSON.stringify(['EVENT', wrappedRequest]));
    });
  };

  useEffect(() => {
    const slot = garage.getSlot();
    setSlot(slot);
    setOwnPubKey(slot?.getRobot()?.pubKey ?? '');
    setOwnEncPrivKey(slot?.getRobot()?.encPrivKey ?? '');
    setPassphrase(slot?.token ?? '');
  }, [garage.currentSlot, order?.id]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab ?? 'nostr');
    setImportMasterNsec('');
    setImportMasterValid(false);
    setImportMasterResult('idle');
    setReputationSetupMode('choice');

    const init = async (): Promise<void> => {
      const enabled = await garage.getReputationEnabled();
      setReputationEnabled(enabled);

      if (!enabled) {
        setReputationMasterNpub('');
        setReputationMasterNsec('');
        setReputationStep(1);
        return;
      }

      const master = await garage.getReputationMaster();
      if (master?.pubKey && master?.nsec) {
        setReputationMasterNpub(nip19.npubEncode(master.pubKey));
        setReputationMasterNsec(master.nsec);
        setReputationStep(3);
        return;
      }

      setReputationMasterNpub('');
      setReputationMasterNsec('');
      setReputationStep(2);
    };

    void init();
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    if (tab !== 'reputation') return;
    if (reputationStep !== 3) return;

    let cancelled = false;
    setReputationSuccessCountLoading(true);
    void refreshReputationSuccessCount()
      .catch(() => {
        if (!cancelled) setReputationSuccessCount(null);
      })
      .finally(() => {
        if (!cancelled) setReputationSuccessCountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    tab,
    reputationStep,
    reputationEnabled,
    reputationMasterNsec,
    federation.network,
    federation.notaryPool.relayUrl,
  ]);

  return (
    <>
      <Dialog open={open} onClose={onClose}>
      <DialogTitle>{t("Don't trust, verify")}</DialogTitle>
      <DialogContent>
        <Tabs value={tab} onChange={(_event, newValue) => setTab(newValue)}>
          <Tab label={t('nostr')} value='nostr' style={{ width: '33%' }} />
          <Tab label={t('PGP')} value='pgp' style={{ width: '33%' }} />
          <Tab label={t('Reputation')} value='reputation' style={{ width: '33%' }} />
        </Tabs>
        <div style={{ display: tab === 'pgp' ? '' : 'none', marginTop: 16 }}>
          <DialogContentText>
            {t(
              'Your communication is end-to-end encrypted with OpenPGP. You can verify the privacy of this chat using any tool based on the OpenPGP standard.',
            )}
          </DialogContentText>
          <Grid container spacing={1} align='center' direction='column'>
            <Grid item align='center' xs={12}>
              <Button
                component={Link}
                target='_blank'
                href='https://learn.robosats.org/docs/pgp-encryption'
              >
                {t('Learn how to verify')} <NewTabIcon sx={{ width: 16, height: 16 }} />
              </Button>
            </Grid>

            <CredentialTextfield
              tooltipTitle={t(
                'Your PGP public key. Your peer uses it to encrypt messages only you can read.',
              )}
              label={t('Your public key')}
              value={ownPubKey}
              copiedTitle={t('Copied!')}
            />

            {peerPubKey && (
              <CredentialTextfield
                tooltipTitle={t(
                  'Your peer PGP public key. You use it to encrypt messages only he can read and to verify your peer signed the incoming messages.',
                )}
                label={t('Peer public key')}
                value={peerPubKey}
                copiedTitle={t('Copied!')}
              />
            )}

            <CredentialTextfield
              tooltipTitle={t(
                'Your encrypted private key. You use it to decrypt the messages that your peer encrypted for you. You also use it to sign the messages you send.',
              )}
              label={t('Your encrypted private key')}
              value={ownEncPrivKey}
              copiedTitle={t('Copied!')}
            />

            <CredentialTextfield
              tooltipTitle={t(
                'The passphrase to decrypt your private key. Only you know it! Do not share. It is also your robot token.',
              )}
              label={t('Your private key passphrase (keep secure!)')}
              value={passphrase}
              copiedTitle={t('Copied!')}
            />

            <br />
            <Grid item xs={12} style={{ display: 'flex', flexDirection: 'row' }}>
              <Grid item style={{ width: '50%' }}>
                <Tooltip
                  placement='top'
                  enterTouchDelay={0}
                  enterDelay={1000}
                  enterNextDelay={2000}
                  title={t('Save credentials as a JSON file')}
                >
                  <Button
                    size='small'
                    color='primary'
                    variant='contained'
                    onClick={() => {
                      const object = {
                        own_public_key: ownPubKey,
                        peer_public_key: peerPubKey,
                        encrypted_private_key: ownEncPrivKey,
                        passphrase,
                      };

                      return client === 'mobile'
                        ? systemClient.copyToClipboard(JSON.stringify(object))
                        : saveAsJson(`pgp_keys_${order?.id ?? ''}.json`, object, client);
                    }}
                  >
                    <div style={{ width: 26, height: 18 }}>
                      <ExportIcon sx={{ width: 18, height: 18 }} />
                    </div>
                    {t('Keys')}
                    <div style={{ width: 26, height: 20 }}>
                      <KeyIcon sx={{ width: 20, height: 20 }} />
                    </div>
                  </Button>
                </Tooltip>
              </Grid>

              {messages && (
                <Grid item style={{ width: '50%' }}>
                  <Tooltip
                    placement='top'
                    enterTouchDelay={0}
                    enterDelay={1000}
                    enterNextDelay={2000}
                    title={t('Save messages as a JSON file')}
                  >
                    <Button
                      size='small'
                      color='primary'
                      variant='contained'
                      onClick={() => {
                        return client === 'mobile'
                          ? systemClient.copyToClipboard(JSON.stringify(messages))
                          : saveAsJson(`pgp_messages_${order?.id ?? ''}.json`, messages, client);
                      }}
                    >
                      <div style={{ width: 28, height: 20 }}>
                        <ExportIcon sx={{ width: 18, height: 18 }} />
                      </div>
                      {t('Messages')}
                      <div style={{ width: 26, height: 20 }}>
                        <ForumIcon sx={{ width: 20, height: 20 }} />
                      </div>
                    </Button>
                  </Tooltip>
                </Grid>
              )}
            </Grid>
          </Grid>
        </div>
        <div style={{ display: tab === 'nostr' ? '' : 'none', marginTop: 16 }}>
          <DialogContentText>
            {t(
              'Your communication is end-to-end encrypted with secp256k1 schnorr signatures. You can verify the privacy of this chat using any nostr messages validation tool.',
            )}
          </DialogContentText>
          <Grid container spacing={1} align='center' direction='column' style={{ marginTop: 16 }}>
            <CredentialTextfield
              tooltipTitle={t(
                'Your nostr public key. Your peer uses it to encrypt messages only you can read.',
              )}
              label={t('Your public key')}
              value={nip19.npubEncode(slot?.nostrPubKey ?? '')}
              copiedTitle={t('Copied!')}
            />

            {order && (
              <CredentialTextfield
                tooltipTitle={t(
                  'Your peer nostr public key. You use it to encrypt messages only he can read and to verify your peer signed the incoming messages.',
                )}
                label={t('Peer public key')}
                value={nip19.npubEncode(
                  order.is_maker ? order.taker_nostr_pubkey : order.maker_nostr_pubkey,
                )}
                copiedTitle={t('Copied!')}
              />
            )}

            <CredentialTextfield
              tooltipTitle={t(
                'Your nostr private key. You use it to decrypt the messages that your peer encrypted for you. You also use it to sign the messages you send.',
              )}
              label={t('Your private key')}
              value={slot?.nostrSecKey ? nip19.nsecEncode(slot?.nostrSecKey) : ''}
              copiedTitle={t('Copied!')}
            />

            <br />
            <Grid item xs={12} style={{ display: 'flex', flexDirection: 'row' }}>
              <Grid item style={{ width: '50%' }}>
                <Tooltip
                  placement='top'
                  enterTouchDelay={0}
                  enterDelay={1000}
                  enterNextDelay={2000}
                  title={t('Save credentials as a JSON file')}
                >
                  <Button
                    size='small'
                    color='primary'
                    variant='contained'
                    onClick={() => {
                      const object = {
                        own_public_key: nip19.npubEncode(slot?.nostrPubKey ?? ''),
                        private_key: slot?.nostrSecKey ? nip19.nsecEncode(slot?.nostrSecKey) : '',
                      };

                      if (order) {
                        object.peer_public_key = nip19.npubEncode(
                          order.is_maker ? order.taker_nostr_pubkey : order.maker_nostr_pubkey,
                        );
                      }

                      return client === 'mobile'
                        ? systemClient.copyToClipboard(JSON.stringify(object))
                        : saveAsJson(`nostr_keys_${order?.id ?? ''}.json`, object, client);
                    }}
                  >
                    <div style={{ width: 26, height: 18 }}>
                      <ExportIcon sx={{ width: 18, height: 18 }} />
                    </div>
                    {t('Keys')}
                    <div style={{ width: 26, height: 20 }}>
                      <KeyIcon sx={{ width: 20, height: 20 }} />
                    </div>
                  </Button>
                </Tooltip>
              </Grid>

              {messages && (
                <Grid item style={{ width: '50%' }}>
                  <Tooltip
                    placement='top'
                    enterTouchDelay={0}
                    enterDelay={1000}
                    enterNextDelay={2000}
                    title={t('Save messages as a JSON file')}
                  >
                    <Button
                      size='small'
                      color='primary'
                      variant='contained'
                      onClick={() => {
                        return client === 'mobile'
                          ? systemClient.copyToClipboard(JSON.stringify(messages))
                          : saveAsJson(`nostr_messages_${order?.id ?? ''}.json`, messages, client);
                      }}
                    >
                      <div style={{ width: 28, height: 20 }}>
                        <ExportIcon sx={{ width: 18, height: 18 }} />
                      </div>
                      {t('Messages')}
                      <div style={{ width: 26, height: 20 }}>
                        <ForumIcon sx={{ width: 20, height: 20 }} />
                      </div>
                    </Button>
                  </Tooltip>
                </Grid>
              )}
            </Grid>
          </Grid>
        </div>
	        <div style={{ display: tab === 'reputation' ? '' : 'none', marginTop: 16 }}>
            {reputationStep === 1 ? (
              <>
	                <DialogContentText component='div'>
	                  {t(
	                    'Buyer reputation is optional. To build up reputation, you must use the same master key across robots and orders (and across devices).',
	                  )}
	                  <br />
	                  {t(
	                    "Privacy: coordinators do not see your master key. Other users only see the tier so they can't easily correlate your robots while you maintain the reputation.",
	                  )}
	                  <br />
	                  <br />
	                  {t(
	                    "Tiers: Beginner (>5). Intermediate (>10 and ≥90 days). Experienced (>30 and ≥120 days). Only successful BUY trades count (swaps excluded).",
	                  )}
	                </DialogContentText>

                <Grid container spacing={1} align='center' direction='column' style={{ marginTop: 16 }}>
                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
                    <b>{t('Step 1 of 3: Enable reputation')}</b>
                  </Grid>

	                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                    <FormControlLabel
	                      control={
	                        <Switch
	                          checked={reputationEnabled}
	                          onChange={(_e, checked) => {
	                            void (async () => {
	                              await garage.setReputationEnabled(checked);
	                              setReputationEnabled(checked);
	                              setReputationSetupMode('choice');
	                              setImportMasterNsec('');
	                              setImportMasterValid(false);
	                              setImportMasterResult('idle');

	                              if (!checked) {
	                                setReputationMasterNpub('');
	                                setReputationMasterNsec('');
	                                setReputationStep(1);
	                                return;
	                              }

	                              const master = await garage.getReputationMaster();
	                              if (master?.pubKey && master?.nsec) {
	                                setReputationMasterNpub(nip19.npubEncode(master.pubKey));
	                                setReputationMasterNsec(master.nsec);
	                                setReputationStep(3);
	                                return;
	                              }

	                              setReputationMasterNpub('');
	                              setReputationMasterNsec('');
	                              setReputationStep(2);
	                            })();
	                          }}
	                        />
	                      }
	                      label={t('Enable buyer reputation')}
	                    />
	                  </Grid>
	                </Grid>
	              </>
	            ) : null}

            {reputationStep === 2 ? (
              <>
                <Grid container spacing={1} align='center' direction='column' style={{ marginTop: 16 }}>
                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
                    <b>{t('Step 2 of 3: Set up your master key')}</b>
                  </Grid>

                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
                    <DialogContentText>
                      {t(
                        'Use Import if you already have a master key (keeps your existing reputation). Use Generate to start from scratch.',
                      )}
                    </DialogContentText>
                  </Grid>

	                  {reputationSetupMode === 'choice' ? (
	                    <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
		                      <Grid container spacing={1} justifyContent='center'>
		                        <Grid item xs={12} sm='auto'>
		                          <Button
		                            fullWidth
		                            variant='outlined'
		                            sx={{ minWidth: { sm: 180 } }}
		                            onClick={() => {
	                              setReputationSetupMode('import');
	                              setTimeout(() => importMasterFieldRef.current?.focus(), 0);
	                            }}
	                          >
	                            {t('Import')}
		                          </Button>
		                        </Grid>
		                        <Grid item xs={12} sm='auto'>
		                          <Button
		                            fullWidth
		                            variant='contained'
		                            sx={{ minWidth: { sm: 180 } }}
		                            onClick={() => {
	                              void garage.regenerateReputationMaster().then(() => {
	                                refreshReputationMaster();
	                                setImportMasterResult('idle');
                                setReputationSetupMode('choice');
                                setReputationStep(3);
                              });
                            }}
                          >
                            {t('Generate')}
                          </Button>
                        </Grid>
                      </Grid>
                    </Grid>
                  ) : null}

                  {reputationSetupMode === 'import' ? (
                    <>
                      <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
                        <TextField
                          fullWidth
                          label={t('Import master private key (nsec)')}
                          placeholder='nsec1...'
                          variant='filled'
                          size='small'
                          value={importMasterNsec}
                          inputRef={(el) => {
                            importMasterFieldRef.current = el;
                          }}
                          onChange={(e) => {
                            const next = e.target.value;
                            setImportMasterNsec(next);
                            setImportMasterResult('idle');
                            try {
                              const decoded = nip19.decode(next.trim());
                              setImportMasterValid(decoded.type === 'nsec');
                            } catch {
                              setImportMasterValid(false);
                            }
                          }}
                          error={importMasterResult === 'error'}
                          helperText={
                            importMasterResult === 'success'
                              ? t('Imported')
                              : importMasterResult === 'error'
                                ? t('Invalid nsec')
                                : ''
                          }
                        />
                      </Grid>

                      <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                      <Grid container spacing={1}>
	                          <Grid item xs={12} sm={6}>
	                            <Button
	                              fullWidth
	                              variant='outlined'
	                              onClick={() => {
                                setReputationSetupMode('choice');
                                setImportMasterResult('idle');
                              }}
                            >
                              {t('Back')}
	                            </Button>
	                          </Grid>
	                          <Grid item xs={12} sm={6}>
	                            <Button
	                              fullWidth
	                              color='primary'
	                              variant='contained'
                              disabled={!importMasterValid}
                              onClick={() => {
                                void garage.setReputationMasterNsec(importMasterNsec).then((ok) => {
                                  if (!ok) {
                                    setImportMasterResult('error');
                                    return;
                                  }
                                  setImportMasterResult('success');
                                  refreshReputationMaster();
                                  setReputationSetupMode('choice');
                                  setReputationStep(3);
                                });
                              }}
                            >
                              {t('Import')}
                            </Button>
                          </Grid>
                        </Grid>
                      </Grid>
                    </>
                  ) : null}

                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
                    <Button
                      fullWidth
                      variant='text'
                      onClick={() => {
                        setReputationSetupMode('choice');
                        setImportMasterResult('idle');
                        setReputationStep(1);
                      }}
                    >
                      {t('Back')}
                    </Button>
                  </Grid>
                </Grid>
              </>
            ) : null}

            {reputationStep === 3 ? (
              <>
	                <Grid container spacing={1} align='center' direction='column' style={{ marginTop: 16 }}>
	                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                    <b>{t('Step 3 of 3: Backup your master key')}</b>
	                  </Grid>

	                  {reputationSuccessCountLoading ? (
	                    <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                      <DialogContentText>{t('Loading your successful BUY trades...')}</DialogContentText>
	                    </Grid>
		                  ) : reputationSuccessCount != null ? (
		                    <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
		                      <DialogContentText>
		                        {t('Successful BUY trades (this master key):')} {reputationSuccessCount}
		                      </DialogContentText>
		                    </Grid>
		                  ) : null}
	
	                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                    <Tooltip
	                      placement='top'
                      enterTouchDelay={0}
                      title={t('Backup your master key to avoid losing your built reputation')}
                    >
                      <Button
                        fullWidth
                        size='large'
                        color='warning'
                        variant='contained'
                        onClick={backupReputationMasterKey}
                        startIcon={<ExportIcon />}
                      >
                        {t('Backup master key')}
                      </Button>
                    </Tooltip>
                  </Grid>

                  <CredentialTextfield
                    tooltipTitle={t('Your buyer reputation master public key.')}
                    label={t('Master public key')}
                    value={reputationMasterNpub}
                    copiedTitle={t('Copied!')}
                  />

                  <CredentialTextfield
                    tooltipTitle={t(
                      'Your buyer reputation master private key (nsec). Anyone who has it can impersonate your reputation identity.',
                    )}
                    label={t('Master private key (keep secure!)')}
                    value={reputationMasterNsec}
                    copiedTitle={t('Copied!')}
                  />

                  <Grid item xs={12} style={{ width: '100%', maxWidth: 550 }}>
	                    <Grid container spacing={1}>
	                      <Grid item xs={12} sm={6}>
	                        <Button
	                          fullWidth
	                          variant='outlined'
	                          onClick={() => {
                            setReputationSetupMode('choice');
                            setImportMasterResult('idle');
                            setReputationStep(2);
                          }}
                        >
                          {t('Replace key')}
	                        </Button>
	                      </Grid>
	                      <Grid item xs={12} sm={6}>
	                        <Button
	                          fullWidth
	                          variant='text'
	                          onClick={() => {
                            setReputationSetupMode('choice');
                            setImportMasterResult('idle');
                            setReputationStep(1);
                          }}
                        >
                          {t('Back')}
                        </Button>
                      </Grid>
                    </Grid>
                  </Grid>
                </Grid>
              </>
            ) : null}
          </div>
	      </DialogContent>

      <DialogActions>
        <Button onClick={onClickBack} autoFocus>
          {t('Go back')}
        </Button>
      </DialogActions>
      </Dialog>

    </>
  );
};

export default AuditPGPDialog;
