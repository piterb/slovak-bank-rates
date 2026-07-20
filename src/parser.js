import * as cheerio from 'cheerio';

const KNOWN_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'GBP', 'HKD', 'HUF',
  'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'NOK', 'NZD', 'PLN', 'RON',
  'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'
]);

const BANK_ALIASES = [
  ['365.bank', /365\.bank/i],
  ['ČSOB', /ČSOB/i],
  ['Fio banka', /Fio\s*(?:Banka|banka)/i],
  ['mBank', /mBank/i],
  ['Prima banka', /Prima\s+banka/i],
  ['Slovenská sporiteľňa', /Slovensk[aá]\s+sporiteľňa/i],
  ['Tatra banka', /Tatra\s+Banka|Tatra\s+banka/i],
  ['UniCredit Bank', /UniCredit/i],
  ['VÚB', /Všeobecn[aá]\s+úverov[aá]\s+banka|\bVÚB\b/i]
];

const OFFICIAL_URLS = {
  '365.bank': 'https://365.bank/kurzovy-listok',
  'ČSOB': 'https://www.csob.sk/o-nas/kurzovy-listok',
  'Fio banka': 'https://www.fio.sk/bankove-sluzby/devizove-operacie/kurzovy-listok',
  'mBank': 'https://www.mbank.sk/kurzovy-listok/',
  'Prima banka': 'https://www.primabanka.sk/kurzovy-listok',
  'Slovenská sporiteľňa': 'https://www.slsp.sk/sk/kurzovy-listok',
  'Tatra banka': 'https://www.tatrabanka.sk/sk/personal/kurzovy-listok/',
  'UniCredit Bank': 'https://www.unicreditbank.sk/sk/obcania/kurzovy-listok.html',
  'VÚB': 'https://www.vub.sk/ludia/kurzovy-listok.html'
};

function cleanText(value = '') {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  const normalized = cleanText(value)
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.+-]/g, '');
  if (!normalized || !/[0-9]/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNumbers(value) {
  return [...cleanText(value).matchAll(/[-+]?\d+(?:[\s.]\d{3})*(?:[,.]\d+)?/g)]
    .map((match) => parseNumber(match[0]))
    .filter((number) => number !== null);
}

function identifyBank(title) {
  for (const [name, pattern] of BANK_ALIASES) {
    if (pattern.test(title)) return name;
  }
  return null;
}

function toIsoDate(y, m, d) {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(text) {
  const normalized = cleanText(text);
  const european = normalized.match(/(?:deň|dňa|od|dátum|date)?\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/i);
  if (european) {
    const [, d, m, y] = european;
    return toIsoDate(y, m, d);
  }
  const iso = normalized.match(/(?:^|\s)(\d{4})-(\d{1,2})-(\d{1,2})(?:\s|$)/);
  if (iso) {
    const [, y, m, d] = iso;
    return toIsoDate(y, m, d);
  }
  return null;
}

// Pri priamych stránkach sa môžu v texte objaviť historické dátumy vo formulári
// alebo chybovom upozornení. Vyberieme preto najnovší platný dátum v dokumente.
export function parseLatestDate(text) {
  const normalized = cleanText(text);
  const dates = [];

  for (const match of normalized.matchAll(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/g)) {
    const iso = toIsoDate(match[3], match[2], match[1]);
    if (iso) dates.push(iso);
  }
  for (const match of normalized.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const iso = toIsoDate(match[1], match[2], match[3]);
    if (iso) dates.push(iso);
  }

  return dates.sort().at(-1) || null;
}

function emptyRateObject() {
  return {
    deviza: { buy: null, sell: null, mid: null },
    valuta: { buy: null, sell: null, mid: null }
  };
}

function rateObject(values) {
  const result = emptyRateObject();

  if (values.length >= 6) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid,
      result.valuta.buy, result.valuta.sell, result.valuta.mid] = values;
  } else if (values.length === 5) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid,
      result.valuta.buy, result.valuta.sell] = values;
  } else if (values.length === 4) {
    [result.deviza.buy, result.deviza.sell,
      result.valuta.buy, result.valuta.sell] = values;
  } else if (values.length === 3) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid] = values;
  } else if (values.length === 2) {
    [result.deviza.buy, result.deviza.sell] = values;
  }
  return result;
}

function findCurrency(cells) {
  for (let index = 0; index < cells.length; index += 1) {
    const match = cells[index].match(/(?:^|\s)([A-Z]{3})(?:\s|$)/);
    if (match && match[1] !== 'EUR') {
      return { currency: match[1], index };
    }
  }
  return null;
}

function parseRow($, row) {
  const cells = $(row).find('th,td').map((_, cell) => cleanText($(cell).text())).get();
  if (cells.length < 3) return null;

  const found = findCurrency(cells);
  if (!found) return null;
  const { currency, index: codeIndex } = found;

  let numbers = cells.slice(codeIndex + 1)
    .map(parseNumber)
    .filter((value) => value !== null);

  // Fallback pre responzívne tabuľky, ktoré vložia kód, množstvo aj kurzy do jedného elementu.
  if (numbers.length < 2) {
    const joined = cells.join(' | ');
    const codePosition = joined.indexOf(currency);
    const tail = codePosition >= 0 ? joined.slice(codePosition + currency.length) : '';
    numbers = extractNumbers(tail);
  }

  // Prvý číselný údaj býva množstvo (1 alebo 100), nie kurz.
  if (numbers.length >= 3 && (numbers[0] === 1 || numbers[0] === 100)) {
    numbers = numbers.slice(1);
  }
  if (numbers.length < 2) return null;

  // Tabuľky môžu obsahovať dodatočný spread; pre porovnanie potrebujeme max. 6 kurzov.
  numbers = numbers.slice(0, 6);
  return { currency, ...rateObject(numbers) };
}

function findSectionTable($, heading) {
  let current = $(heading).next();
  let guard = 0;
  while (current.length && guard < 12) {
    if (/^h[1-4]$/i.test(current[0]?.tagName || '')) return null;
    if (current.is('table')) return current;
    const nested = current.find('table').first();
    if (nested.length) return nested;
    current = current.next();
    guard += 1;
  }
  return null;
}

function sectionContext($, heading, table) {
  const parts = [cleanText($(heading).text())];
  let current = $(heading).next();
  let guard = 0;
  while (current.length && guard < 12) {
    if (/^h[1-4]$/i.test(current[0]?.tagName || '')) break;
    if (current.is(table) || current.find(table).length) break;
    parts.push(cleanText(current.text()));
    current = current.next();
    guard += 1;
  }
  return cleanText(parts.join(' '));
}

export function parseRatesPage(html, fetchedAt = new Date().toISOString()) {
  const $ = cheerio.load(html);
  const banks = [];
  const seen = new Set();

  $('h2,h3,h4').each((_, heading) => {
    const title = cleanText($(heading).text());
    if (!/kurzov[yý]\s+l[ií]stok/i.test(title)) return;
    const bank = identifyBank(title);
    if (!bank || seen.has(bank)) return;

    const table = findSectionTable($, heading);
    if (!table?.length) return;

    const rates = [];
    table.find('tr').each((__, row) => {
      const parsed = parseRow($, row);
      if (parsed) rates.push(parsed);
    });
    if (!rates.length) return;

    const context = sectionContext($, heading, table);
    banks.push({
      bank,
      validDate: parseDate(context),
      officialUrl: OFFICIAL_URLS[bank],
      rates
    });
    seen.add(bank);
  });

  return {
    fetchedAt,
    source: 'https://www.kurzy-online.sk/kurzovy-listok/',
    banks
  };
}

function rateObjectForLayout(values, layout) {
  const rates = emptyRateObject();
  if (layout === 'deviza2') {
    [rates.deviza.buy, rates.deviza.sell] = values;
  } else if (layout === 'deviza3') {
    [rates.deviza.buy, rates.deviza.sell, rates.deviza.mid] = values;
  } else if (layout === 'full5') {
    [rates.deviza.buy, rates.deviza.sell, rates.deviza.mid,
      rates.valuta.buy, rates.valuta.sell] = values;
  } else {
    [rates.deviza.buy, rates.deviza.sell, rates.deviza.mid,
      rates.valuta.buy, rates.valuta.sell, rates.valuta.mid] = values;
  }
  return rates;
}

function requiredValues(layout) {
  if (layout === 'deviza2') return 2;
  if (layout === 'deviza3') return 3;
  if (layout === 'full5') return 5;
  return 6;
}

/**
 * Parser pre samostatné oficiálne stránky bánk. Je zámerne založený na
 * sémantike riadkov tabuľky, nie na CSS triedach, ktoré banky často menia.
 */
export function parseDirectBankPage(html, config, fetchedAt = new Date().toISOString()) {
  const $ = cheerio.load(html);
  const ratesByCurrency = new Map();
  const needed = requiredValues(config.layout);

  $('tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => cleanText($(cell).text())).get();
    if (cells.length < 2) return;
    const found = findCurrency(cells);
    if (!found || !KNOWN_CURRENCIES.has(found.currency)) return;

    const tail = cells.slice(found.index + 1).join(' ');
    let values = extractNumbers(tail);
    if (values.length > needed && (values[0] === 1 || values[0] === 100)) {
      values = values.slice(1);
    }
    if (values.length < needed) return;

    // Zdroj môže mať za kurzami spread, percento alebo historickú zmenu.
    values = values.slice(0, needed);
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) return;

    ratesByCurrency.set(found.currency, {
      currency: found.currency,
      ...rateObjectForLayout(values, config.layout)
    });
  });

  // Niektoré responzívne stránky nemajú klasické <tr>, ale údaje sú v blokoch.
  if (!ratesByCurrency.size) {
    const text = cleanText($('body').text());
    const codes = [...new Set([...text.matchAll(/\b([A-Z]{3})\b/g)]
      .map((match) => match[1])
      .filter((code) => KNOWN_CURRENCIES.has(code)))];

    for (const currency of codes) {
      const position = text.indexOf(currency);
      if (position < 0) continue;
      const window = text.slice(position + currency.length, position + currency.length + 240);
      let values = extractNumbers(window);
      if (values.length > needed && (values[0] === 1 || values[0] === 100)) {
        values = values.slice(1);
      }
      values = values.slice(0, needed);
      if (values.length < needed || values.some((value) => value <= 0)) continue;
      ratesByCurrency.set(currency, {
        currency,
        ...rateObjectForLayout(values, config.layout)
      });
    }
  }

  const bodyText = cleanText($('body').text());
  const validDate = parseLatestDate(bodyText);
  const rates = [...ratesByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));

  if (!rates.length) {
    throw new Error(`Na stránke ${config.bank} sa nenašli použiteľné kurzy.`);
  }

  return {
    fetchedAt,
    bank: config.bank,
    validDate,
    officialUrl: config.officialUrl || config.url,
    rates
  };
}

export function summarizeCurrencies(banks) {
  return [...new Set(banks.flatMap((bank) => bank.rates.map((rate) => rate.currency)))].sort();
}

function mergeRateValues(target, source) {
  for (const kind of ['deviza', 'valuta']) {
    for (const field of ['buy', 'sell', 'mid']) {
      if (source[kind]?.[field] !== null && source[kind]?.[field] !== undefined) {
        target[kind][field] = source[kind][field];
      }
    }
  }
  return target;
}

function nearbyTableContext($, table) {
  const parts = [
    cleanText($(table).attr('id') || ''),
    cleanText($(table).attr('class') || ''),
    cleanText($(table).find('caption').text())
  ];

  let current = $(table).prev();
  let guard = 0;
  while (current.length && guard < 8) {
    const text = cleanText(current.text());
    if (text) parts.unshift(text);
    if (/^h[1-6]$/i.test(current[0]?.tagName || '')) break;
    current = current.prev();
    guard += 1;
  }
  return cleanText(parts.join(' '));
}

function adaptiveRates(values, context) {
  const result = emptyRateObject();
  const hasDeviza = /dev[ií]z/i.test(context);
  const hasValuta = /val[uú]t/i.test(context);

  if (hasDeviza && !hasValuta) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid] = values;
  } else if (hasValuta && !hasDeviza) {
    [result.valuta.buy, result.valuta.sell, result.valuta.mid] = values;
  } else if (values.length >= 6) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid,
      result.valuta.buy, result.valuta.sell, result.valuta.mid] = values;
  } else if (values.length === 5) {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid,
      result.valuta.buy, result.valuta.sell] = values;
  } else if (values.length === 4) {
    [result.deviza.buy, result.deviza.sell,
      result.valuta.buy, result.valuta.sell] = values;
  } else {
    [result.deviza.buy, result.deviza.sell, result.deviza.mid] = values;
  }
  return result;
}

/**
 * Adaptívny parser pre JavaScriptom vykreslené bankové tabuľky. Podporuje
 * jednu spoločnú tabuľku aj samostatné tabuľky Devízy / Valuty.
 */
export function parseAdaptiveBankPage(html, config, fetchedAt = new Date().toISOString()) {
  const $ = cheerio.load(html);
  const ratesByCurrency = new Map();
  const dateTexts = [];

  $('table').each((_, table) => {
    const context = `${nearbyTableContext($, table)} ${cleanText($(table).find('thead').text())}`;
    dateTexts.push(context);

    $(table).find('tr').each((__, row) => {
      const cells = $(row).find('th,td').map((___, cell) => cleanText($(cell).text())).get();
      if (cells.length < 2) return;
      const found = findCurrency(cells);
      if (!found || !KNOWN_CURRENCIES.has(found.currency)) return;

      let values = cells.slice(found.index + 1)
        .flatMap((cell) => extractNumbers(cell));
      if (values.length >= 3 && (values[0] === 1 || values[0] === 10 || values[0] === 100)) {
        values = values.slice(1);
      }
      values = values.filter((value) => Number.isFinite(value) && value > 0).slice(0, 6);
      if (values.length < 2) return;

      const current = ratesByCurrency.get(found.currency) || {
        currency: found.currency,
        ...emptyRateObject()
      };
      mergeRateValues(current, adaptiveRates(values, context));
      ratesByCurrency.set(found.currency, current);
    });
  });

  const rates = [...ratesByCurrency.values()]
    .filter((item) => item.deviza.buy || item.deviza.sell || item.valuta.buy || item.valuta.sell)
    .sort((a, b) => a.currency.localeCompare(b.currency));

  if (!rates.length) throw new Error(`Na vykreslenej stránke ${config.bank} sa nenašli použiteľné kurzy.`);

  const dateScope = cleanText(`${dateTexts.join(' ')} ${$('body').text()}`);
  return {
    fetchedAt,
    bank: config.bank,
    validDate: parseLatestDate(dateScope),
    officialUrl: config.officialUrl || config.url,
    rates
  };
}

function jtPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateFromIsoTimestamp(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

/**
 * Parser verejného JSON endpointu J&T Banky.
 * fcy = devízy, banknotes = valuty. J&T pomenúva buy/sell opačne než interný
 * normalizovaný formát aplikácie a ostatné zdroje, preto ich pri importe
 * prehadzujeme. Interné `buy` vždy znamená kurz, za ktorý banka kupuje cudziu
 * menu od klienta; interné `sell` kurz, za ktorý ju klientovi predáva.
 */
export function parseJtExchangeRateList(payload, config, fetchedAt = new Date().toISOString()) {
  const data = payload?.data;
  const list = data?.listOfExchangeRates;
  if (!Array.isArray(list) || !list.length) {
    const warnings = payload?.params?.errorWarning;
    const detail = Array.isArray(warnings) && warnings.length ? ` (${warnings.join('; ')})` : '';
    throw new Error(`J&T API vrátilo prázdny kurzový lístok${detail}.`);
  }

  const rates = list.flatMap((item) => {
    const currency = String(item?.currencyCode || '').toUpperCase();
    if (!KNOWN_CURRENCIES.has(currency)) return [];

    const detail = item?.currencyRateDetail || {};
    const rate = {
      currency,
      deviza: {
        buy: jtPositiveNumber(detail.fcySell),
        sell: jtPositiveNumber(detail.fcyBuy),
        mid: jtPositiveNumber(detail.fcyMiddle)
      },
      valuta: {
        buy: jtPositiveNumber(detail.banknotesSell),
        sell: jtPositiveNumber(detail.banknotesBuy),
        mid: jtPositiveNumber(detail.banknotesMiddle)
      }
    };

    const hasAnyRate = [
      rate.deviza.buy,
      rate.deviza.sell,
      rate.valuta.buy,
      rate.valuta.sell
    ].some((value) => value !== null);
    return hasAnyRate ? [rate] : [];
  }).sort((a, b) => a.currency.localeCompare(b.currency));

  if (!rates.length) throw new Error('J&T API neobsahuje žiadne použiteľné meny.');

  const detailDate = list
    .map((item) => dateFromIsoTimestamp(item?.currencyRateDetail?.dateOfValidity))
    .find(Boolean);

  return {
    fetchedAt,
    bank: config.bank,
    validDate: dateFromIsoTimestamp(data.dateOfValidity) || detailDate,
    officialUrl: config.officialUrl || config.url,
    rates
  };
}
