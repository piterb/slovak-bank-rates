import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDirectBankPage,
  parseJtExchangeRateList,
  parseRatesPage,
  summarizeCurrencies
} from './parser.js';

const AGGREGATE_SOURCE_URL = 'https://www.kurzy-online.sk/kurzovy-listok/';
const JT_API_URL = 'https://www.jtbanka.sk/jtdigi/api/exchangerate/list';

const DIRECT_SOURCES = [
  {
    bank: 'mBank',
    url: 'https://www.mbank.sk/kurzovy-listok/',
    layout: 'deviza3'
  },
  {
    bank: 'Penta Bank',
    url: 'https://ibank.pentabank.com/Extranet/Pages/ExchangeList.aspx',
    officialUrl: 'https://www.pentabank.sk/',
    layout: 'full5'
  },
  {
    bank: 'Oberbank',
    url: 'https://www.kurzy-online.sk/kurzovy-listok/oberbank/',
    officialUrl: 'https://www.oberbank.sk/',
    layout: 'deviza3'
  },
  {
    bank: 'J&T Banka',
    url: 'https://www.jtbanka.sk/uzitocne-informacie/kurzovy-listok/',
    officialUrl: 'https://www.jtbanka.sk/uzitocne-informacie/kurzovy-listok/',
    apiType: 'jt-json'
  }
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../test/fixtures/kurzy-online.html');

let lastSuccess = null;
let lastFetchMs = 0;
const CACHE_MS = 20_000;

function requestHeaders(accept) {
  return {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/149 Safari/537.36',
    accept,
    'accept-language': 'sk-SK,sk;q=0.9,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache'
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: requestHeaders('text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'),
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      ...requestHeaders('application/json, text/plain, */*'),
      ...extraHeaders
    },
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Očakávaný JSON, server vrátil ${contentType || 'neznámy typ obsahu'}.`);
  }
  return response.json();
}

function formatDateInBratislava(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function recentBratislavaDates(days = 8) {
  const now = Date.now();
  return Array.from({ length: days }, (_, offset) =>
    formatDateInBratislava(new Date(now - offset * 86_400_000))
  );
}

async function loadAggregateHtml() {
  if (process.env.USE_FIXTURE === '1') return fs.readFile(FIXTURE_PATH, 'utf8');
  return fetchText(AGGREGATE_SOURCE_URL);
}

async function fetchJtBank(source, fetchedAt) {
  let lastError = null;

  // J&T môže počas víkendu, sviatku alebo pred dennou aktualizáciou vrátiť
  // prázdny zoznam. Preto skúšame dnešný dátum a následne predošlé dni.
  for (const specificDate of recentBratislavaDates()) {
    const endpoint = new URL(JT_API_URL);
    endpoint.searchParams.set('specificDate', specificDate);
    endpoint.searchParams.set('sort', 'countryCode:asc');

    try {
      const payload = await fetchJson(endpoint, {
        referer: source.url
      });
      return parseJtExchangeRateList(payload, source, fetchedAt);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`J&T API neposkytlo použiteľné kurzy: ${lastError?.message || 'neznáma chyba'}`);
}

async function fetchDirectBank(source, fetchedAt) {
  if (process.env.USE_FIXTURE === '1') return null;

  const bank = source.apiType === 'jt-json'
    ? await fetchJtBank(source, fetchedAt)
    : parseDirectBankPage(await fetchText(source.url), source, fetchedAt);

  if (bank.validDate) {
    const ageMs = new Date(fetchedAt).getTime() - new Date(`${bank.validDate}T12:00:00Z`).getTime();
    const ageDays = ageMs / 86_400_000;
    if (ageDays > 7) throw new Error(`Kurzový lístok je zastaraný (${bank.validDate}).`);
  }
  return bank;
}

function mergeBrandAliases(bank) {
  if (bank.bank !== 'Tatra banka') return bank;
  return {
    ...bank,
    bank: 'Tatra banka / Raiffeisen banka',
    officialUrl: 'https://www.tatrabanka.sk/sk/personal/kurzovy-listok/'
  };
}

export async function getRates({ force = false } = {}) {
  const now = Date.now();
  if (!force && lastSuccess && now - lastFetchMs < CACHE_MS) {
    return { ...lastSuccess, cached: true };
  }

  try {
    const fetchedAt = new Date().toISOString();
    const aggregateHtml = await loadAggregateHtml();
    const aggregate = parseRatesPage(aggregateHtml, fetchedAt);
    if (!aggregate.banks.length) throw new Error('V hlavnom zdroji sa nepodarilo nájsť kurzové lístky bánk.');

    const directResults = await Promise.allSettled(
      DIRECT_SOURCES.map((source) => fetchDirectBank(source, fetchedAt))
    );

    const aggregateBanks = aggregate.banks.map(mergeBrandAliases);
    const bankMap = new Map(aggregateBanks.map((bank) => [bank.bank, bank]));
    const sourceErrors = [];

    directResults.forEach((result, index) => {
      const source = DIRECT_SOURCES[index];
      if (result.status === 'fulfilled' && result.value) {
        bankMap.set(source.bank, result.value);
      } else if (result.status === 'rejected') {
        sourceErrors.push({ bank: source.bank, error: result.reason?.message || 'Neznáma chyba' });
      }
    });

    const banks = [...bankMap.values()].sort((a, b) => a.bank.localeCompare(b.bank, 'sk'));
    lastSuccess = {
      fetchedAt,
      source: AGGREGATE_SOURCE_URL,
      banks,
      currencies: summarizeCurrencies(banks),
      sourceErrors,
      sourceNotes: [
        'Raiffeisen banka používa rovnaký kurzový lístok ako Tatra banka, preto sú zobrazené v jednom riadku.',
        'J&T Banka sa načítava priamo z jej verejného JSON API; pri nepracovnom dni sa skúsi posledný dostupný kurzový deň.'
      ],
      cached: false,
      stale: false
    };
    lastFetchMs = now;
    return lastSuccess;
  } catch (error) {
    if (lastSuccess) {
      return {
        ...lastSuccess,
        cached: true,
        stale: true,
        warning: `Aktualizácia zlyhala: ${error.message}. Zobrazené sú posledné úspešné dáta.`
      };
    }
    throw error;
  }
}
