/**
 * Poker Nite — Ledger, Venue Tags, Discrepancy Resolver & Minimum-Transaction Venmo Settlement
 *
 * Uses an exact Subset-Sum / Bitmask Dynamic Programming algorithm to partition
 * zero-sum groups and guarantee the minimum number of Venmo transactions.
 */

const STORAGE_KEYS = {
  ACTIVE_SESSION: 'pokernite_active_session_v6',
  HISTORY: 'pokernite_history_v1',
  ROSTER: 'pokernite_roster_v2',
  DENOMS: 'pokernite_denoms_v6',
  VENUES: 'pokernite_venues_v4',
};

const CHIP_META = [
  { id: 'white', label: 'White', color: '#e2e8f0' },
  { id: 'red', label: 'Red', color: '#ef4444' },
  { id: 'blue', label: 'Blue', color: '#3b82f6' },
  { id: 'green', label: 'Green', color: '#10b981' },
  { id: 'black', label: 'Black', color: '#1e293b' },
];

const BUILTIN_VENUES = [
  {
    id: 'jacques-basement',
    name: 'Jacques Basement',
    defaultBuyIn: 50,
    builtin: true,
    defaultPlayers: [
      { name: 'Jacques', venmo: '@jacques' },
      { name: 'Moose', venmo: '@moose' },
      { name: 'Namo', venmo: '@namo' },
    ],
    denoms: {
      white: 0.5,
      red: 2.5,
      blue: 5,
      green: 12.5,
      black: 50,
    },
  },
  {
    id: 'casa-kurtz',
    name: 'Casa Kurtz',
    defaultBuyIn: 100,
    builtin: true,
    defaultPlayers: [
      { name: 'Kurtz', venmo: '@kurtz' },
      { name: 'Tork', venmo: '@tork' },
      { name: 'Shuster', venmo: '@shuster' },
    ],
    denoms: {
      white: 1,
      red: 5,
      blue: 10,
      green: 25,
      black: 100,
    },
  },
  {
    id: 'dc',
    name: 'DC',
    defaultBuyIn: 10,
    builtin: true,
    defaultPlayers: [
      { name: 'Brian', venmo: '@brian' },
      { name: 'Sam', venmo: '@sam' },
      { name: 'Avner', venmo: '@avner' },
    ],
    denoms: {
      white: 0.1,
      red: 0.5,
      blue: 1,
      green: 2.5,
      black: 10,
    },
  },
];

function buildDenomsFromVenue(venue) {
  return CHIP_META.map((c) => ({
    ...c,
    value: Number(venue.denoms[c.id]) || 1,
  }));
}

let state = {
  venues: structuredClone(BUILTIN_VENUES),
  activeVenueId: 'jacques-basement',
  leaderboardVenueFilter: 'all', // 'all' | venueId
  venmoScope: 'main', // 'main' | 'combined' | 'sidepots'
  leaderboardVenueFilter: 'all', // 'all' | venueId
  venmoScope: 'main', // 'main' | 'combined' | 'sidepots'
  defaultBuyIn: 50,
  sessionTitle: getDefaultSessionTitle('Jacques Basement'),
  inputMode: 'dollar', // 'dollar' | 'chips'
  discrepancyStrategy: 'proportional', // 'proportional' | 'equal' | 'biggest_winner' | 'strict'
  roundToWholeDollars: false,
  denoms: buildDenomsFromVenue(BUILTIN_VENUES[0]),
  players: [],
  sidePots: [], // [{ id, name, defaultBet, bets: { [playerId]: { active: true, amount: 10 } }, winnerId: null }]
  paidMap: {}, // key: "from->to" => boolean
  history: [],
  roster: {}, // name => { name, venmo }
};

function getDefaultSessionTitle(venueName = 'Jacques Basement') {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${venueName} — ${formatted}`;
}

function uid() {
  return Math.random().toString(36).substring(2, 10);
}

function formatCurrency(amount, includePlus = false) {
  const clean = Math.abs(amount) < 0.005 ? 0 : amount;
  const sign = clean < 0 ? '-' : includePlus && clean > 0 ? '+' : '';
  const absVal = Math.abs(clean);
  return `${sign}$${absVal.toFixed(2)}`;
}

function formatChipValue(val) {
  const num = Number(val) || 0;
  if (Number.isInteger(num)) return `$${num}`;
  // e.g. 0.5 -> $0.50, 2.5 -> $2.50, 12.5 -> $12.50
  return `$${num.toFixed(2)}`;
}

function showToast(message) {
  const toastEl = document.getElementById('toast');
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 2800);
}

function getActiveVenue() {
  return state.venues.find((v) => v.id === state.activeVenueId) || state.venues[0];
}

/* ==========================================================================
   PERSISTENCE
   ========================================================================== */

function seedAllVenueDefaultPlayersToRoster() {
  for (const v of state.venues) {
    for (const p of v.defaultPlayers || []) {
      rememberPlayerInRoster(p.name, p.venmo);
    }
  }
}

function loadFromStorage() {
  try {
    const savedVenues = localStorage.getItem(STORAGE_KEYS.VENUES);
    if (savedVenues) {
      const customList = JSON.parse(savedVenues);
      // Ensure built-in venues are always present with exact defaults, plus any user-created custom venues
      const customOnly = Array.isArray(customList)
        ? customList.filter((v) => !BUILTIN_VENUES.some((b) => b.id === v.id))
        : [];
      state.venues = [...structuredClone(BUILTIN_VENUES), ...customOnly];
    }

    const savedHistory = localStorage.getItem(STORAGE_KEYS.HISTORY);
    if (savedHistory) {
      state.history = JSON.parse(savedHistory);
    }

    const savedRoster = localStorage.getItem(STORAGE_KEYS.ROSTER);
    if (savedRoster) {
      state.roster = JSON.parse(savedRoster);
    } else {
      // Seed venue regulars on first load
      seedAllVenueDefaultPlayersToRoster();
    }

    const savedSession = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    if (savedSession) {
      const parsed = JSON.parse(savedSession);
      state.activeVenueId = parsed.activeVenueId || 'jacques-basement';
      const venue = getActiveVenue();
      state.defaultBuyIn = Number(parsed.defaultBuyIn) || venue.defaultBuyIn;
      state.sessionTitle = parsed.sessionTitle || getDefaultSessionTitle(venue.name);
      state.inputMode = parsed.inputMode || 'dollar';
      state.discrepancyStrategy = parsed.discrepancyStrategy || 'proportional';
      state.roundToWholeDollars = Boolean(parsed.roundToWholeDollars);
      state.players = Array.isArray(parsed.players) ? parsed.players : [];
      state.sidePots = Array.isArray(parsed.sidePots) ? parsed.sidePots : [];
      state.venmoScope = parsed.venmoScope || 'main';
      state.paidMap = parsed.paidMap || {};

      const savedDenoms = localStorage.getItem(STORAGE_KEYS.DENOMS);
      if (savedDenoms) {
        state.denoms = JSON.parse(savedDenoms);
      } else {
        state.denoms = buildDenomsFromVenue(venue);
      }
    } else {
      applyVenuePreset('jacques-basement', false);
      seatVenueDefaultPlayers(false);
    }
  } catch (err) {
    console.error('Failed loading state from storage:', err);
  }
}

function saveActiveSession() {
  try {
    const payload = {
      activeVenueId: state.activeVenueId,
      defaultBuyIn: state.defaultBuyIn,
      sessionTitle: state.sessionTitle,
      inputMode: state.inputMode,
      discrepancyStrategy: state.discrepancyStrategy,
      roundToWholeDollars: state.roundToWholeDollars,
      venmoScope: state.venmoScope,
      players: state.players,
      sidePots: state.sidePots,
      paidMap: state.paidMap,
    };
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(payload));
    localStorage.setItem(STORAGE_KEYS.DENOMS, JSON.stringify(state.denoms));
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(state.history));
    localStorage.setItem(STORAGE_KEYS.ROSTER, JSON.stringify(state.roster));
    localStorage.setItem(STORAGE_KEYS.VENUES, JSON.stringify(state.venues));
  } catch (err) {
    console.error('Failed saving session:', err);
  }
}

function rememberPlayerInRoster(name, venmo) {
  const cleanName = (name || '').trim();
  if (!cleanName) return;
  const key = cleanName.toLowerCase();
  state.roster[key] = {
    name: cleanName,
    venmo: (venmo || '').trim() || (state.roster[key]?.venmo || ''),
  };
}

/* ==========================================================================
   VENUE PRESET MANAGEMENT
   ========================================================================== */

function applyVenuePreset(venueId, notify = true) {
  const venue = state.venues.find((v) => v.id === venueId);
  if (!venue) return;

  const prevVenue = getActiveVenue();
  const prevDefaultNames = (prevVenue.defaultPlayers || []).map((p) => p.name.toLowerCase()).join(',');
  const currentNames = state.players.map((p) => (p.name || '').trim().toLowerCase()).join(',');
  const isShowingDefaultSample = state.players.length === 0 || (prevDefaultNames && currentNames === prevDefaultNames);

  state.activeVenueId = venue.id;
  state.defaultBuyIn = venue.defaultBuyIn;
  state.denoms = buildDenomsFromVenue(venue);

  // Update session title if it still starts with the previous venue name or is empty
  if (
    !state.sessionTitle ||
    state.sessionTitle.startsWith(prevVenue.name) ||
    state.sessionTitle.startsWith('Poker Nite')
  ) {
    state.sessionTitle = getDefaultSessionTitle(venue.name);
  }

  // Update the new-player buy-in input box to the venue's default buy-in
  const buyinInput = document.getElementById('new-player-buyin');
  if (buyinInput) {
    buyinInput.value = venue.defaultBuyIn;
  }

  if (isShowingDefaultSample && Array.isArray(venue.defaultPlayers) && venue.defaultPlayers.length > 0) {
    seatVenueDefaultPlayers(false);
  } else if (state.inputMode === 'chips') {
    state.players.forEach((p) => recalcPlayerChipsFromCounts(p));
  }

  if (notify) {
    renderAll();
    showToast(`📍 Switched venue to ${venue.name} ($${venue.defaultBuyIn} buy-in)`);
  }
}

function getBuyInMultiples(baseBuyIn) {
  const b = Number(baseBuyIn) || 50;
  return [b * 0.5, b, b * 1.5, b * 2].map((v) => Math.round(v * 100) / 100);
}

/* ==========================================================================
   DISCREPANCY RECONCILIATION & NET BALANCE COMPUTATION
   ========================================================================== */

function computeTableBalances() {
  const players = state.players.map((p) => {
    const buyIn = Math.max(0, Number(p.buyIn) || 0);
    const endingChips = Math.max(0, Number(p.endingChips) || 0);
    const rawNet = endingChips - buyIn;
    return {
      ...p,
      buyIn,
      endingChips,
      rawNet,
      rawNetCents: Math.round(rawNet * 100),
      adjustedNetCents: Math.round(rawNet * 100),
    };
  });

  const totalBuyInCents = players.reduce((acc, p) => acc + Math.round(p.buyIn * 100), 0);
  const totalChipsCents = players.reduce((acc, p) => acc + Math.round(p.endingChips * 100), 0);
  const diffCents = totalChipsCents - totalBuyInCents;

  if (players.length > 0 && diffCents !== 0 && state.discrepancyStrategy !== 'strict') {
    const adjustmentNeeded = -diffCents;

    if (state.discrepancyStrategy === 'proportional') {
      const winners = players.filter((p) => p.rawNetCents > 0);
      const totalWinningCents = winners.reduce((s, p) => s + p.rawNetCents, 0);

      if (winners.length > 0 && totalWinningCents > 0) {
        let allocated = 0;
        winners.forEach((w, idx) => {
          if (idx === winners.length - 1) {
            w.adjustedNetCents += adjustmentNeeded - allocated;
          } else {
            const share = Math.round((adjustmentNeeded * w.rawNetCents) / totalWinningCents);
            w.adjustedNetCents += share;
            allocated += share;
          }
        });
      } else {
        distributeEvenly(players, adjustmentNeeded);
      }
    } else if (state.discrepancyStrategy === 'equal') {
      distributeEvenly(players, adjustmentNeeded);
    } else if (state.discrepancyStrategy === 'biggest_winner') {
      let topPlayer = players[0];
      for (const p of players) {
        if (p.rawNetCents > topPlayer.rawNetCents) {
          topPlayer = p;
        }
      }
      topPlayer.adjustedNetCents += adjustmentNeeded;
    }
  }

  // Optional: Round to nearest $1 (100 cents) while preserving exact zero-sum
  if (state.roundToWholeDollars && players.length > 0 && (diffCents === 0 || state.discrepancyStrategy !== 'strict')) {
    const rounded = players.map((p) => Math.round(p.adjustedNetCents / 100) * 100);
    let roundDiff = rounded.reduce((a, b) => a + b, 0);
    if (roundDiff !== 0) {
      let targetIdx = 0;
      for (let i = 1; i < players.length; i++) {
        if (Math.abs(players[i].adjustedNetCents) > Math.abs(players[targetIdx].adjustedNetCents)) {
          targetIdx = i;
        }
      }
      rounded[targetIdx] -= roundDiff;
    }
    players.forEach((p, idx) => {
      p.adjustedNetCents = rounded[idx];
    });
  }

  // Compute side pot net cents per player across all side pots that have a determined winner
  const sidePotCentsByPlayerId = {};
  players.forEach((p) => {
    sidePotCentsByPlayerId[p.id] = 0;
  });

  for (const sp of state.sidePots || []) {
    if (!sp.winnerId || !players.some((p) => p.id === sp.winnerId)) continue;
    let totalPotCents = 0;
    for (const p of players) {
      const entry = sp.bets?.[p.id];
      const active = entry ? Boolean(entry.active) : true;
      const amt = entry ? Math.max(0, Number(entry.amount) || 0) : Math.max(0, Number(sp.defaultBet) || 0);
      if (active && amt > 0) {
        const betCents = Math.round(amt * 100);
        sidePotCentsByPlayerId[p.id] -= betCents;
        totalPotCents += betCents;
      }
    }
    sidePotCentsByPlayerId[sp.winnerId] += totalPotCents;
  }

  players.forEach((p) => {
    p.sidePotNetCents = sidePotCentsByPlayerId[p.id] || 0;
    p.combinedNetCents = p.adjustedNetCents + p.sidePotNetCents;
  });

  return {
    players,
    totalBuyIn: totalBuyInCents / 100,
    totalChips: totalChipsCents / 100,
    diffCents,
    diffDollars: diffCents / 100,
  };
}

function distributeEvenly(players, totalAdjustmentCents) {
  const n = players.length;
  if (n === 0) return;
  const base = Math.trunc(totalAdjustmentCents / n);
  let remainder = totalAdjustmentCents - base * n;

  players.forEach((p) => {
    p.adjustedNetCents += base;
  });

  const step = remainder > 0 ? 1 : -1;
  let i = 0;
  while (remainder !== 0) {
    players[i % n].adjustedNetCents += step;
    remainder -= step;
    i++;
  }
}

/* ==========================================================================
   OPTIMAL MINIMUM-TRANSACTION SETTLEMENT ALGORITHM
   ========================================================================== */

function solveMinimumTransactions(balancedPlayers) {
  const nonZero = balancedPlayers
    .filter((p) => p.adjustedNetCents !== 0)
    .map((p) => ({
      id: p.id,
      name: p.name || 'Unnamed Player',
      venmo: p.venmo || '',
      cents: p.adjustedNetCents,
    }));

  const n = nonZero.length;
  if (n === 0) {
    return { transfers: [], zeroSumGroupsCount: 0, activePlayersCount: 0 };
  }

  const netSum = nonZero.reduce((s, p) => s + p.cents, 0);
  if (netSum !== 0) {
    return { transfers: [], zeroSumGroupsCount: 0, activePlayersCount: n, unbalanced: true };
  }

  const transfers = [];
  let zeroSumGroupsCount = 1;

  if (n <= 18) {
    const totalMasks = 1 << n;
    const sumMask = new Int32Array(totalMasks);
    const dp = new Int16Array(totalMasks).fill(-1);
    const choice = new Int32Array(totalMasks).fill(0);

    for (let i = 0; i < n; i++) {
      sumMask[1 << i] = nonZero[i].cents;
    }
    for (let mask = 1; mask < totalMasks; mask++) {
      const lsb = mask & -mask;
      sumMask[mask] = sumMask[lsb] + sumMask[mask ^ lsb];
    }

    dp[0] = 0;
    for (let mask = 1; mask < totalMasks; mask++) {
      if (sumMask[mask] !== 0) continue;

      const pivotBit = mask & -mask;
      for (let sub = mask; sub > 0; sub = (sub - 1) & mask) {
        if ((sub & pivotBit) === 0) continue;
        if (sumMask[sub] === 0 && dp[mask ^ sub] !== -1) {
          const candidate = dp[mask ^ sub] + 1;
          if (candidate > dp[mask]) {
            dp[mask] = candidate;
            choice[mask] = sub;
          }
        }
      }
    }

    const fullMask = totalMasks - 1;
    zeroSumGroupsCount = Math.max(1, dp[fullMask]);

    let curr = fullMask;
    while (curr > 0) {
      const sub = choice[curr] || curr;
      const subsetPlayers = [];
      for (let i = 0; i < n; i++) {
        if ((sub & (1 << i)) !== 0) {
          subsetPlayers.push({ ...nonZero[i] });
        }
      }
      settleSubsetGreedy(subsetPlayers, transfers);
      curr ^= sub;
    }
  } else {
    settleSubsetGreedy(nonZero, transfers);
  }

  transfers.sort((a, b) => b.cents - a.cents);

  return {
    transfers,
    zeroSumGroupsCount,
    activePlayersCount: n,
  };
}

function settleSubsetGreedy(group, outTransfers) {
  const debtors = group
    .filter((p) => p.cents < 0)
    .map((p) => ({ ...p, amount: -p.cents }));
  const creditors = group
    .filter((p) => p.cents > 0)
    .map((p) => ({ ...p, amount: p.cents }));

  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    const debtor = debtors[0];
    const creditor = creditors[0];
    const paymentCents = Math.min(debtor.amount, creditor.amount);

    if (paymentCents > 0) {
      outTransfers.push({
        fromId: debtor.id,
        fromName: debtor.name,
        fromVenmo: debtor.venmo,
        toId: creditor.id,
        toName: creditor.name,
        toVenmo: creditor.venmo,
        cents: paymentCents,
        dollars: paymentCents / 100,
      });
    }

    debtor.amount -= paymentCents;
    creditor.amount -= paymentCents;

    if (debtor.amount === 0) debtors.shift();
    if (creditor.amount === 0) creditors.shift();
  }
}

/* ==========================================================================
   CHIP COUNTER HELPERS
   ========================================================================== */

function recalcPlayerChipsFromCounts(player) {
  if (!player.chipCounts) return;
  let total = 0;
  for (const denom of state.denoms) {
    const count = Number(player.chipCounts[denom.id]) || 0;
    total += count * (Number(denom.value) || 0);
  }
  player.endingChips = Math.round(total * 100) / 100;
}

function buildStartingChipCounts() {
  // Standard starting stack in every game: 10 Whites, 10 Reds, 4 Blues (= 1x buy-in across all venues)
  return {
    white: 10,
    red: 10,
    blue: 4,
    green: 0,
    black: 0,
  };
}

function buildVenmoUrl(venmoHandle, amountDollars, sessionTitle) {
  const cleanHandle = (venmoHandle || '').replace(/^@/, '').trim();
  const note = encodeURIComponent(`Poker Nite (${sessionTitle})`);
  const amt = amountDollars.toFixed(2);
  if (cleanHandle) {
    return `https://venmo.com/${encodeURIComponent(cleanHandle)}?txn=pay&amount=${amt}&note=${note}`;
  }
  return `https://venmo.com/?txn=pay&amount=${amt}&note=${note}`;
}

/* ==========================================================================
   UI RENDERING
   ========================================================================== */

function renderAll() {
  document.getElementById('session-title').value = state.sessionTitle;
  document.getElementById('round-dollars-toggle').checked = state.roundToWholeDollars;

  // Update mode buttons
  document.getElementById('mode-dollar-btn').classList.toggle('active', state.inputMode === 'dollar');
  document.getElementById('mode-chips-btn').classList.toggle('active', state.inputMode === 'chips');

  // Update strategy radio buttons
  const strategyRadios = document.querySelectorAll('input[name="discrepancy-strategy"]');
  strategyRadios.forEach((r) => {
    r.checked = r.value === state.discrepancyStrategy;
  });

  // Update Venmo balance scope buttons
  document.querySelectorAll('button[data-venmo-scope]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-venmo-scope') === state.venmoScope);
  });

  renderVenueBar();
  renderBuyInIncrementControl();
  renderDenomConfig();
  renderRosterDatalist();
  renderPlayersAndSettlement();
  renderSidePots();
  renderLeaderboard();
  renderHistory();
  renderPlayersDirectory();
  saveActiveSession();
}

function renderVenueBar() {
  const pillsEl = document.getElementById('venue-pills');
  const summaryEl = document.getElementById('venue-summary-strip');
  const activeVenue = getActiveVenue();

  pillsEl.innerHTML = state.venues
    .map((v) => {
      const isActive = v.id === state.activeVenueId;
      const deleteBtn = !v.builtin
        ? `<span class="venue-pill-delete" data-delete-venue="${v.id}" title="Delete custom venue">✕</span>`
        : '';
      return `
        <button
          type="button"
          class="venue-pill ${isActive ? 'active' : ''}"
          data-venue-id="${v.id}"
        >
          <span>${escapeHtml(v.name)}</span>
          
          ${deleteBtn}
        </button>
      `;
    })
    .join('');

  pillsEl.querySelectorAll('.venue-pill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const delId = e.target.getAttribute('data-delete-venue');
      if (delId) {
        e.stopPropagation();
        state.venues = state.venues.filter((v) => v.id !== delId);
        if (state.activeVenueId === delId) {
          applyVenuePreset('jacques-basement', false);
        }
        renderAll();
        showToast('Removed custom venue preset.');
        return;
      }
      const id = btn.getAttribute('data-venue-id');
      applyVenuePreset(id, true);
    });
  });

  summaryEl.innerHTML = `
    ${state.denoms
      .map(
        (d) => `
        <span class="venue-chip-tag">
          <span class="chip-mini-dot" style="background: ${d.color}"></span>
          <strong>${formatChipValue(d.value)}</strong>
        </span>
      `
      )
      .join('')}
  `;
}

function renderBuyInIncrementControl() {
  const incBtn = document.getElementById('btn-increment-new-buyin');
  const decBtn = document.getElementById('btn-decrement-new-buyin');
  if (incBtn) {
    incBtn.textContent = `+`;
    incBtn.title = `Add 1 buy-in increment (+$${state.defaultBuyIn})`;
  }
  if (decBtn) {
    decBtn.textContent = `−`;
    decBtn.title = `Subtract 1 buy-in increment (-$${state.defaultBuyIn})`;
  }
}

function renderDenomConfig() {
  const listEl = document.getElementById('denom-config-list');
  listEl.innerHTML = state.denoms
    .map(
      (d) => `
      <div class="denom-config-item">
        <span class="poker-chip-dot" style="background: ${d.color}"></span>
        <div class="denom-config-info">
          <label>${d.label} Chip ($)</label>
          <input
            type="number"
            min="0.01"
            step="any"
            data-denom-id="${d.id}"
            value="${d.value}"
          />
        </div>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('input[data-denom-id]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const denomId = e.target.getAttribute('data-denom-id');
      const newVal = Math.max(0.01, parseFloat(e.target.value) || 1);
      const target = state.denoms.find((d) => d.id === denomId);
      if (target) {
        target.value = newVal;
        if (state.inputMode === 'chips') {
          state.players.forEach((p) => recalcPlayerChipsFromCounts(p));
        }
        renderAll();
      }
    });
  });
}

function renderRosterDatalist() {
  const datalist = document.getElementById('saved-players-datalist');
  if (!datalist) return;

  const activeVenue = getActiveVenue();
  const seen = new Set();
  const orderedOptions = [];

  // Put active venue's default players first (if still in roster), then other venues, then custom saved players
  const sortedVenues = [...state.venues].sort((a, b) =>
    a.id === activeVenue.id ? -1 : b.id === activeVenue.id ? 1 : 0
  );

  for (const v of sortedVenues) {
    for (const p of v.defaultPlayers || []) {
      const k = p.name.toLowerCase();
      if (state.roster[k] && !seen.has(k)) {
        seen.add(k);
        const r = state.roster[k];
        orderedOptions.push({ name: r.name, label: r.venmo || '' });
      }
    }
  }

  for (const r of Object.values(state.roster)) {
    const k = r.name.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      orderedOptions.push({ name: r.name, label: r.venmo || '' });
    }
  }

  datalist.innerHTML = orderedOptions
    .map((o) => `<option value="${escapeHtml(o.name)}">${escapeHtml(o.label)}</option>`)
    .join('');
}

function renderPlayersAndSettlement() {
  const balanceData = computeTableBalances();
  const { players, totalBuyIn, totalChips, diffCents, diffDollars } = balanceData;

  document.getElementById('kpi-players').textContent = players.length;
  document.getElementById('kpi-buyins').textContent = formatCurrency(totalBuyIn);
  document.getElementById('kpi-chips').textContent = formatCurrency(totalChips);

  const balanceCard = document.getElementById('kpi-balance-card');
  const discrepancyEl = document.getElementById('kpi-discrepancy');
  const discrepancyPanel = document.getElementById('discrepancy-panel');

  balanceCard.classList.remove('status-balanced', 'status-warning');

  if (players.length === 0 || diffCents === 0) {
    balanceCard.classList.add('status-balanced');
    discrepancyEl.textContent = 'Balanced ✓';
    discrepancyPanel.classList.add('hidden');
  } else {
    balanceCard.classList.add('status-warning');
    const label = diffDollars > 0 ? `+${formatCurrency(diffDollars)} Extra` : `${formatCurrency(diffDollars)} Short`;
    discrepancyEl.textContent = label;
    discrepancyPanel.classList.remove('hidden');

    const titleEl = document.getElementById('discrepancy-title');
    const descEl = document.getElementById('discrepancy-desc');
    if (diffDollars < 0) {
      titleEl.textContent = `Table is Short by ${formatCurrency(Math.abs(diffDollars))}`;
      descEl.textContent = `Counted chips (${formatCurrency(totalChips)}) are less than total buy-ins (${formatCurrency(totalBuyIn)}). Choose how to reconcile the missing ${formatCurrency(Math.abs(diffDollars))}:`;
    } else {
      titleEl.textContent = `Table has ${formatCurrency(diffDollars)} in Extra Chips`;
      descEl.textContent = `Counted chips (${formatCurrency(totalChips)}) exceed total buy-ins (${formatCurrency(totalBuyIn)}). Choose how to reconcile the extra ${formatCurrency(diffDollars)}:`;
    }
  }

  const fullRebuy = state.defaultBuyIn;

  // Render Players List
  const playersListEl = document.getElementById('players-list');
  if (players.length === 0) {
    playersListEl.innerHTML = `
      <div class="empty-state">
        No players at the table yet. Add players above or click <strong>Reset Table</strong> to seat the venue's default players.
      </div>
    `;
  } else {
    playersListEl.innerHTML = players
      .map((p) => {
        const rawNetDollars = p.rawNetCents / 100;
        const adjNetDollars = p.adjustedNetCents / 100;
        const netClass = adjNetDollars > 0.004 ? 'positive' : adjNetDollars < -0.004 ? 'negative' : 'even';
        const showAdjustedNote = p.rawNetCents !== p.adjustedNetCents;

        const chipTrayHtml =
          state.inputMode === 'chips'
            ? `
          <div class="chip-counter-tray">
            ${state.denoms
              .map((d) => {
                const count = Number(p.chipCounts?.[d.id]) || 0;
                const sub = count * d.value;
                return `
                <div class="chip-counter-cell">
                  <div class="chip-cell-top">
                    <span class="chip-label-group">
                      <span class="chip-mini-dot" style="background: ${d.color}"></span>
                      ${formatChipValue(d.value)}
                    </span>
                    <span class="chip-subtotal">${formatCurrency(sub)}</span>
                  </div>
                  <div class="chip-stepper">
                    <button type="button" class="step-btn step-btn-10" data-action="chip-step" data-player-id="${p.id}" data-denom-id="${d.id}" data-delta="-10" title="Subtract 10 chips">−10</button>
                    <button type="button" class="step-btn" data-action="chip-step" data-player-id="${p.id}" data-denom-id="${d.id}" data-delta="-1" title="Subtract 1 chip">−</button>
                    <input
                      type="text"
                      inputmode="numeric"
                      class="chip-count-input"
                      data-action="chip-input"
                      data-player-id="${p.id}"
                      data-denom-id="${d.id}"
                      value="${count}"
                    />
                    <button type="button" class="step-btn" data-action="chip-step" data-player-id="${p.id}" data-denom-id="${d.id}" data-delta="1" title="Add 1 chip">+</button>
                    <button type="button" class="step-btn step-btn-10" data-action="chip-step" data-player-id="${p.id}" data-denom-id="${d.id}" data-delta="10" title="Add 10 chips">+10</button>
                  </div>
                </div>
              `;
              })
              .join('')}
          </div>
        `
            : '';

        return `
        <div class="player-row" data-player-row="${p.id}">
          <div class="player-main-line">
            <div class="player-identity">
              <input
                type="text"
                class="player-name-input"
                list="saved-players-datalist"
                data-action="edit-name"
                data-player-id="${p.id}"
                value="${escapeHtml(p.name)}"
                placeholder="Player Name"
              />
              <input
                type="text"
                class="player-venmo-input"
                data-action="edit-venmo"
                data-player-id="${p.id}"
                value="${escapeHtml(p.venmo || '')}"
                placeholder="@venmo-handle (optional)"
              />
            </div>

            <div class="field-col">
              <span class="field-col-label">Buy-In + Rebuys</span>
              <div class="stepper-capsule">
                <button type="button" class="capsule-btn" data-action="quick-rebuy" data-player-id="${p.id}" data-amount="-${fullRebuy}" title="Subtract 1 buy-in increment (-$${fullRebuy})">−</button>
                <div class="capsule-field">
                  <span>$</span>
                  <input
                    type="text"
                    inputmode="decimal"
                    data-action="edit-buyin"
                    data-player-id="${p.id}"
                    value="${p.buyIn}"
                  />
                </div>
                <button type="button" class="capsule-btn" data-action="quick-rebuy" data-player-id="${p.id}" data-amount="${fullRebuy}" title="Add 1 buy-in increment (+$${fullRebuy})">+</button>
              </div>
            </div>

            <div class="field-col">
              <span class="field-col-label">${state.inputMode === 'chips' ? 'Counted Chips ($)' : 'Ending Chips ($)'}</span>
              <div class="currency-field">
                <span>$</span>
                <input
                  type="text"
                  inputmode="decimal"
                  data-action="edit-chips"
                  data-player-id="${p.id}"
                  value="${p.endingChips}"
                  ${state.inputMode === 'chips' ? 'readonly title="Calculated from chip counts below"' : ''}
                />
              </div>
            </div>

            <div class="field-col" style="align-items: flex-end;">
              <span class="field-col-label">Net Up / Down</span>
              <span class="net-badge ${netClass}" data-net-badge="${p.id}">
                ${formatCurrency(adjNetDollars, true)}
              </span>
              <div class="adjusted-sub ${showAdjustedNote ? '' : 'hidden'}" data-adj-note="${p.id}">
                Raw: ${formatCurrency(rawNetDollars, true)}
              </div>
            </div>

            <button
              type="button"
              class="btn-remove-player"
              data-action="remove-player"
              data-player-id="${p.id}"
              title="Remove player"
            >✕</button>
          </div>
          ${chipTrayHtml}
        </div>
      `;
      })
      .join('');
  }

  renderSettlementPanel(balanceData);
  renderNetStandings(players);
}

function getScopedPlayersForSettlement(players) {
  return players.map((p) => {
    const scopedCents =
      state.venmoScope === 'combined'
        ? p.combinedNetCents
        : state.venmoScope === 'sidepots'
          ? p.sidePotNetCents
          : p.adjustedNetCents;
    return {
      ...p,
      adjustedNetCents: scopedCents,
    };
  });
}

function renderSettlementPanel(balanceData) {
  const { players, diffCents } = balanceData;
  const container = document.getElementById('transfers-container');
  const statsEl = document.getElementById('optimization-stats');

  if (players.length < 2) {
    statsEl.textContent = 'Add at least 2 players to calculate optimal Venmo payouts';
    container.innerHTML = `<div class="empty-state">Waiting for players and chip counts...</div>`;
    return;
  }

  if (state.venmoScope !== 'sidepots' && diffCents !== 0 && state.discrepancyStrategy === 'strict') {
    statsEl.textContent = 'Settlement paused until chip count matches total buy-ins';
    container.innerHTML = `
      <div class="empty-state">
        ⚠️ <strong>Recount Required:</strong> Total counted chips are off by <strong>${formatCurrency(Math.abs(diffCents / 100))}</strong>.
        Either recount the stacks or select a discrepancy resolution rule above.
      </div>
    `;
    return;
  }

  const scopedPlayers = getScopedPlayersForSettlement(players);
  const result = solveMinimumTransactions(scopedPlayers);
  const { transfers, activePlayersCount } = result;

  const scopeLabel =
    state.venmoScope === 'combined'
      ? 'Combined (Main + Side Pots)'
      : state.venmoScope === 'sidepots'
        ? 'Side Pots Only'
        : 'Main Game';

  if (transfers.length === 0) {
    statsEl.textContent = `${scopeLabel}: Everyone is square — 0 transactions needed!`;
    container.innerHTML = `
      <div class="empty-state">
        🎉 Every player broke even or is settled for <strong>${scopeLabel}</strong>. No Venmo transfers needed!
      </div>
    `;
    return;
  }

  statsEl.textContent = `${scopeLabel}: ${transfers.length} optimal Venmo transfer${transfers.length === 1 ? '' : 's'} for ${activePlayersCount} active players`;

  container.innerHTML = transfers
    .map((t) => {
      const key = `${state.venmoScope}:${t.fromName}->${t.toName}`;
      const isPaid = Boolean(state.paidMap[key]);
      const venmoUrl = buildVenmoUrl(t.toVenmo, t.dollars, `${state.sessionTitle} (${scopeLabel})`);
      const handleDisplay = t.toVenmo ? `<span class="transfer-handle">(${escapeHtml(t.toVenmo)})</span>` : '';

      return `
        <div class="transfer-item ${isPaid ? 'paid' : ''}">
          <div class="transfer-left">
            <input
              type="checkbox"
              class="paid-checkbox"
              data-transfer-key="${escapeHtml(key)}"
              ${isPaid ? 'checked' : ''}
              title="Mark transfer as paid"
            />
            <div class="transfer-route">
              <span class="payer-name">${escapeHtml(t.fromName)}</span>
              <span class="pay-arrow">pays →</span>
              <span class="payee-name">${escapeHtml(t.toName)}</span>
              ${handleDisplay}
            </div>
          </div>

          <div class="transfer-right">
            <span class="transfer-amount">${formatCurrency(t.dollars)}</span>
            <a
              href="${venmoUrl}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn-venmo"
              title="Open Venmo with amount and note pre-filled"
            >
              Venmo ↗
            </a>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.paid-checkbox').forEach((box) => {
    box.addEventListener('change', (e) => {
      const k = e.target.getAttribute('data-transfer-key');
      state.paidMap[k] = e.target.checked;
      renderPlayersAndSettlement();
      saveActiveSession();
    });
  });
}

function renderNetStandings(players) {
  const listEl = document.getElementById('net-standings-list');
  if (players.length === 0) {
    listEl.innerHTML = `<div class="text-muted text-xs">No players added yet.</div>`;
    return;
  }

  const getCents = (p) =>
    state.venmoScope === 'combined'
      ? p.combinedNetCents
      : state.venmoScope === 'sidepots'
        ? p.sidePotNetCents
        : p.adjustedNetCents;

  const sorted = [...players].sort((a, b) => getCents(b) - getCents(a));
  listEl.innerHTML = sorted
    .map((p, idx) => {
      const net = getCents(p) / 100;
      const sideNet = (p.sidePotNetCents || 0) / 100;
      const colorClass = net > 0.004 ? 'text-emerald' : net < -0.004 ? 'text-crimson' : 'text-muted';
      const medal = idx === 0 && net > 0 ? '👑' : `${idx + 1}.`;
      const detailText =
        state.venmoScope === 'combined' && Math.abs(sideNet) > 0.004
          ? `Main: ${formatCurrency(p.adjustedNetCents / 100, true)} | Side: ${formatCurrency(sideNet, true)}`
          : state.venmoScope === 'sidepots'
            ? `Side Pots Net`
            : `In: ${formatCurrency(p.buyIn)} → Out: ${formatCurrency(p.endingChips)}`;

      return `
        <div class="standing-row">
          <div class="standing-player">
            <span class="standing-rank">${medal}</span>
            <span>${escapeHtml(p.name)}</span>
          </div>
          <div class="standing-details">
            <span class="text-muted">${detailText}</span>
            <strong class="${colorClass}">${formatCurrency(net, true)}</strong>
          </div>
        </div>
      `;
    })
    .join('');
}

/* ==========================================================================
   SIDE POTS MANAGEMENT & RENDERING
   ========================================================================== */

function createNewSidePot() {
  const index = (state.sidePots?.length || 0) + 1;
  const defaultBet = Math.max(5, Math.round(state.defaultBuyIn * 0.2));
  const bets = {};
  state.players.forEach((p) => {
    bets[p.id] = { active: true, amount: defaultBet };
  });

  state.sidePots.push({
    id: uid(),
    name: `Side Pot #${index}`,
    defaultBet,
    bets,
    winnerId: state.players[0]?.id || null,
  });
}

function syncSidePotPlayers() {
  for (const sp of state.sidePots || []) {
    if (!sp.bets) sp.bets = {};
    for (const p of state.players) {
      if (!sp.bets[p.id]) {
        sp.bets[p.id] = { active: true, amount: Number(sp.defaultBet) || 10 };
      }
    }
    if (sp.winnerId && !state.players.some((p) => p.id === sp.winnerId)) {
      sp.winnerId = state.players[0]?.id || null;
    }
  }
}

function renderSidePots() {
  syncSidePotPlayers();

  const badgeEl = document.getElementById('sidepots-count-badge');
  if (badgeEl) badgeEl.textContent = (state.sidePots || []).length;

  const listEl = document.getElementById('sidepots-list');
  if (!listEl) return;

  if (state.players.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        Add players on <strong>Tonight's Table</strong> first to create side pots.
      </div>
    `;
  } else if ((state.sidePots || []).length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        No side pots yet. Click <strong>+ New Side Pot</strong> above to start a side bet (e.g., High Hand, Bomb Pot, 7-2 Bounty, Last Longer) where each player puts in a bet and one winner takes the pot!
      </div>
    `;
  } else {
    listEl.innerHTML = state.sidePots
      .map((sp) => {
        let potTotal = 0;
        for (const p of state.players) {
          const entry = sp.bets?.[p.id];
          if (entry?.active) {
            potTotal += Math.max(0, Number(entry.amount) || 0);
          }
        }
        const winnerPlayer = state.players.find((p) => p.id === sp.winnerId);

        return `
          <div class="sidepot-card" data-sidepot-id="${sp.id}">
            <div class="sidepot-card-top">
              <input
                type="text"
                class="sidepot-title-input"
                data-sp-action="edit-title"
                data-sp-id="${sp.id}"
                value="${escapeHtml(sp.name)}"
                placeholder="Side Pot Name (e.g., High Hand)"
              />

              <div class="sidepot-controls-right">
                <div class="quick-buyin-selector">
                  <span class="quick-label">Bet Each:</span>
                  <div class="currency-field compact">
                    <span>$</span>
                    <input
                      type="text"
                      inputmode="decimal"
                      data-sp-action="edit-default-bet"
                      data-sp-id="${sp.id}"
                      value="${sp.defaultBet}"
                      title="Set bet amount for all participants in this side pot"
                    />
                  </div>
                </div>
                <span class="sidepot-pot-badge">Pot: ${formatCurrency(potTotal)}</span>
                <button
                  type="button"
                  class="btn-remove-player"
                  data-sp-action="delete-sidepot"
                  data-sp-id="${sp.id}"
                  title="Delete side pot"
                >✕</button>
              </div>
            </div>

            <div class="sidepot-participants-grid">
              ${state.players
                .map((p) => {
                  const entry = sp.bets?.[p.id] || { active: true, amount: sp.defaultBet };
                  return `
                    <div class="sidepot-player-item ${entry.active ? '' : 'inactive'}">
                      <label class="sidepot-player-check">
                        <input
                          type="checkbox"
                          data-sp-action="toggle-player"
                          data-sp-id="${sp.id}"
                          data-player-id="${p.id}"
                          ${entry.active ? 'checked' : ''}
                        />
                        <span>${escapeHtml(p.name)}</span>
                      </label>
                      <div class="currency-field compact">
                        <span>$</span>
                        <input
                          type="text"
                          inputmode="decimal"
                          data-sp-action="edit-player-bet"
                          data-sp-id="${sp.id}"
                          data-player-id="${p.id}"
                          value="${entry.amount}"
                          ${entry.active ? '' : 'disabled'}
                        />
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>

            <div class="sidepot-winner-bar">
              <span class="quick-label">🏆 Determined Winner (${winnerPlayer ? `${escapeHtml(winnerPlayer.name)} takes ${formatCurrency(potTotal)}` : 'Select Winner'}):</span>
              <div class="sidepot-winner-pills">
                ${state.players
                  .map((p) => {
                    const isWinner = sp.winnerId === p.id;
                    return `
                      <button
                        type="button"
                        class="winner-pill ${isWinner ? 'selected' : ''}"
                        data-sp-action="select-winner"
                        data-sp-id="${sp.id}"
                        data-player-id="${p.id}"
                      >
                        ${isWinner ? '🏆 ' : ''}${escapeHtml(p.name)}
                      </button>
                    `;
                  })
                  .join('')}
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Render Side Pots Only Settlement & Standings on the Side Pots tab
  const balanceData = computeTableBalances();
  const sidePotOnlyPlayers = balanceData.players.map((p) => ({
    ...p,
    adjustedNetCents: p.sidePotNetCents || 0,
  }));

  const transfersContainer = document.getElementById('sidepots-transfers-container');
  const statsEl = document.getElementById('sidepots-settlement-stats');
  const standingsEl = document.getElementById('sidepots-standings-list');

  if (transfersContainer && statsEl) {
    const res = solveMinimumTransactions(sidePotOnlyPlayers);
    if (res.transfers.length === 0) {
      statsEl.textContent = '0 transactions needed for side pots';
      transfersContainer.innerHTML = `<div class="empty-state">Create a side pot and pick a winner to see side-pot Venmo payouts.</div>`;
    } else {
      statsEl.textContent = `${res.transfers.length} optimal Venmo transfer${res.transfers.length === 1 ? '' : 's'} for Side Pots`;
      transfersContainer.innerHTML = res.transfers
        .map((t) => {
          const venmoUrl = buildVenmoUrl(t.toVenmo, t.dollars, `${state.sessionTitle} (Side Pots)`);
          const handleDisplay = t.toVenmo ? `<span class="transfer-handle">(${escapeHtml(t.toVenmo)})</span>` : '';
          return `
            <div class="transfer-item">
              <div class="transfer-left">
                <div class="transfer-route">
                  <span class="payer-name">${escapeHtml(t.fromName)}</span>
                  <span class="pay-arrow">pays →</span>
                  <span class="payee-name">${escapeHtml(t.toName)}</span>
                  ${handleDisplay}
                </div>
              </div>
              <div class="transfer-right">
                <span class="transfer-amount">${formatCurrency(t.dollars)}</span>
                <a href="${venmoUrl}" target="_blank" rel="noopener noreferrer" class="btn-venmo">Venmo ↗</a>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  if (standingsEl) {
    const sorted = [...sidePotOnlyPlayers].sort((a, b) => b.adjustedNetCents - a.adjustedNetCents);
    standingsEl.innerHTML = sorted
      .map((p, idx) => {
        const net = p.adjustedNetCents / 100;
        const colorClass = net > 0.004 ? 'text-emerald' : net < -0.004 ? 'text-crimson' : 'text-muted';
        const medal = idx === 0 && net > 0 ? '👑' : `${idx + 1}.`;
        return `
          <div class="standing-row">
            <div class="standing-player">
              <span class="standing-rank">${medal}</span>
              <span>${escapeHtml(p.name)}</span>
            </div>
            <div class="standing-details">
              <strong class="${colorClass}">${formatCurrency(net, true)}</strong>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

/* ==========================================================================
   LEADERBOARD & HISTORY RENDERING
   ========================================================================== */

function renderLeaderboard() {
  const container = document.getElementById('leaderboard-container');
  const pillsEl = document.getElementById('leaderboard-venue-pills');
  const headingEl = document.getElementById('leaderboard-heading');
  const subtitleEl = document.getElementById('leaderboard-subtitle');
  const allHistory = state.history || [];

  // Render Venue Filter Pills
  if (pillsEl) {
    const venueFilterOptions = [
      { id: 'all', name: 'All Venues', count: allHistory.length },
      ...state.venues.map((v) => ({
        id: v.id,
        name: v.name,
        count: allHistory.filter((h) => h.venueId === v.id || h.venueName === v.name).length,
      })),
    ];

    pillsEl.innerHTML = venueFilterOptions
      .map((opt) => {
        const isActive = state.leaderboardVenueFilter === opt.id;
        return `
          <button
            type="button"
            class="venue-pill ${isActive ? 'active' : ''}"
            data-lb-venue="${opt.id}"
          >
            <span>${escapeHtml(opt.name)}</span>
            <span class="venue-pill-buyin">${opt.count}</span>
          </button>
        `;
      })
      .join('');

    pillsEl.querySelectorAll('button[data-lb-venue]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.leaderboardVenueFilter = btn.getAttribute('data-lb-venue');
        renderLeaderboard();
      });
    });
  }

  const selectedVenue = state.venues.find((v) => v.id === state.leaderboardVenueFilter);
  const filteredHistory =
    state.leaderboardVenueFilter === 'all' || !selectedVenue
      ? allHistory
      : allHistory.filter((h) => h.venueId === selectedVenue.id || h.venueName === selectedVenue.name);

  if (headingEl && subtitleEl) {
    if (selectedVenue) {
      headingEl.textContent = `📍 ${selectedVenue.name} Leaderboard`;
      subtitleEl.textContent = `Standings across ${filteredHistory.length} saved night${filteredHistory.length === 1 ? '' : 's'} at ${selectedVenue.name} ($${selectedVenue.defaultBuyIn} default buy-in).`;
    } else {
      headingEl.textContent = `All-Time Poker Club Leaderboard`;
      subtitleEl.textContent = `Cumulative stats across all ${allHistory.length} saved poker night${allHistory.length === 1 ? '' : 's'} across all venues.`;
    }
  }

  if (filteredHistory.length === 0) {
    const emptyMsg = selectedVenue
      ? `No saved poker nights for <strong>${escapeHtml(selectedVenue.name)}</strong> yet. Save a game with the ${escapeHtml(selectedVenue.name)} venue tag selected to populate this leaderboard!`
      : `No saved poker nights yet. Click <strong>💾 Save Night to History</strong> on Tonight's Table after finishing a game to build your club leaderboard!`;
    container.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    return;
  }

  const statsMap = new Map();

  for (const session of filteredHistory) {
    for (const p of session.players || []) {
      const cleanName = (p.name || 'Unnamed').trim();
      const key = cleanName.toLowerCase();
      if (!statsMap.has(key)) {
        statsMap.set(key, {
          name: cleanName,
          venmo: p.venmo || '',
          games: 0,
          wins: 0,
          totalBuyIn: 0,
          totalCashOut: 0,
          netProfit: 0,
          bestWin: null,
          worstLoss: null,
        });
      }
      const entry = statsMap.get(key);
      if (p.venmo) entry.venmo = p.venmo;
      entry.games += 1;
      entry.totalBuyIn += Number(p.buyIn) || 0;
      entry.totalCashOut += Number(p.endingChips) || 0;
      const net = Number(p.adjustedNet) ?? (Number(p.endingChips) - Number(p.buyIn));
      entry.netProfit += net;
      if (net > 0.005) entry.wins += 1;
      if (entry.bestWin === null || net > entry.bestWin) entry.bestWin = net;
      if (entry.worstLoss === null || net < entry.worstLoss) entry.worstLoss = net;
    }
  }

  const rows = Array.from(statsMap.values()).sort((a, b) => b.netProfit - a.netProfit);

  container.innerHTML = `
    <div style="overflow-x: auto;">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>Nights Played</th>
            <th>Win Rate</th>
            <th>Total Buy-Ins</th>
            <th>Avg Profit / Night</th>
            <th>Best Night</th>
            <th>Cumulative Net</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r, i) => {
              const winRate = r.games > 0 ? Math.round((r.wins / r.games) * 100) : 0;
              const avgNet = r.games > 0 ? r.netProfit / r.games : 0;
              const netClass = r.netProfit > 0.005 ? 'text-emerald' : r.netProfit < -0.005 ? 'text-crimson' : 'text-muted';
              const rankBadge = i === 0 ? '🥇 1' : i === 1 ? '🥈 2' : i === 2 ? '🥉 3' : `#${i + 1}`;

              return `
                <tr>
                  <td class="mono">${rankBadge}</td>
                  <td>
                    <strong>${escapeHtml(r.name)}</strong>
                    ${r.venmo ? `<div class="text-muted text-xs mono">${escapeHtml(r.venmo)}</div>` : ''}
                  </td>
                  <td class="mono">${r.games}</td>
                  <td class="mono">${winRate}% (${r.wins}W)</td>
                  <td class="mono">${formatCurrency(r.totalBuyIn)}</td>
                  <td class="mono ${avgNet >= 0 ? 'text-emerald' : 'text-crimson'}">${formatCurrency(avgNet, true)}</td>
                  <td class="mono text-emerald">${formatCurrency(r.bestWin || 0, true)}</td>
                  <td class="mono"><strong class="${netClass}">${formatCurrency(r.netProfit, true)}</strong></td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderHistory() {
  const badge = document.getElementById('history-count-badge');
  badge.textContent = state.history.length;

  const container = document.getElementById('history-list-container');
  if (state.history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        No saved poker nights yet. Once you save a session, it will appear here with full player results, venue tag, and Venmo transfers.
      </div>
    `;
    return;
  }

  container.innerHTML = state.history
    .map((item) => {
      const dateStr = new Date(item.savedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const venueBadge = item.venueName
        ? `<span class="venue-badge-tag">📍 ${escapeHtml(item.venueName)}</span>`
        : '';

      return `
        <div class="history-card">
          <div class="history-card-header">
            <div>
              <div class="history-card-title">
                ${escapeHtml(item.title)}
                ${venueBadge}
              </div>
              <div class="history-card-meta">Saved ${dateStr} • ${item.players.length} Players • Total Pot: ${formatCurrency(item.totalBuyIn)}</div>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <button type="button" class="btn btn-outline btn-xs" data-action="load-history" data-id="${item.id}">
                📂 Load into Table
              </button>
              <button type="button" class="btn btn-danger-ghost btn-xs" data-action="delete-history" data-id="${item.id}">
                Delete
              </button>
            </div>
          </div>

          <div class="history-card-grid">
            <div>
              <div class="history-sub-title">Player Standings</div>
              <div class="history-pills">
                ${item.players
                  .sort((a, b) => b.adjustedNet - a.adjustedNet)
                  .map((p) => {
                    const cls = p.adjustedNet > 0 ? 'text-emerald' : p.adjustedNet < 0 ? 'text-crimson' : 'text-muted';
                    return `<span class="history-pill">${escapeHtml(p.name)}: <strong class="${cls}">${formatCurrency(p.adjustedNet, true)}</strong></span>`;
                  })
                  .join('')}
              </div>
            </div>

            <div>
              <div class="history-sub-title">Venmo Settlements (${item.transfers.length})</div>
              <div class="history-pills">
                ${
                  item.transfers.length === 0
                    ? '<span class="text-muted text-xs">No transfers required</span>'
                    : item.transfers
                        .map(
                          (t) =>
                            `<span class="history-pill"><span class="text-crimson">${escapeHtml(t.fromName)}</span> → <span class="text-emerald">${escapeHtml(t.toName)}</span>: <strong>${formatCurrency(t.dollars)}</strong></span>`
                        )
                        .join('')
                }
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('button[data-action="load-history"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const found = state.history.find((h) => h.id === id);
      if (!found) return;
      if (found.venueId && state.venues.some((v) => v.id === found.venueId)) {
        applyVenuePreset(found.venueId, false);
      }
      state.sessionTitle = found.title;
      state.players = found.players.map((p) => ({
        id: uid(),
        name: p.name,
        venmo: p.venmo || '',
        buyIn: p.buyIn,
        endingChips: p.endingChips,
        chipCounts: p.chipCounts || { white: 0, red: 0, blue: 0, green: 0, black: 0 },
      }));
      state.paidMap = {};
      switchTab('tonight');
      renderAll();
      showToast(`Loaded "${found.title}" onto the table!`);
    });
  });

  container.querySelectorAll('button[data-action="delete-history"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      state.history = state.history.filter((h) => h.id !== id);
      renderAll();
      showToast('Removed session from history.');
    });
  });
}

function renderPlayersDirectory() {
  const container = document.getElementById('directory-list-container');
  const badgeEl = document.getElementById('players-roster-badge');
  if (!container) return;

  const entries = Object.entries(state.roster).sort((a, b) =>
    (a[1].name || '').localeCompare(b[1].name || '')
  );

  if (badgeEl) {
    badgeEl.textContent = String(entries.length);
  }

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        No saved players in the directory. Add players above or click <strong>Restore Venue Regulars Only</strong>.
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="directory-grid">
      ${entries
        .map(([key, r]) => {
          return `
            <div class="directory-row">
              <div class="directory-player-info">
                <span class="directory-player-name">${escapeHtml(r.name)}</span>
                <input
                  type="text"
                  class="directory-venmo-input"
                  data-roster-action="edit-venmo"
                  data-roster-key="${escapeHtml(key)}"
                  value="${escapeHtml(r.venmo || '')}"
                  placeholder="@venmo-handle"
                />
              </div>
              <button
                type="button"
                class="btn-remove-player"
                data-roster-action="delete-player"
                data-roster-key="${escapeHtml(key)}"
                title="Remove ${escapeHtml(r.name)} from saved players"
              >✕</button>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

/* ==========================================================================
   VENUE REGULARS & ACTIONS
   ========================================================================== */

function seatVenueDefaultPlayers(notify = true) {
  const venue = getActiveVenue();
  const base = venue.defaultBuyIn;

  state.sessionTitle = getDefaultSessionTitle(venue.name);
  state.paidMap = {};
  state.sidePots = [];

  const venueRoster =
    Array.isArray(venue.defaultPlayers) && venue.defaultPlayers.length > 0
      ? venue.defaultPlayers
      : [];

  state.players = venueRoster.map((person) => {
    const p = {
      id: uid(),
      name: person.name,
      venmo: person.venmo || '',
      buyIn: base,
      endingChips: base,
      chipCounts: buildStartingChipCounts(base),
    };
    if (state.inputMode === 'chips') {
      recalcPlayerChipsFromCounts(p);
    }
    return p;
  });

  state.players.forEach((p) => rememberPlayerInRoster(p.name, p.venmo));
  if (notify) {
    renderAll();
    showToast(`Seated ${venue.name} defaults (${venueRoster.map((r) => r.name).join(', ')}) at $${base} buy-in.`);
  }
}

function copyGroupChatSummary() {
  const balanceData = computeTableBalances();
  const { players, totalBuyIn, diffCents } = balanceData;
  if (players.length === 0) {
    showToast('Add players first to copy a summary.');
    return;
  }

  const activeVenue = getActiveVenue();
  const scopedPlayers = getScopedPlayersForSettlement(players);
  const { transfers } = solveMinimumTransactions(scopedPlayers);
  const scopeLabel =
    state.venmoScope === 'combined'
      ? 'Combined (Main + Side Pots)'
      : state.venmoScope === 'sidepots'
        ? 'Side Pots Only'
        : 'Main Game';

  const lines = [];
  lines.push(`♠️ ${state.sessionTitle.toUpperCase()} — PAYOUT SUMMARY (${scopeLabel.toUpperCase()}) ♠️`);
  lines.push(`📍 Venue: ${activeVenue.name} | Total Pot: ${formatCurrency(totalBuyIn)} (${players.length} players)`);
  if (diffCents !== 0 && state.venmoScope !== 'sidepots') {
    lines.push(
      `Note: Chip count difference of ${formatCurrency(diffCents / 100, true)} reconciled (${state.discrepancyStrategy}).`
    );
  }
  lines.push('');
  lines.push(`💸 VENMO SETTLEMENTS (${scopeLabel} — Min Transactions):`);
  if (transfers.length === 0) {
    lines.push('• Everyone broke even — no transfers needed!');
  } else {
    transfers.forEach((t) => {
      const handle = t.toVenmo ? ` (${t.toVenmo})` : '';
      lines.push(`• ${t.fromName} ➡️ ${t.toName}${handle}: ${formatCurrency(t.dollars)}`);
    });
  }

  lines.push('');
  lines.push(`📊 NET STANDINGS (${scopeLabel}):`);
  const sorted = [...scopedPlayers].sort((a, b) => b.adjustedNetCents - a.adjustedNetCents);
  sorted.forEach((p) => {
    const net = p.adjustedNetCents / 100;
    const sideNet = (p.sidePotNetCents || 0) / 100;
    const extra =
      state.venmoScope === 'combined' && Math.abs(sideNet) > 0.004
        ? ` [Main: ${formatCurrency((p.combinedNetCents - p.sidePotNetCents) / 100, true)}, Side: ${formatCurrency(sideNet, true)}]`
        : ` (In: ${formatCurrency(p.buyIn)}, Out: ${formatCurrency(p.endingChips)})`;
    lines.push(`• ${p.name}: ${formatCurrency(net, true)}${extra}`);
  });

  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(
    () => showToast(`📋 Copied ${scopeLabel} Venmo summary to clipboard!`),
    () => showToast('Could not access clipboard automatically.')
  );
}

function saveNightToHistory() {
  const balanceData = computeTableBalances();
  const { players, totalBuyIn, totalChips, diffCents } = balanceData;

  if (players.length < 2) {
    showToast('Add at least 2 players before saving a game.');
    return;
  }
  if (diffCents !== 0 && state.discrepancyStrategy === 'strict') {
    showToast('Resolve the chip discrepancy before saving this session.');
    return;
  }

  const activeVenue = getActiveVenue();
  const combinedPlayers = players.map((p) => ({
    ...p,
    adjustedNetCents: p.combinedNetCents,
  }));
  const { transfers } = solveMinimumTransactions(combinedPlayers);

  const record = {
    id: uid(),
    title: state.sessionTitle || getDefaultSessionTitle(activeVenue.name),
    venueId: activeVenue.id,
    venueName: activeVenue.name,
    savedAt: new Date().toISOString(),
    totalBuyIn,
    totalChips,
    players: players.map((p) => ({
      name: p.name,
      venmo: p.venmo,
      buyIn: p.buyIn,
      endingChips: p.endingChips,
      rawNet: p.rawNetCents / 100,
      adjustedNet: p.combinedNetCents / 100,
      sidePotNet: (p.sidePotNetCents || 0) / 100,
      chipCounts: p.chipCounts,
    })),
    transfers,
  };

  state.history.unshift(record);
  players.forEach((p) => rememberPlayerInRoster(p.name, p.venmo));
  renderAll();
  showToast(`💾 Saved "${record.title}" (${activeVenue.name}) to History!`);
}

/* ==========================================================================
   EVENT LISTENERS & DELEGATION
   ========================================================================== */

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.getAttribute('data-tab') === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function setupEventListeners() {
  // Navigation Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // Session Title
  document.getElementById('session-title').addEventListener('input', (e) => {
    state.sessionTitle = e.target.value;
    saveActiveSession();
  });

  // Custom Venue Drawer Toggle & Submit
  const addVenueDrawer = document.getElementById('add-venue-drawer');
  document.getElementById('btn-toggle-add-venue').addEventListener('click', () => {
    document.getElementById('custom-venue-buyin').value = state.defaultBuyIn;
    addVenueDrawer.classList.toggle('hidden');
  });

  document.getElementById('btn-cancel-venue').addEventListener('click', () => {
    addVenueDrawer.classList.add('hidden');
  });

  addVenueDrawer.addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('custom-venue-name');
    const buyinInput = document.getElementById('custom-venue-buyin');
    const name = nameInput.value.trim();
    if (!name) return;
    const defaultBuyIn = Math.max(1, parseFloat(buyinInput.value) || 50);

    const denomsObj = {};
    state.denoms.forEach((d) => {
      denomsObj[d.id] = Number(d.value) || 1;
    });

    const newVenue = {
      id: `custom-${uid()}`,
      name,
      defaultBuyIn,
      builtin: false,
      denoms: denomsObj,
    };

    state.venues.push(newVenue);
    nameInput.value = '';
    addVenueDrawer.classList.add('hidden');
    applyVenuePreset(newVenue.id, true);
  });

  // Reset Table
  document.getElementById('btn-new-night').addEventListener('click', () => {
    const venue = getActiveVenue();
    document.getElementById('new-player-buyin').value = venue.defaultBuyIn;
    seatVenueDefaultPlayers(true);
  });

  // Input Mode Toggle ($ Value vs Chip Counter)
  document.getElementById('mode-dollar-btn').addEventListener('click', () => {
    state.inputMode = 'dollar';
    renderAll();
  });

  document.getElementById('mode-chips-btn').addEventListener('click', () => {
    state.inputMode = 'chips';
    state.players.forEach((p) => recalcPlayerChipsFromCounts(p));
    renderAll();
  });

  // Denomination Config Drawer
  document.getElementById('btn-toggle-denom-config').addEventListener('click', () => {
    document.getElementById('denom-config-drawer').classList.toggle('hidden');
  });

  document.getElementById('btn-reset-denoms').addEventListener('click', () => {
    const venue = getActiveVenue();
    state.denoms = buildDenomsFromVenue(venue);
    if (state.inputMode === 'chips') {
      state.players.forEach((p) => recalcPlayerChipsFromCounts(p));
    }
    renderAll();
    showToast(`Reset chip values to ${venue.name} defaults.`);
  });

  // Auto-fill Venmo handle when choosing a saved player from roster
  const buyinInput = document.getElementById('new-player-buyin');
  buyinInput.value = state.defaultBuyIn;

  document.getElementById('btn-decrement-new-buyin').addEventListener('click', () => {
    const current = Math.max(0, parseFloat(buyinInput.value) || 0);
    const next = Math.max(0, Math.round((current - state.defaultBuyIn) * 100) / 100);
    buyinInput.value = next;
  });

  document.getElementById('btn-increment-new-buyin').addEventListener('click', () => {
    const current = Math.max(0, parseFloat(buyinInput.value) || 0);
    const next = Math.round((current + state.defaultBuyIn) * 100) / 100;
    buyinInput.value = next;
  });

  const newNameInput = document.getElementById('new-player-name');
  const newVenmoInput = document.getElementById('new-player-venmo');
  const presetSelect = document.getElementById('player-preset-select');

  if (presetSelect) {
    presetSelect.addEventListener('change', (e) => {
      const selectedName = e.target.value;
      if (!selectedName) return;
      newNameInput.value = selectedName;
      const key = selectedName.toLowerCase();
      if (state.roster[key]) {
        newVenmoInput.value = state.roster[key].venmo || '';
      }
      presetSelect.value = '';
    });
  }

  newNameInput.addEventListener('input', () => {
    const key = newNameInput.value.trim().toLowerCase();
    if (state.roster[key]) {
      newVenmoInput.value = state.roster[key].venmo || '';
    }
  });

  // Add Player Form
  document.getElementById('add-player-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = newNameInput.value.trim();
    if (!name) return;
    const venmo = newVenmoInput.value.trim();
    const buyIn = Math.max(0, parseFloat(buyinInput.value) || state.defaultBuyIn);

    const newPlayer = {
      id: uid(),
      name,
      venmo,
      buyIn,
      endingChips: buyIn,
      chipCounts: buildStartingChipCounts(buyIn),
    };
    if (state.inputMode === 'chips') {
      recalcPlayerChipsFromCounts(newPlayer);
    }

    state.players.push(newPlayer);
    rememberPlayerInRoster(name, venmo);

    newNameInput.value = '';
    newVenmoInput.value = '';
    buyinInput.value = state.defaultBuyIn;
    newNameInput.focus();
    renderAll();
  });

  // Player List Delegation
  const playersListEl = document.getElementById('players-list');

  playersListEl.addEventListener('input', (e) => {
    const target = e.target;
    const action = target.getAttribute('data-action');
    const playerId = target.getAttribute('data-player-id');
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return;

    if (action === 'edit-name') {
      player.name = target.value;
      rememberPlayerInRoster(player.name, player.venmo);
      updateLiveCalculationsWithoutFullRerender();
    } else if (action === 'edit-venmo') {
      player.venmo = target.value;
      rememberPlayerInRoster(player.name, player.venmo);
      updateLiveCalculationsWithoutFullRerender();
    } else if (action === 'edit-buyin') {
      player.buyIn = Math.max(0, parseFloat(target.value) || 0);
      updateLiveCalculationsWithoutFullRerender();
    } else if (action === 'edit-chips') {
      player.endingChips = Math.max(0, parseFloat(target.value) || 0);
      updateLiveCalculationsWithoutFullRerender();
    } else if (action === 'chip-input') {
      const denomId = target.getAttribute('data-denom-id');
      if (!player.chipCounts) player.chipCounts = {};
      player.chipCounts[denomId] = Math.max(0, parseInt(target.value, 10) || 0);
      recalcPlayerChipsFromCounts(player);
      renderAll();
    }
  });

  playersListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const playerId = btn.getAttribute('data-player-id');
    const player = state.players.find((p) => p.id === playerId);

    if (action === 'remove-player') {
      state.players = state.players.filter((p) => p.id !== playerId);
      renderAll();
    } else if (action === 'quick-rebuy' && player) {
      const deltaAmt = parseFloat(btn.getAttribute('data-amount')) || state.defaultBuyIn;
      player.buyIn = Math.max(0, Math.round((Number(player.buyIn) + deltaAmt) * 100) / 100);
      renderAll();
      const signLabel = deltaAmt >= 0 ? `+$${deltaAmt}` : `-$${Math.abs(deltaAmt)}`;
      showToast(`Adjusted buy-in (${signLabel}) for ${player.name}`);
    } else if (action === 'chip-step' && player) {
      const denomId = btn.getAttribute('data-denom-id');
      const delta = parseInt(btn.getAttribute('data-delta'), 10) || 0;
      if (!player.chipCounts) player.chipCounts = {};
      const current = Number(player.chipCounts[denomId]) || 0;
      player.chipCounts[denomId] = Math.max(0, current + delta);
      recalcPlayerChipsFromCounts(player);
      renderAll();
    }
  });

  // Discrepancy Resolution Strategy Radios
  document.querySelectorAll('input[name="discrepancy-strategy"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.discrepancyStrategy = e.target.value;
      renderAll();
    });
  });

  // Round to Whole Dollars Toggle
  document.getElementById('round-dollars-toggle').addEventListener('change', (e) => {
    state.roundToWholeDollars = e.target.checked;
    renderAll();
  });

  // Venmo Balance Scope Toggle (Main Game / Combined / Side Pots Only)
  document.querySelectorAll('button[data-venmo-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.venmoScope = btn.getAttribute('data-venmo-scope') || 'main';
      renderAll();
    });
  });

  // Side Pots Tab Actions
  const addSidePotBtn = document.getElementById('btn-add-sidepot');
  if (addSidePotBtn) {
    addSidePotBtn.addEventListener('click', () => {
      if (state.players.length === 0) {
        showToast('Add players to the table first.');
        return;
      }
      createNewSidePot();
      renderAll();
      showToast('🎲 Created new side pot!');
    });
  }

  const sidepotsListEl = document.getElementById('sidepots-list');
  if (sidepotsListEl) {
    sidepotsListEl.addEventListener('change', (e) => {
      const target = e.target;
      const action = target.getAttribute('data-sp-action');
      const spId = target.getAttribute('data-sp-id');
      const sp = (state.sidePots || []).find((s) => s.id === spId);
      if (!sp) return;

      if (action === 'edit-title') {
        sp.name = target.value.trim() || 'Side Pot';
        renderAll();
      } else if (action === 'edit-default-bet') {
        const val = Math.max(0, parseFloat(target.value) || 0);
        sp.defaultBet = val;
        if (!sp.bets) sp.bets = {};
        state.players.forEach((p) => {
          const active = sp.bets[p.id] ? sp.bets[p.id].active : true;
          sp.bets[p.id] = { active, amount: val };
        });
        renderAll();
      } else if (action === 'toggle-player') {
        const pId = target.getAttribute('data-player-id');
        if (!sp.bets[pId]) sp.bets[pId] = { active: true, amount: sp.defaultBet };
        sp.bets[pId].active = target.checked;
        renderAll();
      } else if (action === 'edit-player-bet') {
        const pId = target.getAttribute('data-player-id');
        const val = Math.max(0, parseFloat(target.value) || 0);
        if (!sp.bets[pId]) sp.bets[pId] = { active: true, amount: val };
        sp.bets[pId].amount = val;
        renderAll();
      }
    });

    sidepotsListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sp-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-sp-action');
      const spId = btn.getAttribute('data-sp-id');
      const sp = (state.sidePots || []).find((s) => s.id === spId);

      if (action === 'delete-sidepot') {
        state.sidePots = (state.sidePots || []).filter((s) => s.id !== spId);
        renderAll();
        showToast('Removed side pot.');
      } else if (action === 'select-winner' && sp) {
        const pId = btn.getAttribute('data-player-id');
        sp.winnerId = pId;
        renderAll();
      }
    });
  }

  // Copy Summary & Save Night
  document.getElementById('btn-copy-summary').addEventListener('click', copyGroupChatSummary);
  document.getElementById('btn-save-night').addEventListener('click', saveNightToHistory);

  // Clear All History
  document.getElementById('btn-clear-history').addEventListener('click', () => {
    if (state.history.length === 0) return;
    if (confirm('Clear all saved poker nights from history?')) {
      state.history = [];
      renderAll();
      showToast('Cleared game history.');
    }
  });

  // Players Directory Tab Actions
  const dirAddForm = document.getElementById('directory-add-form');
  if (dirAddForm) {
    dirAddForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameEl = document.getElementById('dir-player-name');
      const venmoEl = document.getElementById('dir-player-venmo');
      const name = (nameEl?.value || '').trim();
      if (!name) return;
      const venmo = (venmoEl?.value || '').trim();
      rememberPlayerInRoster(name, venmo);
      if (nameEl) nameEl.value = '';
      if (venmoEl) venmoEl.value = '';
      renderAll();
      showToast(`Saved ${name} to Players Directory.`);
    });
  }

  const resetRosterBtn = document.getElementById('btn-reset-roster');
  if (resetRosterBtn) {
    resetRosterBtn.addEventListener('click', () => {
      state.roster = {};
      seedAllVenueDefaultPlayersToRoster();
      renderAll();
      showToast('Restored directory to the 9 venue regulars.');
    });
  }

  const dirListContainer = document.getElementById('directory-list-container');
  if (dirListContainer) {
    dirListContainer.addEventListener('change', (e) => {
      const target = e.target;
      if (target.getAttribute('data-roster-action') === 'edit-venmo') {
        const key = target.getAttribute('data-roster-key');
        if (key && state.roster[key]) {
          state.roster[key].venmo = target.value.trim();
          // Also sync open table players with matching name
          state.players.forEach((p) => {
            if ((p.name || '').trim().toLowerCase() === key) {
              p.venmo = state.roster[key].venmo;
            }
          });
          renderAll();
          showToast(`Updated Venmo handle for ${state.roster[key].name}`);
        }
      }
    });

    dirListContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-roster-action="delete-player"]');
      if (!btn) return;
      const key = btn.getAttribute('data-roster-key');
      if (key && state.roster[key]) {
        const removedName = state.roster[key].name;
        delete state.roster[key];
        renderAll();
        showToast(`Removed ${removedName} from saved players.`);
      }
    });
  }

  // Export & Import JSON Backup
  document.getElementById('btn-export-data').addEventListener('click', () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      history: state.history,
      roster: state.roster,
      denoms: state.denoms,
      venues: state.venues,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `poker-nite-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('⬇️ Exported club history backup!');
  });

  document.getElementById('input-import-data').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (Array.isArray(data.history)) state.history = data.history;
        if (data.roster) state.roster = { ...state.roster, ...data.roster };
        if (Array.isArray(data.denoms)) state.denoms = data.denoms;
        if (Array.isArray(data.venues)) state.venues = data.venues;
        renderAll();
        showToast('⬆️ Imported poker history backup!');
      } catch (err) {
        showToast('Invalid JSON backup file.');
      }
    };
    reader.readAsText(file);
  });
}

function updateLiveCalculationsWithoutFullRerender() {
  const balanceData = computeTableBalances();
  const { players, totalBuyIn, totalChips, diffCents, diffDollars } = balanceData;

  document.getElementById('kpi-players').textContent = players.length;
  document.getElementById('kpi-buyins').textContent = formatCurrency(totalBuyIn);
  document.getElementById('kpi-chips').textContent = formatCurrency(totalChips);

  const balanceCard = document.getElementById('kpi-balance-card');
  const discrepancyEl = document.getElementById('kpi-discrepancy');
  const discrepancyPanel = document.getElementById('discrepancy-panel');
  balanceCard.classList.remove('status-balanced', 'status-warning');

  if (players.length === 0 || diffCents === 0) {
    balanceCard.classList.add('status-balanced');
    discrepancyEl.textContent = 'Balanced ✓';
    discrepancyPanel.classList.add('hidden');
  } else {
    balanceCard.classList.add('status-warning');
    discrepancyEl.textContent =
      diffDollars > 0 ? `+${formatCurrency(diffDollars)} Extra` : `${formatCurrency(diffDollars)} Short`;
    discrepancyPanel.classList.remove('hidden');

    const titleEl = document.getElementById('discrepancy-title');
    const descEl = document.getElementById('discrepancy-desc');
    if (diffDollars < 0) {
      titleEl.textContent = `Table is Short by ${formatCurrency(Math.abs(diffDollars))}`;
      descEl.textContent = `Counted chips (${formatCurrency(totalChips)}) are less than total buy-ins (${formatCurrency(totalBuyIn)}). Choose how to reconcile the missing ${formatCurrency(Math.abs(diffDollars))}:`;
    } else {
      titleEl.textContent = `Table has ${formatCurrency(diffDollars)} in Extra Chips`;
      descEl.textContent = `Counted chips (${formatCurrency(totalChips)}) exceed total buy-ins (${formatCurrency(totalBuyIn)}). Choose how to reconcile the extra ${formatCurrency(diffDollars)}:`;
    }
  }

  players.forEach((p) => {
    const badge = document.querySelector(`[data-net-badge="${p.id}"]`);
    const adjNote = document.querySelector(`[data-adj-note="${p.id}"]`);
    if (badge) {
      const adjNetDollars = p.adjustedNetCents / 100;
      badge.className = `net-badge ${adjNetDollars > 0.004 ? 'positive' : adjNetDollars < -0.004 ? 'negative' : 'even'}`;
      badge.textContent = formatCurrency(adjNetDollars, true);
    }
    if (adjNote) {
      const showAdjusted = p.rawNetCents !== p.adjustedNetCents;
      adjNote.classList.toggle('hidden', !showAdjusted);
      adjNote.textContent = `Raw: ${formatCurrency(p.rawNetCents / 100, true)}`;
    }
  });

  renderSettlementPanel(balanceData);
  renderNetStandings(players);
  saveActiveSession();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   INITIALIZATION
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  setupEventListeners();
  renderAll();
});
