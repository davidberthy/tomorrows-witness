import express from 'express';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// ==========================================
// DATABASE — question logging
// ==========================================
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query(`
  CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => console.log('Questions table ready'))
  .catch(err => console.error('DB init error:', err));

pool.query(`
  CREATE TABLE IF NOT EXISTS forecasts (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    confidence INT CHECK (confidence BETWEEN 1 AND 5),
    predicted_outcome TEXT,
    actual_outcome BOOLEAN,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )
`).then(() => console.log('Forecasts table ready'))
  .catch(err => console.error('Forecasts DB init error:', err));


// Serve static files from the built app
app.use(express.static(join(__dirname, 'dist')));

// Proxy endpoint for Anthropic API — keeps the key server-side
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.INFERENCE_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'INFERENCE_KEY not configured' });
  }

  try {
    const response = await fetch('https://us.inference.heroku.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
// OPENAI PROXY — Cross-model lens
// ==========================================
app.post('/api/openai', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('OpenAI API error:', err);
    res.status(500).json({ error: 'Failed to reach OpenAI API' });
  }
});

// ==========================================
// CURATED MARKET SIGNALS
// Pull wide, let Claude curate the best ones
// Cache for 30 minutes to save API calls
// ==========================================

let cachedSignals = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 30 minutes

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

  // Pull events from Kalshi (real-money, CFTC-regulated)
  try {
    const resp = await fetch(
      'https://api.elections.kalshi.com/trade-api/v2/events?limit=100&status=open&with_nested_markets=true'
    );
    if (resp.ok) {
      const data = await resp.json();
      const skipCats = ['Sports', 'Sports & Gaming'];
      results.metaculus = (data.events || [])
        .filter(e => !skipCats.includes(e.category))
        .filter(e => e.markets && e.markets.length > 0)
        .map(e => {
          const m = e.markets[0];
          return {
            source: 'Kalshi',
            title: e.title || '',
            probability: m.last_price || null,
            volume: m.volume || 0,
          };
        })
        .filter(m => m.title && m.probability != null && m.probability > 0);
    }
  } catch (e) {
    console.error('Kalshi fetch error:', e);
  }

  return results;
}

async function curateWithClaude(rawMarkets, apiKey) {
  const allQuestions = [
    ...rawMarkets.polymarket.map(m => `[Polymarket] "${m.title}" (${m.probability}% probability, $${m.volume.toLocaleString()} volume)`),
    ...rawMarkets.metaculus.map(m => `[Kalshi] "${m.title}" (${m.probability}% probability, ${m.forecasters} vol)`),
  ].join('\n');

  try {
    const response = await fetch('https://us.inference.heroku.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1000,
        system: `You are a strategic intelligence curator for a futures research team. Your job is to select the 12 most strategically interesting prediction market questions from a raw list.

HARD FILTER (apply first, before any selection):
- REJECT ALL SPORTS: Any question about NBA, NFL, NHL, MLB, FIFA, UFC, F1, tennis, golf, cricket, boxing, MMA, esports, college sports, Olympics, individual athletes, teams, matches, championships, MVPs, player stats, or any sporting event. Zero sports questions in your output. If in doubt whether something is sports, exclude it.

SELECTION CRITERIA (apply to remaining non-sports questions):
1. GENUINE UNCERTAINTY: Prefer questions in the 20-80% probability range — these are where the interesting action is. Skip near-certainties (>90%) and long shots (<10%) unless they're unusually important.
2. STRATEGIC RELEVANCE: Prioritize questions about technology, AI, geopolitics, economic shifts, energy, trade, regulation, and institutional change. These spark the best strategic conversations.
3. DIVERSITY: Pick across different domains — don't select 5 politics questions. Aim for a mix of tech, geopolitics, economics, science, and culture.
4. ACTIONABILITY: Prefer questions where the outcome would change how someone plans or invests.
5. SKIP: ALL sports questions (NBA, NFL, FIFA, UFC, tennis, F1, individual matches, championships, player performance — no exceptions), celebrity gossip, weather, trivial pop culture, crypto price predictions for specific dates, and questions that are purely US partisan politics with no broader strategic implications.

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
  const apiKey = process.env.INFERENCE_KEY;

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

app.get('/api/markets/kalshi', async (req, res) => {
  try {
    const response = await fetch(
      'https://api.elections.kalshi.com/trade-api/v2/events?limit=50&status=open&with_nested_markets=true'
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Manifold error:', err);
    res.json([]);
  }
});

// Semantic market matching endpoint
app.post('/api/markets/match', async (req, res) => {
  const { question } = req.body;
  const apiKey = process.env.INFERENCE_KEY;
  
  if (!question || !apiKey) {
    return res.json([]);
  }

  try {
    // Get fresh raw markets (or use cached)
    const rawMarkets = await fetchRawMarkets();
    const allMarkets = [...rawMarkets.polymarket, ...rawMarkets.metaculus];
    
    if (allMarkets.length === 0) {
      return res.json([]);
    }

    const marketList = allMarkets.map((m, i) => 
      `${i}. [${m.source}] "${m.title}" (${m.probability}%)`
    ).join('\n');

    const response = await fetch('https://us.inference.heroku.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: `You are a relevance matcher. Given a user's question and a list of prediction market questions, identify which markets are DIRECTLY relevant to the user's question. Consider semantic meaning, not just keyword overlap. A market about "Taiwan invasion" is relevant to a question about "US-China relations." A market about "AI movie generation" is NOT relevant to a question about "housing prices."

If NO markets are relevant, respond with exactly: []
Otherwise respond with a JSON array of the market INDEX NUMBERS only. Example: [3, 7, 12]
Respond with ONLY the JSON array, nothing else.`,
        messages: [
          { role: 'user', content: `User's question: "${question}"\n\nPrediction markets:\n${marketList}` }
        ],
      }),
    });

    const data = await response.json();
    const text = (data.content || []).map(b => b.type === 'text' ? b.text : '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    
    if (clean === '[]') {
      return res.json([]);
    }

    const indices = JSON.parse(clean);
    const matched = indices
      .filter(i => i >= 0 && i < allMarkets.length)
      .map(i => allMarkets[i])
      .slice(0, 5);
    
    res.json(matched);
  } catch (err) {
    console.error('Semantic match error:', err);
    res.json([]);
  }
});

// SPA fallback — serve index.html for all other routes

// Log a question
app.post('/api/log-question', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'No question' });
  try {
    await pool.query('INSERT INTO questions (question) VALUES ($1)', [question]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Log error:', err);
    res.json({ ok: false });
  }
});

// Admin view — simple page showing all questions
app.get('/admin/questions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT question, created_at FROM questions ORDER BY created_at DESC LIMIT 200'
    );
    const rows = result.rows;
    const html = `<!DOCTYPE html>
<html><head><title>Tomorrow's Witness — Questions Log</title>
<style>
  body { background: #1a1410; color: #e6d7be; font-family: 'Courier New', monospace; padding: 40px; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 18px; color: #d4a84a; letter-spacing: 0.1em; text-transform: uppercase; }
  .count { font-size: 13px; color: rgba(230,215,190,0.5); margin-bottom: 30px; }
  .q { border-bottom: 1px solid rgba(180,150,100,0.15); padding: 12px 0; }
  .q-text { font-size: 15px; line-height: 1.5; }
  .q-time { font-size: 11px; color: rgba(230,215,190,0.4); margin-top: 4px; }
</style></head><body>
<h1>Questions Log</h1>
<div class="count">${rows.length} questions recorded</div>
${rows.map(r => '<div class="q"><div class="q-text">' + r.question.replace(/</g, '&lt;') + '</div><div class="q-time">' + new Date(r.created_at).toLocaleString() + '</div></div>').join('')}
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error('Admin error:', err);
    res.status(500).send('Database error');
  }
});

// Log a forecast for Brier scoring
app.post('/api/log-forecast', async (req, res) => {
  const { question, confidence, predicted_outcome } = req.body;
  if (!question || !confidence) return res.json({ ok: false });
  try {
    await pool.query(
      'INSERT INTO forecasts (question, confidence, predicted_outcome) VALUES ($1, $2, $3)',
      [question.slice(0, 1000), confidence, predicted_outcome || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Forecast log error:', err);
    res.json({ ok: false });
  }
});

// Resolve a forecast (admin)
app.post('/api/resolve-forecast', async (req, res) => {
  const { id, outcome } = req.body;
  if (!id || outcome === undefined) return res.json({ ok: false });
  try {
    await pool.query(
      'UPDATE forecasts SET actual_outcome = $1, resolved = TRUE, resolved_at = NOW() WHERE id = $2',
      [outcome, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Resolve error:', err);
    res.json({ ok: false });
  }
});

// Brier Score admin dashboard
app.get('/admin/brier', async (req, res) => {
  try {
    const all = await pool.query(
      'SELECT * FROM forecasts ORDER BY created_at DESC LIMIT 500'
    );
    const rows = all.rows;
    const resolved = rows.filter(r => r.resolved);
    
    // Calculate Brier score
    // Convert confidence (1-5) to probability:
    // 5 = 0.95, 4 = 0.80, 3 = 0.60, 2 = 0.40, 1 = 0.20
    const confToProb = { 1: 0.20, 2: 0.40, 3: 0.60, 4: 0.80, 5: 0.95 };
    
    let brierSum = 0;
    let brierCount = 0;
    const buckets = { 1: { total: 0, correct: 0 }, 2: { total: 0, correct: 0 }, 3: { total: 0, correct: 0 }, 4: { total: 0, correct: 0 }, 5: { total: 0, correct: 0 } };
    
    resolved.forEach(r => {
      const prob = confToProb[r.confidence] || 0.5;
      const outcome = r.actual_outcome ? 1 : 0;
      brierSum += (prob - outcome) ** 2;
      brierCount++;
      if (buckets[r.confidence]) {
        buckets[r.confidence].total++;
        if (r.actual_outcome) buckets[r.confidence].correct++;
      }
    });
    
    const brierScore = brierCount > 0 ? (brierSum / brierCount).toFixed(4) : 'N/A';
    
    const calibrationRows = [1,2,3,4,5].map(conf => {
      const b = buckets[conf];
      const actual = b.total > 0 ? (b.correct / b.total * 100).toFixed(0) : '-';
      const expected = (confToProb[conf] * 100).toFixed(0);
      return `<tr><td>${conf} dot${ conf > 1 ? 's' : '' }</td><td>${expected}%</td><td>${actual}%</td><td>${b.total}</td></tr>`;
    }).join('');
    
    const forecastRows = rows.map(r => {
      const status = r.resolved ? (r.actual_outcome ? '<span style="color:#6fa86f">TRUE</span>' : '<span style="color:#c46a6a">FALSE</span>') : `<button onclick="resolve(${r.id}, true)" style="background:#2a3a2a;color:#6fa86f;border:1px solid #4a5a4a;padding:2px 8px;cursor:pointer;margin-right:4px;border-radius:3px">True</button><button onclick="resolve(${r.id}, false)" style="background:#3a2a2a;color:#c46a6a;border:1px solid #5a4a4a;padding:2px 8px;cursor:pointer;border-radius:3px">False</button>`;
      return `<tr><td style="max-width:400px;word-wrap:break-word">${r.question.replace(/</g, '&lt;').slice(0, 120)}</td><td style="text-align:center">${'●'.repeat(r.confidence)}${'○'.repeat(5 - r.confidence)}</td><td>${status}</td><td style="font-size:11px;color:rgba(230,215,190,0.4)">${new Date(r.created_at).toLocaleDateString()}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head><title>Tomorrow's Witness — Brier Score Tracker</title>
<style>
  body { background: #1a1410; color: #e6d7be; font-family: 'Courier New', monospace; padding: 40px; max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 18px; color: #d4a84a; letter-spacing: 0.1em; text-transform: uppercase; }
  h2 { font-size: 14px; color: #d4a84a; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 30px; }
  .score-box { background: rgba(212,168,74,0.08); border: 1px solid rgba(212,168,74,0.2); border-radius: 8px; padding: 20px; margin: 20px 0; display: inline-block; }
  .score-val { font-size: 36px; color: #d4a84a; font-weight: bold; }
  .score-label { font-size: 11px; color: rgba(230,215,190,0.5); text-transform: uppercase; letter-spacing: 0.1em; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(230,215,190,0.4); padding: 8px; border-bottom: 1px solid rgba(180,150,100,0.2); }
  td { padding: 8px; border-bottom: 1px solid rgba(180,150,100,0.08); font-size: 13px; }
  .meta { font-size: 12px; color: rgba(230,215,190,0.4); margin-top: 8px; }
</style>
<script>
async function resolve(id, outcome) {
  await fetch('/api/resolve-forecast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, outcome })
  });
  location.reload();
}
</script>
</head><body>
<h1>Brier Score Tracker</h1>
<div class="score-box">
  <div class="score-val">${brierScore}</div>
  <div class="score-label">Brier Score (${brierCount} resolved)</div>
</div>
<div class="meta">Below 0.20 = good · Below 0.10 = excellent · Best election forecasters: 0.06–0.12</div>

<h2>Calibration Table</h2>
<table>
  <tr><th>Confidence</th><th>Expected %</th><th>Actual %</th><th>n</th></tr>
  ${calibrationRows}
</table>

<h2>All Forecasts</h2>
<table>
  <tr><th>Question</th><th>Confidence</th><th>Outcome</th><th>Date</th></tr>
  ${forecastRows}
</table>
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error('Brier admin error:', err);
    res.status(500).send('Database error');
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tomorrow's Witness running on port ${PORT}`);
});
