import React, { useState, useMemo, useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  List,
  ListItem,
  Alert,
  Chip,
  ListItemText,
  ListItemIcon,
  Divider,
  Grid,
  Collapse,
  useTheme,
  Typography,
  IconButton,
  Tooltip,
  ListItemButton,
  TextField,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  DialogContentText,
} from '@mui/material';

import Countdown, { type CountdownRenderProps, zeroPad } from 'react-countdown';
import RobotAvatar from '../../components/RobotAvatar';
import currencies from '../../../static/assets/currencies.json';
import {
  AccessTime,
  PriceChange,
  Payments,
  HourglassTop,
  Map,
  Warning,
  Tag,
  Description,
  MilitaryTech,
} from '@mui/icons-material';
import { fiatMethods, PaymentStringAsIcons, swapMethods } from '../../components/PaymentMethods';
import { FlagWithProps, SendReceiveIcon } from '../Icons';
import LinearDeterminate from './LinearDeterminate';

import { pn, amountToString, computeSats, statusBadgeColor } from '../../utils';
import TakeButton from './TakeButton';
import { F2fMapDialog, OrderDescriptionDialog } from '../Dialogs';
import { type UseFederationStoreType, FederationContext } from '../../contexts/FederationContext';
import { type UseGarageStoreType, GarageContext } from '../../contexts/GarageContext';
import { Coordinator, type Order } from '../../models';
import { Box } from '@mui/system';

interface OrderDetailsProps {
  shortAlias: string;
  currentOrder: Order;
  setCurrentOrder: (currentOrder: Order) => void;
  onClickCoordinator?: () => void;
  onClickGenerateRobot?: () => void;
}

const OrderDetails = ({
  shortAlias,
  currentOrder,
  setCurrentOrder,
  onClickCoordinator = () => null,
  onClickGenerateRobot = () => null,
}: OrderDetailsProps): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { federation } = useContext<UseFederationStoreType>(FederationContext);
  const { garage, slotUpdatedAt } = useContext<UseGarageStoreType>(GarageContext);
  const [reputationEnabled, setReputationEnabled] = useState<boolean>(false);
  const [reputationHasMasterKey, setReputationHasMasterKey] = useState<boolean>(false);
  const [coordinator, setCoordinator] = useState<Coordinator | null>(
    federation.getCoordinator(shortAlias),
  );
  const [currencyCode, setCurrencyCode] = useState<string | null>();
  const [openWorldmap, setOpenWorldmap] = useState<boolean>(false);
  const [openWarningDialog, setOpenWarningDialog] = useState<boolean>(false);
  const [password, setPassword] = useState<string>();
  const [openDescription, setOpenDescription] = useState<boolean>(false);
  const [buyerBadgeTier, setBuyerBadgeTier] = useState<
    'none' | 'beginner' | 'intermediate' | 'experienced' | 'optin' | 'unknown' | 'unavailable'
  >('optin');
  const [buyerBadgeReported, setBuyerBadgeReported] = useState<boolean>(false);

  useEffect(() => {
    void (async () => {
      const enabled = await garage.getReputationEnabled();
      setReputationEnabled(enabled);
      setReputationHasMasterKey(await garage.hasReputationMasterKey());
    })();
  }, [slotUpdatedAt]);

  useEffect(() => {
    setCoordinator(federation.getCoordinator(shortAlias));
    setCurrencyCode(currencies[(currentOrder?.currency ?? 1).toString()]);
  }, [currentOrder]);

  useEffect(() => {
    if (!coordinator?.info) coordinator?.loadInfo();
  }, [coordinator.shortAlias, coordinator.info]);

  const buyerPubKey = useMemo(() => {
    if (currentOrder.type === 0) return currentOrder.maker_nostr_pubkey;
    if (currentOrder.type === 1) return currentOrder.taker_nostr_pubkey;
    return undefined;
  }, [currentOrder.type, currentOrder.maker_nostr_pubkey, currentOrder.taker_nostr_pubkey]);

  const isSwap = useMemo(() => {
    return (
      currentOrder.currency === 1000 ||
      Boolean(currentOrder.maker_summary?.is_swap) ||
      Boolean(currentOrder.taker_summary?.is_swap)
    );
  }, [currentOrder.currency, currentOrder.maker_summary?.is_swap, currentOrder.taker_summary?.is_swap]);

  useEffect(() => {
    if (isSwap || currentOrder.is_seller) {
      setBuyerBadgeTier('unknown');
      setBuyerBadgeReported(false);
      return;
    }
    if (!buyerPubKey) {
      setBuyerBadgeTier('unknown');
      setBuyerBadgeReported(false);
      return;
    }
    if (!federation.notaryPool.relayUrl || !federation.notaryPool.notaryPubKey) {
      setBuyerBadgeTier('unavailable');
      setBuyerBadgeReported(false);
      return;
    }

    // Badge is opt-in: default to a muted state until the notary publishes a badge assertion.
    setBuyerBadgeTier('optin');
    setBuyerBadgeReported(false);
    federation.notaryPool.subscribeBuyerBadges(
      {
        oneose: () => {},
        onevent: (event) => {
          if (event.pubkey !== federation.notaryPool.notaryPubKey) return;

          const p = event.tags.find((t) => t[0] === 'p')?.[1];
          if (p !== buyerPubKey) return;

          const net = event.tags.find((t) => t[0] === 'net')?.[1];
          if (net && net !== federation.network) return;

          const tier = event.tags.find((t) => t[0] === 'tier')?.[1];
          if (tier === 'beginner' || tier === 'intermediate' || tier === 'experienced' || tier === 'none') {
            setBuyerBadgeTier(tier);
          }

          const reported = event.tags.find((t) => t[0] === 'reported')?.[1];
          setBuyerBadgeReported(reported === '1' || reported === 'true');
        },
      },
      [buyerPubKey],
      `${shortAlias}:${currentOrder.id}`,
    );
  }, [
    buyerPubKey,
    currentOrder.id,
    currentOrder.is_seller,
    federation.network,
    federation.notaryPool.relayUrl,
    federation.notaryPool.notaryPubKey,
    isSwap,
    shortAlias,
  ]);

  const buyerBadgeLabel = useMemo(() => {
    switch (buyerBadgeTier) {
      case 'experienced':
        return t('Experienced');
      case 'intermediate':
        return t('Intermediate');
      case 'beginner':
        return t('Beginner');
      case 'none':
        return t('New');
      case 'optin':
        return t('Opt-in');
      case 'unavailable':
        return t('Unavailable');
      case 'unknown':
      default:
        return t('Unknown');
    }
  }, [buyerBadgeTier]);

  const buyerBadgeDisplayLabel = useMemo(() => {
    if (currentOrder.is_buyer && reputationEnabled && !reputationHasMasterKey) return t('Setup');
    return buyerBadgeLabel;
  }, [buyerBadgeLabel, currentOrder.is_buyer, reputationEnabled, reputationHasMasterKey, t]);

  const showBuyerBadge = useMemo(() => {
    if (isSwap) return false;
    if (currentOrder.is_seller) return false;

    // Always show to the buyer themselves (so they can see / manage their own badge).
    if (currentOrder.is_buyer) return true;

    // For everyone else, show only meaningful signals (avoid clutter / linkability):
    // - show tiers (beginner+)
    // - always show "Reported"
    if (buyerBadgeReported) return true;
    return buyerBadgeTier === 'beginner' || buyerBadgeTier === 'intermediate' || buyerBadgeTier === 'experienced';
  }, [buyerBadgeReported, buyerBadgeTier, currentOrder.is_buyer, currentOrder.is_seller, isSwap]);

  const buyerBadgeIsMuted = useMemo(() => {
    return buyerBadgeTier === 'optin' || buyerBadgeTier === 'unavailable' || buyerBadgeTier === 'unknown';
  }, [buyerBadgeTier]);

  const buyerBadgeTooltip = useMemo(() => {
    const tierInfo = t(
      "Tiers: Beginner (>5). Intermediate (>10 and ≥90 days). Experienced (>30 and ≥120 days). Only successful BUY trades count (swaps excluded).",
    );

    if (buyerBadgeReported) {
      return `${t('This buyer has been reported by a coordinator. Proceed with caution.')} ${tierInfo}`;
    }
    if (currentOrder.is_buyer && reputationEnabled && !reputationHasMasterKey) {
      return `${t('Finish setup in Garage → Reputation')} ${tierInfo}`;
    }
    if (currentOrder.is_buyer && !reputationEnabled) {
      return `${t('Enable it in Garage → Reputation')} ${tierInfo}`;
    }
    if (buyerBadgeTier === 'optin') {
      return `${t(
        'Buyer reputation is optional. If the buyer opted in, a third-party notary publishes a badge based on successful BUY trades.',
      )} ${tierInfo}`;
    }
    if (buyerBadgeTier === 'unavailable') {
      return t('Buyer reputation notary is not configured for this federation.');
    }
    if (buyerBadgeTier === 'unknown') {
      return t('Buyer badge could not be determined.');
    }
    return `${t(
      'Buyer reputation badge is computed by a third-party notary from successful BUY trades (tier only).',
    )} ${tierInfo}`;
  }, [
    buyerBadgeReported,
    buyerBadgeTier,
    currentOrder.is_buyer,
    reputationEnabled,
    reputationHasMasterKey,
    t,
  ]);

  const buyerBadgeSecondaryColor = useMemo(() => {
    if (buyerBadgeReported) return 'error.main';
    if (
      buyerBadgeIsMuted ||
      (currentOrder.is_buyer && !reputationEnabled) ||
      (currentOrder.is_buyer && reputationEnabled && !reputationHasMasterKey)
    ) {
      return 'text.disabled';
    }
    return 'text.secondary';
  }, [
    buyerBadgeIsMuted,
    buyerBadgeReported,
    currentOrder.is_buyer,
    reputationEnabled,
    reputationHasMasterKey,
  ]);

  const buyerBadgeIconColor = useMemo(() => {
    if (buyerBadgeReported) return 'error.main';
    if (
      buyerBadgeIsMuted ||
      (currentOrder.is_buyer && !reputationEnabled) ||
      (currentOrder.is_buyer && reputationEnabled && !reputationHasMasterKey)
    ) {
      return 'action.disabled';
    }
    return 'action.active';
  }, [
    buyerBadgeIsMuted,
    buyerBadgeReported,
    currentOrder.is_buyer,
    reputationEnabled,
    reputationHasMasterKey,
  ]);

  const buyerBadgeSecondary = useMemo(() => {
    return buyerBadgeReported
      ? `${buyerBadgeDisplayLabel} · ${t('Reported')}`
      : buyerBadgeDisplayLabel;
  }, [buyerBadgeDisplayLabel, buyerBadgeReported]);

  const amountString = useMemo(() => {
    if (currentOrder === null) return;

    if (currentOrder.currency === 1000) {
      return (
        amountToString(
          (currentOrder.amount * 100000000).toString(),
          currentOrder.amount > 0 ? false : currentOrder.has_range,
          currentOrder.min_amount * 100000000,
          currentOrder.max_amount * 100000000,
        ) + ' Sats'
      );
    } else {
      return (
        amountToString(
          currentOrder.amount?.toString(),
          currentOrder.amount > 0 ? false : currentOrder.has_range,
          currentOrder.min_amount,
          currentOrder.max_amount,
        ) + ` ${String(currencyCode)}`
      );
    }
  }, [currentOrder, currencyCode]);

  // Countdown Renderer callback with condition
  const countdownRenderer = function ({
    total,
    hours,
    minutes,
    seconds,
    completed,
  }: CountdownRenderProps): React.JSX.Element {
    if (completed) {
      // Render a completed state
      return <span> {t('The order has expired')}</span>;
    } else {
      let color = 'inherit';
      const fraction_left = total / 1000 / (currentOrder?.total_secs_exp ?? 1);
      // Make orange at 25% of time left
      if (fraction_left < 0.25) {
        color = theme.palette.warning.main;
      }
      // Make red at 10% of time left
      if (fraction_left < 0.1) {
        color = theme.palette.error.main;
      }
      // Render a countdown, bold when less than 25%
      return fraction_left < 0.25 ? (
        <a style={{ color }}>
          <b>{`${hours}h ${zeroPad(minutes)}m ${zeroPad(seconds)}s `}</b>
        </a>
      ) : (
        <a style={{ color }}>{`${hours}h ${zeroPad(minutes)}m ${zeroPad(seconds)}s `}</a>
      );
    }
  };

  const timerRenderer = function (seconds: number): React.JSX.Element {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds - hours * 3600) / 60);
    return (
      <span>
        {hours > 0 ? `${hours}h` : ''} {minutes > 0 ? `${zeroPad(minutes)}m` : ''}{' '}
      </span>
    );
  };

  const onPasswordChange = (password: string) => {
    setPassword(password);
  };

  // Countdown Renderer callback with condition
  const countdownPenaltyRenderer = ({
    minutes,
    seconds,
    completed,
  }: {
    minutes: number;
    seconds: number;
    completed: boolean;
  }): React.JSX.Element => {
    if (completed) {
      // Render a completed state
      return <span> {t('Penalty lifted, good to go!')}</span>;
    } else {
      return (
        <span>
          {' '}
          {t('You cannot take an order yet! Wait {{timeMin}}m {{timeSec}}s', {
            timeMin: zeroPad(minutes),
            timeSec: zeroPad(seconds),
          })}{' '}
        </span>
      );
    }
  };

  const satsSummary = useMemo(() => {
    let send: string = '';
    let receive: string = '';
    let sats: string = '';
    const order = currentOrder;

    if (order === null) return {};

    const isBuyer = (order.type === 0 && order.is_maker) || (order.type === 1 && !order.is_maker);
    const tradeFee = order.is_maker
      ? (coordinator.info?.maker_fee ?? 0)
      : (coordinator.info?.taker_fee ?? 0);
    const defaultRoutingBudget = 0.001;
    const btc_now = order.satoshis_now / 100000000;
    const rate = Number(order.max_amount ?? order.amount) / btc_now;

    if (isBuyer) {
      if (order.invoice_amount) {
        sats = pn(order.invoice_amount);
      } else if (order.trade_satoshis) {
        sats = pn(order.trade_satoshis);
      } else if (order.amount && order.amount > 0) {
        sats = computeSats({
          amount: order.amount,
          fee: -tradeFee,
          routingBudget: defaultRoutingBudget,
          rate,
        });
      } else {
        const min = computeSats({
          amount: Number(order.min_amount),
          fee: -tradeFee,
          routingBudget: defaultRoutingBudget,
          rate,
        });
        const max = computeSats({
          amount: Number(order.max_amount),
          fee: -tradeFee,
          routingBudget: defaultRoutingBudget,
          rate,
        });
        sats = `${String(min)}-${String(max)}`;
      }
      send = t('You send via {{method}} {{amount}}', {
        amount: amountString,
        method: order.payment_method,
      });
      receive = t('You receive {{amount}} Sats (Approx)', {
        amount: sats,
      });
    } else {
      if (order.trade_satoshis) {
        sats = pn(order.trade_satoshis);
      } else if (order.escrow_satoshis) {
        sats = pn(order.escrow_satoshis);
      } else if (order.amount && order.amount > 0) {
        sats = computeSats({
          amount: order.amount,
          fee: tradeFee,
          rate,
        });
      } else {
        const min = computeSats({
          amount: order.min_amount,
          fee: tradeFee,
          rate,
        });
        const max = computeSats({
          amount: order.max_amount,
          fee: tradeFee,
          rate,
        });
        sats = `${String(min)}-${String(max)}`;
      }
      send = t('You send via Lightning {{amount}} Sats (Approx)', { amount: sats });
      receive = t('You receive via {{method}} {{amount}}', {
        amount: amountString,
        method: order.payment_method,
      });
    }

    return { send, receive };
  }, [currentOrder, amountString]);

  const revesiblePaymentMethods = useMemo(() => {
    return swapMethods
      .concat(fiatMethods)
      .filter((pm) => pm.reversible)
      .map((pm) => pm.name);
  }, []);

  const orderReversiblePaymentMethods = useMemo(() => {
    return revesiblePaymentMethods.filter((pm) =>
      currentOrder.payment_method.toLowerCase().includes(pm.toLowerCase()),
    );
  }, [currentOrder]);

  return (
    <Grid container spacing={0}>
      <F2fMapDialog
        latitude={currentOrder?.latitude}
        longitude={currentOrder?.longitude}
        open={openWorldmap}
        orderType={currentOrder?.type ?? 0}
        zoom={6}
        message={t(
          'The pinned location is approximate. The exact location for the meeting place must be exchanged in the encrypted chat.',
        )}
        onClose={() => {
          setOpenWorldmap(false);
        }}
      />
      <List dense={true} style={{ width: '100%' }}>
        <ListItemButton
          onClick={() => {
            onClickCoordinator();
          }}
        >
          <Grid container direction='row' justifyContent='center' alignItems='center'>
            <Grid item sx={{ width: '20%' }}>
              <RobotAvatar
                shortAlias={coordinator.federated ? coordinator.shortAlias : undefined}
                hashId={coordinator.federated ? undefined : coordinator.mainnet.onion}
                small={true}
                smooth={true}
                style={{
                  height: '45px',
                  width: '45px',
                }}
              />
            </Grid>
            <Grid item sx={{ width: '50%' }}>
              <ListItemText primary={coordinator.longAlias} secondary={t('Order host')} />
            </Grid>
            <ListItem style={{ width: '30%' }}>
              <ListItemIcon>
                <Tag />
              </ListItemIcon>
              <ListItemText primary={currentOrder?.id} secondary={t('ID')} />
            </ListItem>
          </Grid>
        </ListItemButton>
        <ListItem>
          <Grid sx={{ marginBottom: 1, width: '100%' }}>
            <Alert
              severity={
                coordinator?.info
                  ? coordinator?.info?.swap_enabled
                    ? 'success'
                    : 'warning'
                  : 'info'
              }
              style={{ width: '100%' }}
            >
              {!coordinator?.loadingInfo
                ? coordinator?.info?.swap_enabled
                  ? t('On-chain swaps.')
                  : t('Not on-chain swaps.')
                : t('Loading coordinator info...')}
            </Alert>
          </Grid>
        </ListItem>

        {!currentOrder.bad_request && currentOrder.maker_hash_id && (
          <>
            <Divider>
              <Chip label={t('Order Details')} />
            </Divider>

            <ListItem>
              <ListItemIcon>
                <div
                  style={{
                    zoom: 1.25,
                    opacity: 0.7,
                    msZoom: 1.25,
                    WebkitZoom: 1.25,
                    MozTransform: 'scale(1.25,1.25)',
                    MozTransformOrigin: 'left center',
                  }}
                >
                  <FlagWithProps code={currencyCode} width='1.2em' height='1.2em' />
                </div>
              </ListItemIcon>
              <ListItemText
                primary={amountString}
                secondary={(currentOrder?.amount ?? 0) > 0 ? 'Amount' : 'Amount Range'}
              />
              <ListItemIcon>
                <RobotAvatar
                  flipHorizontally
                  hashId={currentOrder.maker_hash_id}
                  statusColor={statusBadgeColor(currentOrder.maker_status)}
                  tooltip={t(currentOrder.maker_status)}
                />
              </ListItemIcon>
            </ListItem>

            <List dense={true} sx={{ position: 'relative', bottom: '0.5em' }}>
              <ListItem>
                <ListItemIcon sx={{ position: 'relative', left: '0.3em' }}>
                  <SendReceiveIcon
                    sx={{ transform: 'scaleX(-1)', width: '0.9em', opacity: 0.9 }}
                    color='secondary'
                  />
                </ListItemIcon>
                <Typography variant='body2'>{satsSummary.send}</Typography>
              </ListItem>

              <ListItem>
                <ListItemIcon sx={{ position: 'relative', left: '0.3em' }}>
                  <SendReceiveIcon
                    sx={{ left: '0.1em', width: '0.9em', opacity: 0.9 }}
                    color='primary'
                  />
                </ListItemIcon>
                <Typography variant='body2'>{satsSummary.receive}</Typography>
              </ListItem>
            </List>

            {showBuyerBadge ? (
              <Tooltip enterTouchDelay={0} title={buyerBadgeTooltip}>
                <ListItem sx={{ paddingTop: 0 }}>
                  <ListItemIcon>
                    <MilitaryTech sx={{ color: buyerBadgeIconColor }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={t('Buyer badge')}
                    secondary={buyerBadgeSecondary}
                    secondaryTypographyProps={{ sx: { color: buyerBadgeSecondaryColor } }}
                  />
                </ListItem>
              </Tooltip>
            ) : null}

            <Divider />

            <ListItem sx={{ paddingBottom: 0 }}>
              <ListItemIcon>
                <Payments />
              </ListItemIcon>
              <ListItemText
                onClick={() =>
                  orderReversiblePaymentMethods.length > 0 && setOpenWarningDialog(true)
                }
                primary={
                  <PaymentStringAsIcons
                    size={1.86 * theme.typography.fontSize}
                    othersText={t('Others')}
                    verbose={true}
                    text={currentOrder?.payment_method}
                  />
                }
              />
              {currentOrder?.payment_method.includes('Cash F2F') && (
                <ListItemIcon>
                  <Tooltip enterTouchDelay={0} title={t('F2F location')}>
                    <div>
                      <IconButton
                        onClick={() => {
                          setOpenWorldmap(true);
                        }}
                      >
                        <Map />
                      </IconButton>
                    </div>
                  </Tooltip>
                </ListItemIcon>
              )}
              {currentOrder.description && currentOrder.description !== '' && (
                <ListItemIcon>
                  <IconButton
                    onClick={() => {
                      setOpenDescription(true);
                    }}
                  >
                    <Description />
                  </IconButton>
                </ListItemIcon>
              )}
              {orderReversiblePaymentMethods.length > 0 && (
                <ListItemIcon>
                  <IconButton
                    onClick={() => {
                      setOpenWarningDialog(true);
                    }}
                  >
                    <Warning color='warning' />
                  </IconButton>
                </ListItemIcon>
              )}
            </ListItem>
            <ListItem sx={{ paddingTop: 0 }}>
              <ListItemIcon />
              <ListItemText
                sx={{ marginTop: 0 }}
                secondary={
                  currentOrder?.currency === 1000
                    ? t('Swap destination')
                    : t('Accepted payment methods')
                }
              />
            </ListItem>

            <Divider />

            {/* If there is live Price and Premium data, show it. Otherwise show the order maker settings */}
            <ListItem>
              <ListItemIcon>
                <PriceChange />
              </ListItemIcon>

              {currentOrder?.price_now !== undefined ? (
                <ListItemText
                  primary={t('{{price}} {{currencyCode}}/BTC - Premium: {{premium}}%', {
                    price: pn(currentOrder?.price_now),
                    currencyCode,
                    premium: currentOrder?.premium_now,
                  })}
                  secondary={t('Price and Premium')}
                />
              ) : null}

              {currentOrder?.price_now === undefined && currentOrder?.is_explicit ? (
                <ListItemText
                  primary={pn(currentOrder?.satoshis)}
                  secondary={t('Amount of Satoshis')}
                />
              ) : null}

              {currentOrder?.price_now === undefined && !currentOrder?.is_explicit ? (
                <ListItemText
                  primary={`${parseFloat(Number(currentOrder?.premium).toFixed(2))}%`}
                  secondary={t('Premium over market price')}
                />
              ) : null}
            </ListItem>

            {/* if order is in a status that does not expire, do not show countdown */}
            <Collapse in={![4, 5, 12, 13, 14, 15, 16, 17, 18].includes(currentOrder?.status ?? 0)}>
              <Divider />
              <Grid container direction='row' justifyContent='center' alignItems='center'>
                <ListItem style={{ width: '60%' }}>
                  <ListItemIcon>
                    <AccessTime />
                  </ListItemIcon>
                  <ListItemText secondary={t('Expires in')}>
                    <Countdown
                      date={new Date(currentOrder?.expires_at ?? '')}
                      renderer={countdownRenderer}
                    />
                  </ListItemText>
                </ListItem>

                <ListItem style={{ width: '40%' }}>
                  <ListItemIcon>
                    <HourglassTop />
                  </ListItemIcon>
                  <ListItemText
                    primary={timerRenderer(currentOrder?.escrow_duration)}
                    secondary={t('Deposit')}
                  />
                </ListItem>
              </Grid>
              <LinearDeterminate
                totalSecsExp={currentOrder?.total_secs_exp ?? 0}
                expiresAt={currentOrder?.expires_at ?? ''}
              />
            </Collapse>
          </>
        )}
      </List>

      {/* If the user has a penalty/limit */}
      {currentOrder?.penalty !== undefined ? (
        <Grid sx={{ marginBottom: 1, width: '100%', padding: '0 16px' }}>
          <Alert severity='warning' sx={{ borderRadius: '0' }}>
            <Countdown
              date={new Date(currentOrder?.penalty ?? '')}
              renderer={countdownPenaltyRenderer}
            />
          </Alert>
        </Grid>
      ) : (
        <></>
      )}

      {!currentOrder?.is_participant && currentOrder?.has_password && (
        <Grid item style={{ width: '100%', padding: '0 16px' }}>
          <TextField
            fullWidth
            label={`${t('Password')}`}
            type='password'
            value={password}
            style={{ marginBottom: 8 }}
            inputProps={{
              style: {
                textAlign: 'center',
                backgroundColor: theme.palette.background.paper,
                borderRadius: 4,
              },
            }}
            onChange={(e) => onPasswordChange(e.target.value)}
          />
        </Grid>
      )}

      {!currentOrder?.is_participant ? (
        <Grid item style={{ width: '100%', padding: '8px' }}>
          <TakeButton
            password={password}
            currentOrder={currentOrder}
            setCurrentOrder={setCurrentOrder}
            info={coordinator.info}
            onClickGenerateRobot={onClickGenerateRobot}
          />
        </Grid>
      ) : (
        <></>
      )}

      <OrderDescriptionDialog
        open={openDescription}
        onClose={() => setOpenDescription(false)}
        onClickBack={() => setOpenDescription(false)}
        order={currentOrder}
      />

      <Dialog
        open={openWarningDialog}
        onClose={() => {
          setOpenWarningDialog(false);
        }}
      >
        <DialogTitle>{t('Reversible payments')}</DialogTitle>
        <DialogContent>
          <DialogContentText component='div'>
            <Typography variant='body1' gutterBottom>
              {t(
                'This order offers one or multiple payment methods that the community has consistently reported as reverting their transactions.',
              )}
            </Typography>
          </DialogContentText>
          <DialogContentText
            component='div'
            sx={{ mt: 2 }}
            style={{ display: 'flex', justifyContent: 'space-around' }}
          >
            <PaymentStringAsIcons
              size={2.5 * theme.typography.fontSize}
              othersText={t('Others')}
              verbose={true}
              text={orderReversiblePaymentMethods.join(' ')}
              style={{ width: '30%' }}
            />
          </DialogContentText>
          <DialogContentText component='div'>
            <Box component='ul' sx={{ mt: 1, pl: 2 }}>
              <Typography component='li' variant='body2' sx={{ fontWeight: 'bold' }}>
                {t(
                  'If you receive a fiat transaction, it can be unilatery reverted up to 80 days after the trade has been completed.',
                )}
              </Typography>
              <Typography component='li' variant='body2'>
                {t('Robosats and their coordinators have no control over the fiat system.')}
              </Typography>
              <Typography component='li' variant='body2'>
                {t(
                  'Scammers can exploit this vulnerability in the fiat system to take away both your bitcoin and your fiat.',
                )}
              </Typography>
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setOpenWarningDialog(false);
            }}
          >
            {t('Acknowledged')}
          </Button>
        </DialogActions>
      </Dialog>
    </Grid>
  );
};

export default OrderDetails;
