import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseRatesPage, summarizeCurrencies } from '../src/parser.js';

const fixture = await fs.readFile(new URL('./fixtures/kurzy-online.html', import.meta.url), 'utf8');

test('parser nájde banky, dátumy a kurzy', () => {
  const data = parseRatesPage(fixture, '2026-07-20T20:00:00.000Z');
  assert.equal(data.banks.length, 4);
  const csob = data.banks.find((item) => item.bank === 'ČSOB');
  assert.equal(csob.validDate, '2026-07-20');
  assert.equal(csob.rates[0].currency, 'USD');
  assert.equal(csob.rates[0].deviza.buy, 1.1631);
  assert.equal(csob.rates[0].valuta.sell, 1.1145);
});

test('parser zvládne banku bez valutových kurzov', () => {
  const data = parseRatesPage(fixture);
  const prima = data.banks.find((item) => item.bank === 'Prima banka');
  assert.equal(prima.rates[0].deviza.sell, 1.1263);
  assert.equal(prima.rates[0].valuta.sell, null);
});

test('zoznam mien je unikátny a zoradený', () => {
  const data = parseRatesPage(fixture);
  assert.deepEqual(summarizeCurrencies(data.banks), ['CZK', 'USD']);
});

import { parseDirectBankPage } from '../src/parser.js';

const directFixture = await fs.readFile(new URL('./fixtures/direct-banks.html', import.meta.url), 'utf8');

test('parser oficiálnej stránky ignoruje spread za kurzami', () => {
  const bank = parseDirectBankPage(directFixture, {
    bank: 'mBank',
    url: 'https://www.mbank.sk/kurzovy-listok/',
    layout: 'deviza3'
  });
  assert.equal(bank.validDate, '2026-07-20');
  assert.equal(bank.rates.length, 2);
  const usd = bank.rates.find((item) => item.currency === 'USD');
  assert.equal(usd.deviza.buy, 1.1758);
  assert.equal(usd.deviza.sell, 1.1074);
  assert.equal(usd.deviza.mid, 1.1416);
  assert.equal(usd.valuta.buy, null);
});

test('parser oficiálnej stránky zvládne devízy aj valuty', () => {
  const html = `<p>Exchange rate from day 26.6.2026</p><table>
    <tr><td>USD</td><td>1,150</td><td>1,121</td><td>1,130</td><td>1,160</td><td>1,110</td></tr>
  </table>`;
  const bank = parseDirectBankPage(html, {
    bank: 'Penta Bank',
    url: 'https://ibank.pentabank.com/Extranet/Pages/ExchangeList.aspx',
    layout: 'full5'
  });
  assert.equal(bank.validDate, '2026-06-26');
  assert.equal(bank.rates[0].deviza.buy, 1.15);
  assert.equal(bank.rates[0].valuta.sell, 1.11);
});

test('Penta parser ignoruje historický dátum z upozornenia a vezme najnovší', () => {
  const html = `<p>The date format is DD.MM.YYYY</p>
    <p>The item 5.12.2014 exceeded the permitted range from 5.12.2014 to 20.7.2026.</p>
    <p>Exchange rate from day 20.7.2026 (0:00:00)</p>
    <table><tr><td>USD</td><td>1,157</td><td>1,128</td><td>1,140</td><td>1,170</td><td>1,110</td></tr></table>`;
  const bank = parseDirectBankPage(html, {
    bank: 'Penta Bank',
    url: 'https://ibank.pentabank.com/Extranet/Pages/ExchangeList.aspx',
    layout: 'full5'
  });
  assert.equal(bank.validDate, '2026-07-20');
  assert.equal(bank.rates[0].deviza.buy, 1.157);
  assert.equal(bank.rates[0].valuta.sell, 1.11);
});

import { parseAdaptiveBankPage, parseJtExchangeRateList } from '../src/parser.js';

const jtFixture = await fs.readFile(new URL('./fixtures/jt-rendered.html', import.meta.url), 'utf8');

test('adaptívny parser spojí samostatné J&T devízy a valuty', () => {
  const bank = parseAdaptiveBankPage(jtFixture, {
    bank: 'J&T Banka',
    url: 'https://www.jtbanka.sk/uzitocne-informacie/kurzovy-listok/',
    layout: 'adaptive'
  });
  assert.equal(bank.validDate, '2026-07-21');
  const usd = bank.rates.find((item) => item.currency === 'USD');
  assert.equal(usd.deviza.buy, 1.176);
  assert.equal(usd.deviza.sell, 1.108);
  assert.equal(usd.deviza.mid, 1.142);
  assert.equal(usd.valuta.buy, 1.185);
  assert.equal(usd.valuta.sell, 1.099);
});


test('J&T JSON parser normalizuje opačne pomenované nákupné a predajné kurzy', () => {
  const payload = {
    params: { errorWarning: [] },
    data: {
      dateOfValidity: '2026-07-20T17:09:27+02:00',
      listOfExchangeRates: [
        {
          countryCode: 'US',
          currencyCode: 'USD',
          currencyRateDetail: {
            nominal: 1,
            fcyBuy: 1.1181,
            fcySell: 1.1638,
            fcyMiddle: 1.14095,
            banknotesBuy: 1.1124,
            banknotesSell: 1.1695,
            banknotesMiddle: 1.14095,
            dateOfValidity: '2026-07-20T17:09:27+02:00'
          }
        },
        {
          countryCode: 'HU',
          currencyCode: 'HUF',
          currencyRateDetail: {
            nominal: 1,
            fcyBuy: 353.7653,
            fcySell: 368.2047,
            fcyMiddle: 360.985,
            banknotesBuy: null,
            banknotesSell: null,
            banknotesMiddle: null
          }
        }
      ]
    }
  };

  const bank = parseJtExchangeRateList(payload, {
    bank: 'J&T Banka',
    url: 'https://www.jtbanka.sk/uzitocne-informacie/kurzovy-listok/'
  }, '2026-07-21T10:00:00.000Z');

  assert.equal(bank.validDate, '2026-07-20');
  assert.equal(bank.rates.length, 2);
  const usd = bank.rates.find((item) => item.currency === 'USD');
  assert.equal(usd.deviza.buy, 1.1638);
  assert.equal(usd.deviza.sell, 1.1181);
  assert.equal(usd.valuta.buy, 1.1695);
  assert.equal(usd.valuta.sell, 1.1124);
  const huf = bank.rates.find((item) => item.currency === 'HUF');
  assert.equal(huf.valuta.buy, null);
});
