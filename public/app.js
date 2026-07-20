const elements = {
  currency: document.querySelector('#currency'),
  direction: document.querySelector('#direction'),
  kind: document.querySelector('#kind'),
  amount: document.querySelector('#amount'),
  amountCurrency: document.querySelector('#amountCurrency'),
  ratesBody: document.querySelector('#ratesBody'),
  status: document.querySelector('#status'),
  emptyState: document.querySelector('#emptyState'),
  updatedAt: document.querySelector('#updatedAt'),
  comparisonLabel: document.querySelector('#comparisonLabel'),
  bestBank: document.querySelector('#bestBank'),
  bestResult: document.querySelector('#bestResult'),
  bestDifference: document.querySelector('#bestDifference'),
  refreshButton: document.querySelector('#refreshButton')
};

const preferredCurrencies = ['USD', 'CZK', 'GBP', 'CHF', 'HUF', 'PLN'];
let payload = null;

function localeNumber(value, currency, min = 2, max = 4) {
  return new Intl.NumberFormat('sk-SK', {
    style: 'currency',
    currency,
    minimumFractionDigits: min,
    maximumFractionDigits: max
  }).format(value);
}

function localeRate(value) {
  return new Intl.NumberFormat('sk-SK', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6
  }).format(value);
}

function dateLabel(isoDate) {
  if (!isoDate) return 'neuvedené';
  return new Intl.DateTimeFormat('sk-SK').format(new Date(`${isoDate}T12:00:00`));
}

function savePreferences() {
  localStorage.setItem('bank-rates-preferences', JSON.stringify({
    currency: elements.currency.value,
    direction: elements.direction.value,
    kind: elements.kind.value,
    amount: elements.amount.value
  }));
}

function loadPreferences() {
  try {
    return JSON.parse(localStorage.getItem('bank-rates-preferences')) || {};
  } catch {
    return {};
  }
}

function fillCurrencies(currencies) {
  const preferences = loadPreferences();
  const ordered = [...currencies].sort((a, b) => {
    const ai = preferredCurrencies.indexOf(a);
    const bi = preferredCurrencies.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  elements.currency.innerHTML = ordered.map((code) => `<option value="${code}">${code}</option>`).join('');
  elements.currency.value = ordered.includes(preferences.currency) ? preferences.currency : (ordered[0] || 'USD');
  elements.direction.value = preferences.direction || 'eur-to-fx';
  elements.kind.value = preferences.kind || 'deviza';
  elements.amount.value = preferences.amount || '1000';
}

function calculateRows() {
  if (!payload) return [];
  const currency = elements.currency.value;
  const direction = elements.direction.value;
  const kind = elements.kind.value;
  const amount = Number(elements.amount.value);
  if (!currency || !Number.isFinite(amount) || amount <= 0) return [];

  return payload.banks.flatMap((bank) => {
    const item = bank.rates.find((rate) => rate.currency === currency);
    if (!item) return [];
    const rate = direction === 'eur-to-fx' ? item[kind]?.sell : item[kind]?.buy;
    if (!Number.isFinite(rate) || rate <= 0) return [];
    const result = direction === 'eur-to-fx' ? amount * rate : amount / rate;
    return [{ ...bank, rate, result }];
  }).sort((a, b) => b.result - a.result);
}

function render() {
  savePreferences();
  const currency = elements.currency.value;
  const direction = elements.direction.value;
  const kind = elements.kind.value;
  const amount = Number(elements.amount.value);
  const sourceCurrency = direction === 'eur-to-fx' ? 'EUR' : currency;
  const targetCurrency = direction === 'eur-to-fx' ? currency : 'EUR';
  elements.amountCurrency.textContent = sourceCurrency;
  elements.comparisonLabel.textContent = `${localeNumber(amount || 0, sourceCurrency)} → ${targetCurrency} · ${kind === 'deviza' ? 'bezhotovostne' : 'hotovosť'}`;

  const rows = calculateRows();
  elements.emptyState.hidden = rows.length > 0;
  elements.ratesBody.innerHTML = '';

  if (!rows.length) {
    elements.bestBank.textContent = '–';
    elements.bestResult.textContent = '–';
    elements.bestDifference.textContent = '–';
    return;
  }

  const best = rows[0];
  const worst = rows.at(-1);
  elements.bestBank.textContent = best.bank;
  elements.bestResult.textContent = localeNumber(best.result, targetCurrency);
  elements.bestDifference.textContent = localeNumber(best.result - worst.result, targetCurrency);

  elements.ratesBody.innerHTML = rows.map((row, index) => {
    const difference = best.result - row.result;
    const bestBadge = index === 0 ? '<span class="badge">Najlepší</span>' : '';
    return `
      <tr class="${index === 0 ? 'winner' : ''}">
        <td data-label="#">${index + 1}</td>
        <td data-label="Banka"><strong>${row.bank}</strong>${bestBadge}</td>
        <td data-label="Použitý kurz">${localeRate(row.rate)}</td>
        <td data-label="Výsledok"><strong>${localeNumber(row.result, targetCurrency)}</strong></td>
        <td data-label="Rozdiel">${index === 0 ? '–' : `− ${localeNumber(difference, targetCurrency)}`}</td>
        <td data-label="Platnosť">${dateLabel(row.validDate)}</td>
        <td data-label="Zdroj"><a href="${row.officialUrl}" target="_blank" rel="noreferrer">Banka ↗</a></td>
      </tr>`;
  }).join('');
}

async function loadRates(force = false) {
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = 'Obnovujem…';
  elements.status.className = 'status';
  elements.status.textContent = 'Načítavam aktuálne kurzové lístky…';
  try {
    const response = await fetch(`/api/rates?force=${force ? '1' : '0'}&_=${Date.now()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || 'Neznáma chyba');
    payload = data;
    if (!elements.currency.options.length) fillCurrencies(data.currencies);
    elements.updatedAt.textContent = `Načítané ${new Intl.DateTimeFormat('sk-SK', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(data.fetchedAt))}`;
    if (data.warning) {
      elements.status.className = 'status warning';
      elements.status.textContent = data.warning;
    } else {
      elements.status.className = 'status success';
      const failedSources = data.sourceErrors?.length || 0;
      elements.status.textContent = `Načítaných ${data.banks.length} bánk. ${data.cached ? 'Použitá krátka serverová cache.' : 'Dáta boli práve obnovené.'}${failedSources ? ` ${failedSources} doplnkové zdroje momentálne neposkytli strojovo čitateľné údaje.` : ''}`;
    }
    render();
  } catch (error) {
    elements.status.className = 'status error';
    elements.status.textContent = `Kurzy sa nepodarilo načítať: ${error.message}`;
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = 'Obnoviť kurzy';
  }
}

[elements.currency, elements.direction, elements.kind, elements.amount].forEach((element) => {
  element.addEventListener('input', render);
  element.addEventListener('change', render);
});
elements.refreshButton.addEventListener('click', () => loadRates(true));

loadRates(false);
