import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRates } from './src/data-source.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/rates', async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  try {
    const data = await getRates({ force: req.query.force === '1' });
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: 'Kurzy sa nepodarilo načítať.',
      detail: error.message
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
  console.log(`Kurzové lístky: http://localhost:${port}`);
});
