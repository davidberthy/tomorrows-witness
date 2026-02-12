import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// Serve static files from the built app
app.use(express.static(join(__dirname, 'dist')));

// Proxy endpoint for Anthropic API — keeps the key server-side
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

// ==========================================
// CURATED MARKET SIGNALS
// Pull wide, let Claude curate the best ones
// Cache for 30 minutes to save API calls
// ==========================================

let cachedSignals = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchRawMarkets() {
  const results = { polymarket: [], metaculus: [] };

  // Pull 40 from Polymarket for a wide net
  try {
    const resp = await fetch(
      'https://gamma-api.polymarket.com/events?limit=40&active=true&closed=false&order=volume24hr&ascending=false'
    );
    if (resp.ok) {
      const data = await resp.json();
      results.polymarket = (data || []).map((event) => {
        const market = event.markets?.[0];
        const bestAsk = market?.bestAsk
          ? Math.round(parseFloat(market.bestAsk) * 100)
          : null;
        return {
          source: 'Polymarket',
          title: event.title || market?.question || '',
          probability: bestAsk,
          volume: event.volume24hr
            ? Math.round(parseFloat(event.volume24hr))
            : 0,
        };
      }).filter(m => m.title);
    }
  } catch (e) {
    console.error('Polymarket fetch error:', e);
  }

  // Pull 20 from Metaculus
  try {
    const resp = await fetch(
      'https://www.metaculus.com/api2/questions/?limit=20&order_by=-activity&status=open&type=forecast&forecast_type=binary'
    );
    if (resp.ok) {
      const data = await resp.json();
      results.metaculus = (data.results || []).map((q) => {
        const communityPred = q.community_prediction?.full?.q2;
        return {
          source: 'Metaculus',
          title: q.title || '',
          probability: communityPred ? Math.round(communityPred * 100) : null,
          forecasters: q.number_of_forecasters || 0,
        };
      }).filter(m => m.title);
    }
  } catch (e) {
    console.error('Metaculus fetch error:', e);
  }

  return results;
}

async function curateWithClaude(rawMarkets, apiKey) {
  const allQuestions = [
    ...rawMarkets.polymarket.map(m => `[Polymarket] "${m.title}" (${m.probability}% probability, $${m.volume.toLocaleString()} volume)`),
    ...rawMarkets.metaculus.map(m => `[Metaculus] "${m.title}" (${m.probability}% probability, ${m.forecasters} forecasters)`),
  ].join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a strategic intelligence curator for a futures research team. Your job is to select the 12 most strategically interesting prediction market questions from a raw list.

SELECTION CRITERIA (in priority order):
1. GENUINE UNCERTAINTY: Prefer questions in the 20-80% probability range — these are where the interesting action is. Skip near-certainties (>90%) and long shots (<10%) unless they're unusually important.
2. STRATEGIC RELEVANCE: Prioritize questions about technology, AI, geopolitics, economic shifts, energy, trade, regulation, and institutional change. These spark the best strategic conversations.
3. DIVERSITY: Pick across different domains — don't select 5 politics questions. Aim for a mix of tech, geopolitics, economics, science, and culture.
4. ACTIONABILITY: Prefer questions where the outcome would change how someone plans or invests.
5. SKIP: Sports betting, celebrity gossip, weather, trivial pop culture, and questions that are purely US partisan politics with no broader strategic implications.

RESPOND WITH ONLY a JSON array of the selected question titles, exactly as they appear in the input. No other text. Example:
["Question title 1", "Question title 2", "Question title 3"]`,
        messages: [
          { role: 'user', content: `Here are the current prediction market questions. Select the 12 most strategically interesting:\n\n${allQuestions}` }
        ],
      }),
    });

    const data = await response.json();
    const text = (data.content || [])
      .map(b => b.type === 'text' ? b.text : '')
      .filter(Boolean)
      .join('');

    // Parse the JSON array of selected titles
    const clean = text.replace(/```json|```/g, '').trim();
    const selectedTitles = JSON.parse(clean);

    // Match back to full market objects
    const allMarkets = [...rawMarkets.polymarket, ...rawMarkets.metaculus];
    const curated = selectedTitles
      .map(title => allMarkets.find(m => m.title === title))
      .filter(Boolean);

    return curated.length > 0 ? curated : allMarkets.slice(0, 12);
  } catch (e) {
    console.error('Curation error:', e);
    // Fallback: return top items by volume/forecasters
    return [
      ...rawMarkets.polymarket.slice(0, 6),
      ...rawMarkets.metaculus.slice(0, 6),
    ];
  }
}

// Curated signals endpoint
app.get('/api/markets/curated', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Return cache if fresh
  if (cachedSignals && Date.now() - cacheTimestamp < CACHE_TTL) {
    return res.json(cachedSignals);
  }

  try {
    const rawMarkets = await fetchRawMarkets();
    const totalRaw = rawMarkets.polymarket.length + rawMarkets.metaculus.length;

    if (totalRaw === 0) {
      return res.json([]);
    }

    let curated;
    if (apiKey) {
      curated = await curateWithClaude(rawMarkets, apiKey);
    } else {
      // No API key — just return top items
      curated = [
        ...rawMarkets.polymarket.slice(0, 6),
        ...rawMarkets.metaculus.slice(0, 6),
      ];
    }

    cachedSignals = curated;
    cacheTimestamp = Date.now();
    res.json(curated);
  } catch (err) {
    console.error('Curated markets error:', err);
    res.json(cachedSignals || []);
  }
});

// Keep legacy endpoints as fallbacks
app.get('/api/markets/polymarket', async (req, res) => {
  try {
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?limit=12&active=true&closed=false&order=volume24hr&ascending=false'
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Polymarket error:', err);
    res.json([]);
  }
});

app.get('/api/markets/metaculus', async (req, res) => {
  try {
    const response = await fetch(
      'https://www.metaculus.com/api2/questions/?limit=8&order_by=-activity&status=open&type=forecast&forecast_type=binary'
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Metaculus error:', err);
    res.json({ results: [] });
  }
});

// SPA fallback — serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tomorrow's Witness running on port ${PORT}`);
});
