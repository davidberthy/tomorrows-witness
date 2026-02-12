import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'dist')));

app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(500).json({ error: 'Failed to reach Anthropic API' });
  }
});

app.get('/api/markets/polymarket', async (req, res) => {
  try {
    const response = await fetch('https://gamma-api.polymarket.com/events?limit=12&active=true&closed=false&order=volume24hr&ascending=false');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Polymarket error:', err);
    res.json([]);
  }
});

app.get('/api/markets/metaculus', async (req, res) => {
  try {
    const response = await fetch('https://www.metaculus.com/api2/questions/?limit=8&order_by=-activity&status=open&type=forecast&forecast_type=binary');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Metaculus error:', err);
    res.json({ results: [] });
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Tomorrows Witness running on port ' + PORT);
});
