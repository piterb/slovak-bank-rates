# Kurzové lístky slovenských bánk

Node/Express aplikácia na porovnanie kurzov slovenských bánk podľa reálneho výsledku transakcie.

## Spustenie

```bash
npm install
npm start
```

Otvorte `http://localhost:3000`.

## Zdroje

- spoločný prehľad: kurzy-online.sk,
- mBank: oficiálny kurzový lístok,
- Penta Bank: oficiálny internetbankingový kurzový lístok,
- J&T Banka: verejné JSON API používané oficiálnou stránkou; pri víkende alebo sviatku sa automaticky skúsi posledný dostupný deň.

Tatra banka a Raiffeisen banka sú zobrazené spolu, pretože používajú rovnaký kurzový lístok.
Oberbank je z porovnania vyradená pre nespoľahlivé zdrojové kurzy.

## Test

```bash
npm test
```

Offline ukážkové dáta:

```bash
USE_FIXTURE=1 npm start
```

## Oprava 1.4.1

- Opravené prehodené nákupné a predajné kurzy J&T Banky pri devízach aj valutách.


## Nasadenie zadarmo na Render

1. Nahraj obsah tohto priečinka do GitHub repozitára.
2. V Render Dashboard zvoľ **New > Blueprint** a pripoj repozitár.
3. Render načíta `render.yaml`; potvrď vytvorenie služby na pláne Free.
4. Po deployi otvor pridelenú adresu `https://...onrender.com`.

Health check používa `/health`, aby pri kontrole služby zbytočne nenačítaval všetky bankové zdroje.
