import express from 'express';
import pg from 'pg';
import multer from 'multer';
import { createRequire } from 'module'; const require = createRequire(import.meta.url); const pdf = require('pdf-parse');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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


// ==========================================
// THE WAGER — experimental paper-trading tab
// ==========================================
// A forward paper-trading experiment (NOT real money, NO backtesting). Three
// arms judge the SAME events and we track which one calls headline-driven
// overreactions better:
//   - rules  : a purely mechanical fade rule (no model, no judgment)
//   - jev     : Jev (typesafe.ai) as the judgment layer
//   - claude  : Claude as the judgment layer
// Every decision logs the exact thresholds it used so results stay honest.
// Money is tracked in integer CENTS everywhere to avoid float drift.
// The Anthropic model used for BOTH the neutral cause-description writer and
// the Claude judging arm. Heroku Managed Inference currently tops out at
// claude-opus-4-8 (verified against the live model catalog). To move to a
// newer Opus via a direct Anthropic key later, change this one line (and point
// the Claude calls at api.anthropic.com with ANTHROPIC_API_KEY).
const WAGER_MODEL = 'claude-opus-4-8';

// Rough Anthropic Opus rates, used only to estimate a run's notional API spend
// so the per-run spend cap can stop a run on a busy news day. (~$15/M input,
// ~$75/M output.) Heroku bundles inference billing; this is a soft budget.
const WAGER_COST = { inPerToken: 15 / 1e6, outPerToken: 75 / 1e6 };

// Default, FREEZABLE experiment settings. When a run is created these are
// snapshotted into the run (wager_runs.settings) so they can never change
// mid-experiment — pre-registration built into the object. To try different
// thresholds you start a NEW run.
const WAGER = {
  version: 'v1',
  bankroll: 10000,        // $10,000 paper bankroll per arm, per run
  kellyFraction: 0.25,    // quarter-Kelly — size a fraction of the full Kelly bet
  arms: ['rules', 'jev', 'claude'], // which arms a run includes
  // Trade only when the edge clears these bars (edge = our prob − price we pay):
  edge_stand_down: 0.02,  // below this → stand_down (no interest)
  edge_candidate: 0.08,   // at/above this → candidate (take the trade); between → investigate (flag only)
  // Automated detection screen (deliberately LOOSER than the rules arm, so the
  // rules arm doesn't approve everything the scanner surfaces by construction).
  detect: {
    min_move_points: 8,        // surface a market that moved >= 8 pts in ~1 hour
    window_minutes: 60,        // "within an hour"
    max_events_per_day: 10,    // cap the funnel; biggest movers first
    rescan_cooldown_hours: 24, // don't re-evaluate the same market within a day
  },
  // The mechanical rules-only arm. These are FROZEN per run and never tuned
  // after seeing results. They are logged with every single decision.
  rules: {
    min_move_points: 15,               // only fade a move of >= 15 points
    min_move_multiple_vs_related: 2,   // ...and only if it moved >= 2x related markets
    min_days_to_resolution: 7,         // need >= 7 days left (a hard limit for ALL arms)
    min_entry_price_cents: 10,         // entry price must be in [10c, 90c] (a hard limit for ALL arms)
    max_entry_price_cents: 90,
  },
};

// A run's frozen settings, merged into the shape evaluateArm/rulesArm expect
// (bankroll in dollars). run.settings is a snapshot of WAGER taken at creation.
function runConfig(run) {
  return { ...run.settings, bankroll: (run.bankroll_cents ?? WAGER.bankroll * 100) / 100 };
}

// Entry window → hours (null = ongoing / no deadline).
const WINDOW_HOURS = { '24h': 24, '1week': 168, '30days': 720, ongoing: null };

// Kalshi's trading fee: round up( 0.07 * contracts * p * (1-p) ), p in dollars.
// Returned in whole cents.
function kalshiFeeCents(priceCents, contracts) {
  const p = priceCents / 100;
  return Math.ceil(0.07 * contracts * p * (1 - p) * 100);
}

// Create the wager_* tables in foreign-key dependency order. These MUST run
// sequentially, not as independent parallel pool.query() chains: wager_events
// references wager_runs, and wager_judgments/positions/journal reference
// wager_events. Fired in parallel they race on a FRESH database — a child table
// can be created before its parent exists and fail with "relation does not
// exist". That's invisible on an already-migrated DB (CREATE IF NOT EXISTS is a
// no-op), so it only bites the very first deploy to a new environment.
(async () => {
  try {
    // wager_runs — a named, bounded, pre-registered experiment. Its settings are
    // frozen at creation; lifecycle goes active → settling → complete.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_runs (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        entry_window TEXT DEFAULT 'ongoing',
        entry_deadline TIMESTAMPTZ,
        bankroll_cents INT DEFAULT 1000000,
        max_ttr_hours INT,
        spend_cap_cents INT,
        spent_cents INT DEFAULT 0,
        loss_stop_cents INT,
        settings JSONB,
        report JSONB,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('wager_runs table ready');

    // wager_events — one snapshot of a market at the moment we decided.
    // instrument_type carries 'kalshi' now, leaves room for 'equity' later.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_events (
        id SERIAL PRIMARY KEY,
        run_id INT REFERENCES wager_runs(id),
        external_id TEXT,
        source TEXT DEFAULT 'manual',
        instrument_type TEXT DEFAULT 'kalshi',
        title TEXT NOT NULL,
        description TEXT,
        resolution_date DATE,
        pre_move_price_cents INT,
        current_price_cents INT,
        move_points INT,
        related_move_points INT,
        days_to_resolution INT,
        features JSONB,
        resolved BOOLEAN DEFAULT FALSE,
        outcome BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);
    console.log('wager_events table ready');

    // wager_judgments — the raw judgment each arm produced for an event (stored
    // verbatim so we can audit what Jev/Claude actually said).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_judgments (
        id SERIAL PRIMARY KEY,
        event_id INT REFERENCES wager_events(id),
        arm TEXT NOT NULL,
        question_id TEXT,
        judgment_type TEXT,
        raw_response JSONB,
        fair_prob NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('wager_judgments table ready');

    // wager_positions — the decision + (if traded) the paper position for each arm.
    // A no-trade decision is recorded too (contracts = 0) so every arm is on record.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_positions (
        id SERIAL PRIMARY KEY,
        event_id INT REFERENCES wager_events(id),
        run_id INT REFERENCES wager_runs(id),
        arm TEXT NOT NULL,
        decision_state TEXT,
        side TEXT,
        entry_price_cents INT,
        contracts INT DEFAULT 0,
        stake_cents INT DEFAULT 0,
        fees_cents INT DEFAULT 0,
        fair_prob NUMERIC,
        edge NUMERIC,
        kelly_fraction_used NUMERIC,
        thresholds JSONB,
        settled BOOLEAN DEFAULT FALSE,
        pnl_cents INT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      )
    `);
    console.log('wager_positions table ready');

    // wager_journal — an append-only snapshot of exactly what was sent to each
    // arm and what came back, for full reproducibility.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_journal (
        id SERIAL PRIMARY KEY,
        event_id INT REFERENCES wager_events(id),
        arm TEXT NOT NULL,
        snapshot JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('wager_journal table ready');

    // wager_price_snapshots — the scanner records the price of each Kalshi market
    // on every run so it can measure a market's move over the last hour. (No FK;
    // ordered last only for a tidy, deterministic init log.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wager_price_snapshots (
        id SERIAL PRIMARY KEY,
        market_ticker TEXT NOT NULL,
        title TEXT,
        price_cents INT,
        close_time TIMESTAMPTZ,
        ts TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wps_ticker_ts ON wager_price_snapshots (market_ticker, ts DESC)`);
    console.log('wager_price_snapshots table ready');
  } catch (err) {
    console.error('wager_* DB init error:', err);
  }
})();


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
        model: 'claude-opus-4-8',
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
        model: 'claude-opus-4-8',
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

// Fetch and extract text from a URL
app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TomorrowsWitness/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.status(400).json({ error: 'Failed to fetch URL' });
    const html = await resp.text();
    // Strip HTML tags, scripts, styles — extract readable text
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    // Truncate to ~4000 words to fit context
    const words = text.split(' ');
    if (words.length > 4000) text = words.slice(0, 4000).join(' ') + '...';
    res.json({ text, wordCount: words.length });
  } catch (err) {
    console.error('URL fetch error:', err);
    res.status(500).json({ error: 'Failed to extract content' });
  }
});

// Extract text from uploaded PDF
// pdf-parse v2 exports a PDFParse *class*: construct it with { data } and call
// getText(), rather than calling it like a function (the old v1 API). Getting
// this wrong throws "Class constructors cannot be invoked without 'new'".
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const parser = new pdf.PDFParse({ data: new Uint8Array(req.file.buffer) });
    const data = await parser.getText();
    let text = data.text.replace(/\s+/g, ' ').trim();
    const words = text.split(' ');
    if (words.length > 4000) text = words.slice(0, 4000).join(' ') + '...';
    res.json({ text, wordCount: words.length, pages: data.total ?? data.numpages });
  } catch (err) {
    console.error('PDF extract error:', err);
    res.status(500).json({ error: 'Failed to extract PDF text' });
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

// ==========================================
// THE WAGER — sizing, judgment, and routes
// ==========================================

// Days from now until a resolution date (deterministic, computed in code —
// we never ask a model to do date math).
function daysBetween(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.max(0, Math.round((d - new Date()) / 86400000));
}

// Turn a fair YES probability into a decision + (maybe) a sized paper position.
// The hard limits here (price band, days-to-resolution, quarter-Kelly cap)
// apply to EVERY arm — a model's judgment can pick the probability but can
// never override these guardrails.
function evaluateArm({ fairProbYes, features, config }) {
  const t = config.rules;
  const yesAsk = features.yes_ask_cents;

  const withinBand = yesAsk >= t.min_entry_price_cents && yesAsk <= t.max_entry_price_cents;
  const enoughTime = features.days_to_resolution != null && features.days_to_resolution >= t.min_days_to_resolution;

  // Pick the side by comparing our probability to the YES ask. We fill at the
  // ask on whichever side we take (YES costs the ask; NO costs 100 − ask).
  const side = fairProbYes >= (yesAsk / 100) ? 'yes' : 'no';
  const costCents = side === 'yes' ? yesAsk : (100 - yesAsk);
  const c = costCents / 100;
  const pWin = side === 'yes' ? fairProbYes : (1 - fairProbYes);
  const edge = pWin - c; // > 0 means the bet is +EV before fees

  // Full Kelly for a 0/1 payout bought at cost c: f* = (p − c) / (1 − c).
  let kellyStar = (1 - c) > 0 ? (pWin - c) / (1 - c) : 0;
  if (!isFinite(kellyStar) || kellyStar < 0) kellyStar = 0;
  const kellyUsed = kellyStar * config.kellyFraction; // fractional (quarter) Kelly

  let state;
  if (!withinBand || !enoughTime || edge <= config.edge_stand_down) state = 'stand_down';
  else if (edge < config.edge_candidate) state = 'investigate';
  else state = 'candidate';

  let contracts = 0, stakeCents = 0, feesCents = 0;
  if (state === 'candidate' && costCents > 0) {
    const budgetCents = Math.floor(config.bankroll * 100 * kellyUsed);
    contracts = Math.floor(budgetCents / costCents);
    stakeCents = contracts * costCents;
    feesCents = kalshiFeeCents(costCents, contracts);
  }
  return { fairProbYes, side, costCents, edge, pWin, kellyStar, kellyUsed, state, contracts, stakeCents, feesCents, withinBand, enoughTime };
}

// The rules-only arm: a purely mechanical fade. It ONLY acts when all of its
// frozen conditions hold at decision time; otherwise it stands down. When it
// fires, "fair value" is simply the pre-move price (i.e. bet the move reverts).
function rulesArm({ features, config }) {
  const t = config.rules;
  // The "moved >= Nx related markets" test needs a related-market baseline.
  // related_move_points is now null when we genuinely have no peer data (no
  // sibling or same-category markets this scan, or a manual form left it blank)
  // and a real number — including 0 — when peers were observed. 0 means "peers
  // provably stayed flat," which is the strongest disproportion signal, so we
  // must fade on it, not stand down: `move >= N * 0` is trivially true and that
  // is correct. We only stand down when the baseline is null (unknown), since a
  // frozen mechanical arm can't establish disproportion without peer data.
  const fadeConditions =
    features.move_points >= t.min_move_points &&
    features.related_move_points != null &&
    features.move_points >= t.min_move_multiple_vs_related * features.related_move_points &&
    features.days_to_resolution != null && features.days_to_resolution >= t.min_days_to_resolution &&
    features.yes_ask_cents >= t.min_entry_price_cents &&
    features.yes_ask_cents <= t.max_entry_price_cents;
  if (!fadeConditions) {
    return { state: 'stand_down', reason: 'fade conditions not met', fairProbYes: null, side: null, costCents: null, contracts: 0, stakeCents: 0, feesCents: 0, edge: null, kellyUsed: null };
  }
  return evaluateArm({ fairProbYes: features.pre_move_price_cents / 100, features, config });
}

// Build the state we send to the models. The CURRENT price is deliberately
// withheld (and pre-move price is never sent alongside the move, which would
// let them reconstruct it) so the models judge the underlying odds, not the tape.
function buildWagerState(event, features) {
  return [
    `Event: ${event.title}`,
    event.description ? `Details: ${event.description}` : '',
    `Resolution date: ${event.resolution_date || 'unspecified'} (${features.days_to_resolution ?? '?'} days away).`,
    `Recent move: this market moved about ${features.move_points} points over the recent window.`,
    features.related_move_points != null ? `Related markets moved about ${features.related_move_points} points over the same window.` : '',
    `NOTE: the current market price is intentionally NOT provided. Estimate the true probability of a YES resolution from the underlying situation only — do not try to infer or echo a market price.`,
  ].filter(Boolean).join('\n');
}

// Jev (typesafe.ai) judgment layer. Retries 429/529 with exponential backoff.
async function callJev(stateString, questionId, questionText) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY not configured');
  // A 'noul' question MUST carry `criteria` or `instructions`, or the API
  // rejects the request with 400 ("Noul question must have criteria or
  // instructions"). The instructions mirror the price-withheld discipline used
  // for the Claude arm so both judges are asked the same thing.
  const body = {
    model: 'jev-latest',
    state: stateString,
    questions: {
      [questionId]: {
        type: 'noul',
        question: questionText,
        instructions: 'Estimate the true probability, between 0 and 1, that this event resolves YES based only on the underlying situation described in the state. You are NOT given the current market price — do not infer, guess, or echo one.',
      },
    },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if ((resp.status === 429 || resp.status === 529) && attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!resp.ok) throw new Error(`Jev API ${resp.status}`);
    return await resp.json();
  }
  throw new Error('Jev API rate-limited after retries');
}

// Claude judgment layer, via the same server-side inference endpoint we already
// use. Asked for a strict JSON fair probability, with the price withheld.
async function callClaudeFairProb(stateString, questionText) {
  const apiKey = process.env.INFERENCE_KEY;
  if (!apiKey) throw new Error('INFERENCE_KEY not configured');
  const resp = await fetch('https://us.inference.heroku.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: WAGER_MODEL,
      max_tokens: 500,
      system: `You are a calibrated forecaster. You will be given a description of a prediction-market event and asked for the probability it resolves YES. You are NOT told the current market price — do not guess it, infer it, or reverse-engineer it. Reason only about the underlying likelihood. Respond with ONLY a JSON object, no other text: {"fair_prob": <number between 0 and 1>, "rationale": "<one short sentence>"}.`,
      messages: [{ role: 'user', content: `${stateString}\n\nQuestion: ${questionText}` }],
    }),
  });
  if (!resp.ok) throw new Error(`Inference API ${resp.status}`);
  const data = await resp.json();
  const usage = data.usage || null;
  const text = (data.content || []).map(b => b.type === 'text' ? b.text : '').join('').trim();
  const clean = text.replace(/```json|```/g, '').trim();
  // Parse defensively: the call is already billed by the time we get here, so a
  // malformed response (Claude wrapping its JSON in prose despite the prompt)
  // must NOT discard `usage` — otherwise the run's spend cap silently
  // undercounts real spend and never trips. Surface the parse failure instead.
  let parsed = null, parseError = null;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    parseError = String(e.message || e);
  }
  return { parsed, usage, parseError };
}

// Estimate the USD cost of a model call from its token usage (for the run's
// notional API spend cap). Returns cents.
function usageToCents(usage) {
  if (!usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return Math.round((inTok * WAGER_COST.inPerToken + outTok * WAGER_COST.outPerToken) * 100);
}

// How much paper capital an arm currently has tied up in unsettled positions,
// scoped to a run. Autonomous trading needs a portfolio-level stop so an arm
// can't stake more than the run's bankroll across many open events.
async function openStakeCents(runId, arm) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(stake_cents), 0) AS s FROM wager_positions WHERE run_id IS NOT DISTINCT FROM $1 AND arm = $2 AND settled = FALSE AND contracts > 0`,
    [runId, arm]
  );
  return Number(r.rows[0].s) || 0;
}

// Core evaluation: judge one event across the run's arms, size within the
// run's risk limits, store everything, and (autonomously) open any candidate
// positions. Used by BOTH the manual form and the automated scanner — there is
// no human-approval step; arms trade themselves inside the guardrails.
// `run` carries the frozen settings (config, bankroll, arms, id). If null, a
// sandbox evaluation runs on defaults with no run_id (smoke-test only).
async function runWagerEvaluation(payload, run = null) {
  const {
    external_id = null, source = 'manual', instrument_type = 'kalshi',
    title, description = '',
    resolution_date = null, days_to_resolution = null,
    pre_move_price_cents = null, current_price_cents = null,
    move_points = null, related_move_points = null,
  } = payload || {};

  if (!title || current_price_cents == null) {
    throw new Error('title and current_price_cents are required');
  }

  const cfg = run ? runConfig(run) : { ...WAGER, bankroll: WAGER.bankroll };
  const includeArms = (run?.settings?.arms) || WAGER.arms;
  const runId = run?.id ?? null;

  // Deterministic features — all arithmetic done here in code, never by a model.
  const cur = Math.round(current_price_cents);
  const pre = pre_move_price_cents != null ? Math.round(pre_move_price_cents) : cur;
  const features = {
    yes_ask_cents: cur,
    pre_move_price_cents: pre,
    days_to_resolution: days_to_resolution != null ? Number(days_to_resolution) : daysBetween(resolution_date),
    move_points: move_points != null ? Math.abs(Math.round(move_points)) : Math.abs(cur - pre),
    related_move_points: related_move_points != null ? Math.abs(Math.round(related_move_points)) : null,
  };

  // The SAME shared state (including the neutral cause description) goes to
  // every judging arm. The current price is withheld inside buildWagerState.
  const stateString = buildWagerState({ title, description, resolution_date }, features);
  const question = 'Will this event resolve YES by its resolution date?';

  const evRes = await pool.query(
    `INSERT INTO wager_events (run_id, external_id, source, instrument_type, title, description, resolution_date, pre_move_price_cents, current_price_cents, move_points, related_move_points, days_to_resolution, features)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [runId, external_id, source, instrument_type, title, description, resolution_date, features.pre_move_price_cents, features.yes_ask_cents, features.move_points, features.related_move_points, features.days_to_resolution, features]
  );
  const eventId = evRes.rows[0].id;

  let spentCents = 0; // notional API spend attributable to this evaluation

  // Arm 1 — rules (mechanical, no API cost)
  const rules = includeArms.includes('rules')
    ? rulesArm({ features, config: cfg })
    : { state: 'excluded', reason: 'arm not in run', fairProbYes: null, side: null, costCents: null, contracts: 0, stakeCents: 0, feesCents: 0, edge: null, kellyUsed: null };

  // Arm 2 — Jev
  let jevProb = null, jevRaw = null, jevErr = null;
  if (includeArms.includes('jev')) {
    try {
      jevRaw = await callJev(stateString, 'resolve_yes', question);
      jevProb = jevRaw?.answers?.resolve_yes?.noul ?? null;
    } catch (e) { jevErr = String(e.message || e); }
  }
  const jev = jevProb != null
    ? evaluateArm({ fairProbYes: jevProb, features, config: cfg })
    : { state: includeArms.includes('jev') ? 'stand_down' : 'excluded', reason: includeArms.includes('jev') ? (jevErr || 'no judgment') : 'arm not in run', fairProbYes: null, side: null, costCents: null, contracts: 0, stakeCents: 0, feesCents: 0, edge: null, kellyUsed: null };

  // Arm 3 — Claude
  let claudeParsed = null, claudeErr = null;
  if (includeArms.includes('claude')) {
    try {
      const out = await callClaudeFairProb(stateString, question);
      claudeParsed = out.parsed;
      spentCents += usageToCents(out.usage); // count spend even if the parse below failed
      if (!out.parsed) claudeErr = out.parseError || 'unparseable response';
    } catch (e) { claudeErr = String(e.message || e); }
  }
  const claudeProb = claudeParsed?.fair_prob ?? null;
  const claude = claudeProb != null
    ? evaluateArm({ fairProbYes: claudeProb, features, config: cfg })
    : { state: includeArms.includes('claude') ? 'stand_down' : 'excluded', reason: includeArms.includes('claude') ? (claudeErr || 'no judgment') : 'arm not in run', fairProbYes: null, side: null, costCents: null, contracts: 0, stakeCents: 0, feesCents: 0, edge: null, kellyUsed: null };

  const arms = [
    { arm: 'rules', calc: rules, raw: { thresholds: cfg.rules, fair_prob: rules.fairProbYes, reason: rules.reason || null }, fairProb: rules.fairProbYes ?? null },
    { arm: 'jev', calc: jev, raw: jevRaw ?? { error: jevErr }, fairProb: jevProb },
    { arm: 'claude', calc: claude, raw: claudeParsed ?? { error: claudeErr }, fairProb: claudeProb },
  ];

  for (const a of arms) {
    await pool.query(
      `INSERT INTO wager_judgments (event_id, arm, question_id, judgment_type, raw_response, fair_prob) VALUES ($1,$2,$3,$4,$5,$6)`,
      [eventId, a.arm, 'resolve_yes', 'noul', a.raw, a.fairProb]
    );

    // Portfolio stop: an arm can't open a trade that would push its total open
    // stake past the run's bankroll. A hard limit a model can't override.
    let traded = a.calc.state === 'candidate' && a.calc.contracts > 0;
    // The portfolio stop only applies within a real run. Sandbox evaluations
    // (runId == null) are one-off smoke tests that never settle, so summing
    // their open stake would grow without bound and eventually (falsely) report
    // every future sandbox test as "bankroll fully deployed". Quarter-Kelly
    // already caps a single sandbox trade well below the bankroll.
    if (traded && runId != null) {
      const open = await openStakeCents(runId, a.arm);
      if (open + a.calc.stakeCents > cfg.bankroll * 100) {
        traded = false;
        a.calc.state = 'stand_down';
        a.calc.reason = 'bankroll fully deployed';
      }
    }

    await pool.query(
      `INSERT INTO wager_positions (event_id, run_id, arm, decision_state, side, entry_price_cents, contracts, stake_cents, fees_cents, fair_prob, edge, kelly_fraction_used, thresholds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [eventId, runId, a.arm, a.calc.state || 'stand_down', traded ? a.calc.side : (a.calc.side || null), a.calc.costCents ?? null, traded ? a.calc.contracts : 0, traded ? a.calc.stakeCents : 0, traded ? a.calc.feesCents : 0, a.fairProb, a.calc.edge ?? null, a.calc.kellyUsed ?? null, cfg.rules]
    );
    await pool.query(
      `INSERT INTO wager_journal (event_id, arm, snapshot) VALUES ($1,$2,$3)`,
      [eventId, a.arm, { run_id: runId, state_sent: stateString, features, thresholds: cfg.rules, judgment: a.fairProb, raw: a.raw, decision: a.calc }]
    );
  }

  return {
    event_id: eventId,
    run_id: runId,
    features,
    spent_cents: spentCents,
    config: { bankroll: cfg.bankroll, kellyFraction: cfg.kellyFraction, thresholds: cfg.rules },
    arms: arms.map(a => ({ arm: a.arm, fair_prob: a.fairProb, ...a.calc })),
  };
}

// The single active run, or null.
async function getActiveRun() {
  const r = await pool.query(`SELECT * FROM wager_runs WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`);
  return r.rows[0] || null;
}

// Manual entry — a fallback for testing. The machine (the scanner) is the
// primary source of events; this hand-feeds one into the active run (or a
// sandbox eval on defaults if no run is active).
app.post('/api/wager/evaluate', async (req, res) => {
  try {
    const run = await getActiveRun();
    const result = await runWagerEvaluation(req.body || {}, run);
    if (run && result.spent_cents) {
      await pool.query(`UPDATE wager_runs SET spent_cents = spent_cents + $1 WHERE id = $2`, [result.spent_cents, run.id]);
    }
    res.json({ ...result, run: run ? { id: run.id, name: run.name } : null });
  } catch (err) {
    console.error('Wager evaluate error:', err);
    res.status(500).json({ error: 'Evaluation failed', detail: String(err.message || err) });
  }
});

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Neutral, facts-only description of the likely cause of a move. This exact
// text is shared to ALL arms. We pass only the DIRECTION (rose/fell), never a
// price level, so the current price stays withheld.
async function generateNeutralDescription(title, moveDir) {
  const apiKey = process.env.INFERENCE_KEY;
  if (!apiKey) return { text: '', usage: null };
  try {
    const resp = await fetch('https://us.inference.heroku.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: WAGER_MODEL,
        max_tokens: 220,
        system: `You are a neutral wire-service desk. Given a prediction-market question whose implied probability just moved sharply, write 1 to 3 short declarative sentences stating the most likely factual cause, based on recent real-world events. State facts only — NO opinion, NO forecast, NO probability, NO advice, and do NOT mention the market price or betting odds. If the cause is genuinely unclear, say that plainly. Do not speculate about the outcome.`,
        messages: [{ role: 'user', content: `Prediction market: "${title}". Its implied probability ${moveDir} noticeably in the past hour. What most likely happened in the real world?` }],
      }),
    });
    if (!resp.ok) return { text: '', usage: null };
    const data = await resp.json();
    const text = (data.content || []).map(b => b.type === 'text' ? b.text : '').join('').trim();
    return { text, usage: data.usage || null };
  } catch { return { text: '', usage: null }; }
}

// ---- Run lifecycle helpers ----

// Move an active run to 'settling' if a stop condition is met (window ended,
// spend cap hit, or realized loss stop hit). Mutates + returns the run.
async function transitionActiveRunIfNeeded(run) {
  if (!run || run.status !== 'active') return run;
  const reasons = [];
  if (run.entry_deadline) {
    const past = (await pool.query(`SELECT NOW() > $1 AS past`, [run.entry_deadline])).rows[0].past;
    if (past) reasons.push('entry window ended');
  }
  if (run.spend_cap_cents != null && run.spent_cents >= run.spend_cap_cents) reasons.push('spend cap hit');
  if (run.loss_stop_cents != null) {
    const pl = (await pool.query(`SELECT COALESCE(SUM(pnl_cents),0) AS s FROM wager_positions WHERE run_id = $1 AND settled = TRUE`, [run.id])).rows[0].s;
    if (Number(pl) <= -Math.abs(run.loss_stop_cents)) reasons.push('loss stop hit');
  }
  if (reasons.length) {
    await pool.query(`UPDATE wager_runs SET status = 'settling' WHERE id = $1`, [run.id]);
    run.status = 'settling';
    run._transition = reasons;
  }
  return run;
}

// Best-effort auto-settlement: for a run's open positions whose Kalshi market
// has resolved (and whose close time has passed), read the real result and
// settle. Keeps runs able to finish without a human clicking.
async function autoSettleRun(run) {
  const rows = (await pool.query(
    `SELECT DISTINCT e.id, e.external_id FROM wager_events e
       JOIN wager_positions p ON p.event_id = e.id
      WHERE e.run_id = $1 AND e.resolved = FALSE AND p.settled = FALSE AND p.contracts > 0
        AND (e.resolution_date IS NULL OR e.resolution_date <= NOW())`,
    [run.id]
  )).rows;
  for (const r of rows) {
    if (!r.external_id) continue;
    try {
      const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(r.external_id)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const result = data?.market?.result;
      if (result === 'yes' || result === 'no') await settleEvent(r.id, result === 'yes');
    } catch { /* best effort */ }
  }
}

// Build the end-of-run report card data.
async function generateRunReport(runId) {
  const run = (await pool.query(`SELECT * FROM wager_runs WHERE id = $1`, [runId])).rows[0];
  if (!run) return null;
  const arms = (run.settings?.arms) || WAGER.arms;
  const evs = (await pool.query(`SELECT * FROM wager_events WHERE run_id = $1`, [runId])).rows;
  const pos = (await pool.query(`SELECT * FROM wager_positions WHERE run_id = $1 ORDER BY settled_at ASC NULLS LAST, id ASC`, [runId])).rows;
  const eventIds = evs.map(e => e.id);
  const jud = eventIds.length
    ? (await pool.query(`SELECT event_id, arm, fair_prob FROM wager_judgments WHERE event_id = ANY($1)`, [eventIds])).rows
    : [];
  const eventById = Object.fromEntries(evs.map(e => [e.id, e]));

  const s = {};
  for (const a of arms) s[a] = { trades: 0, wins: 0, resolved_bets: 0, pnl_cents: 0, brier_sum: 0, brier_n: 0, dd: 0, _peak: 0, _cum: 0 };

  for (const p of pos) {
    if (!s[p.arm] || p.contracts <= 0) continue;
    s[p.arm].trades++;
    if (p.settled) {
      s[p.arm].resolved_bets++;
      s[p.arm].pnl_cents += p.pnl_cents || 0;
      if ((p.pnl_cents || 0) > 0) s[p.arm].wins++;
      s[p.arm]._cum += p.pnl_cents || 0;
      if (s[p.arm]._cum > s[p.arm]._peak) s[p.arm]._peak = s[p.arm]._cum;
      const dd = s[p.arm]._peak - s[p.arm]._cum;
      if (dd > s[p.arm].dd) s[p.arm].dd = dd;
    }
  }
  for (const j of jud) {
    if (!s[j.arm]) continue;
    const e = eventById[j.event_id];
    if (!e || !e.resolved || j.fair_prob == null) continue;
    const o = e.outcome ? 1 : 0;
    s[j.arm].brier_sum += (Number(j.fair_prob) - o) ** 2;
    s[j.arm].brier_n++;
  }
  let baseSum = 0, baseN = 0;
  for (const e of evs) {
    if (e.resolved && e.current_price_cents != null) { const o = e.outcome ? 1 : 0; baseSum += (e.current_price_cents / 100 - o) ** 2; baseN++; }
  }

  const armReport = {};
  for (const a of arms) {
    armReport[a] = {
      trades: s[a].trades,
      wins: s[a].wins,
      resolved_bets: s[a].resolved_bets,
      pnl_after_fees: +(s[a].pnl_cents / 100).toFixed(2),
      brier: s[a].brier_n > 0 ? +(s[a].brier_sum / s[a].brier_n).toFixed(4) : null,
      brier_n: s[a].brier_n,
      max_drawdown: +(s[a].dd / 100).toFixed(2),
    };
  }

  // Disagreements: events where the included arms didn't all take the same action.
  const posByEvent = {};
  for (const p of pos) (posByEvent[p.event_id] ||= []).push(p);
  const disagreements = [];
  for (const e of evs) {
    const ps = (posByEvent[e.id] || []).filter(p => arms.includes(p.arm));
    const actions = new Set(ps.map(p => p.contracts > 0 ? p.side : 'none'));
    if (actions.size > 1) {
      disagreements.push({
        event_id: e.id, title: e.title, resolved: e.resolved, outcome: e.outcome,
        detail: ps.map(p => `${p.arm}:${p.contracts > 0 ? p.side : p.decision_state}`).join(' · '),
      });
    }
  }

  return {
    duration: run.entry_window,
    events_screened: evs.length,
    total_resolved_bets: arms.reduce((n, a) => n + s[a].resolved_bets, 0),
    market_baseline_brier: baseN > 0 ? +(baseSum / baseN).toFixed(4) : null,
    market_baseline_n: baseN,
    arms: armReport,
    disagreements: disagreements.slice(0, 50),
  };
}

// If a run is done taking entries and has no open positions left, finalize it
// and stamp its report.
async function maybeCompleteRun(runId) {
  const run = (await pool.query(`SELECT * FROM wager_runs WHERE id = $1`, [runId])).rows[0];
  if (!run || run.status === 'complete' || run.status === 'active') return;
  const open = await pool.query(`SELECT 1 FROM wager_positions WHERE run_id = $1 AND settled = FALSE AND contracts > 0 LIMIT 1`, [runId]);
  if (open.rows.length) return; // still waiting on positions to resolve
  const report = await generateRunReport(runId);
  await pool.query(`UPDATE wager_runs SET status = 'complete', report = $1, ended_at = NOW() WHERE id = $2`, [report, runId]);
}

// The scanner: the machine picks the events. Poll Kalshi, snapshot every
// market's price, find markets that moved past the run's screen in ~1 hour
// (looser than the rules arm on purpose), auto-settle & finalize the run, then
// — only while a run is ACTIVE — enter new positions on the biggest movers,
// within the run's daily cap, time-to-resolution filter, and spend cap.
// Intended to be called by Heroku Scheduler every 10 minutes.
app.post('/api/wager/scan', async (req, res) => {
  const secret = process.env.WAGER_CRON_SECRET;
  if (secret && req.get('x-wager-cron') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    let run = await getActiveRun();
    if (run) run = await transitionActiveRunIfNeeded(run);

    // Auto-settle + finalize whichever run is currently open or settling.
    const settleTarget = (run && run.status !== 'complete')
      ? run
      : (await pool.query(`SELECT * FROM wager_runs WHERE status = 'settling' ORDER BY started_at DESC LIMIT 1`)).rows[0];
    if (settleTarget) { await autoSettleRun(settleTarget); await maybeCompleteRun(settleTarget.id); }

    const detect = (run?.settings?.detect) || WAGER.detect;

    const resp = await fetch('https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true');
    if (!resp.ok) return res.status(502).json({ error: 'Kalshi fetch failed' });
    const data = await resp.json();
    const skipCats = ['Sports', 'Sports & Gaming'];

    const markets = [];
    for (const e of (data.events || [])) {
      if (skipCats.includes(e.category)) continue;
      for (const m of (e.markets || [])) {
        if (m.status && m.status !== 'active' && m.status !== 'open') continue;
        // Kalshi migrated its price fields to decimal-dollar `*_dollars` (e.g.
        // 0.09 = 9¢); the old integer-cent `last_price`/`yes_ask` are gone. Read
        // the last trade, falling back to the yes-ask when a market hasn't traded,
        // and convert dollars → integer cents for our accounting.
        const rawDollars = m.last_price_dollars != null ? m.last_price_dollars : m.yes_ask_dollars;
        const priceDollars = Number(rawDollars); // Kalshi returns these as strings ("0.0900")
        if (!Number.isFinite(priceDollars) || priceDollars <= 0) continue;
        const sub = m.yes_sub_title || m.subtitle || '';
        markets.push({
          ticker: m.ticker,
          event_ticker: e.event_ticker || m.event_ticker || e.ticker,
          category: e.category || null,
          title: `${e.title || m.title || ''}${sub ? ' — ' + sub : ''}`.trim(),
          price: Math.round(priceDollars * 100),
          close_time: m.close_time || e.close_time || null,
        });
      }
    }

    // Always snapshot current prices so the hour-ago baseline keeps building.
    for (const m of markets) {
      await pool.query(
        `INSERT INTO wager_price_snapshots (market_ticker, title, price_cents, close_time) VALUES ($1,$2,$3,$4)`,
        [m.ticker, m.title, m.price, m.close_time]
      );
    }

    // Measure EVERY market's move vs. its price ~1 hour ago. We compute a move
    // for all markets, not just the ones that cross the detection threshold, so
    // the related-market baseline below reflects markets that stayed flat too —
    // not just the handful that jumped this scan.
    const scanned = [];
    for (const m of markets) {
      const old = await pool.query(
        `SELECT price_cents FROM wager_price_snapshots WHERE market_ticker = $1 AND ts <= NOW() - INTERVAL '45 minutes' ORDER BY ts DESC LIMIT 1`,
        [m.ticker]
      );
      if (!old.rows.length) continue; // no hour-ago baseline yet (early runs)
      const oldPrice = old.rows[0].price_cents;
      const move = Math.abs(m.price - oldPrice);
      scanned.push({ ...m, oldPrice, move, dir: m.price >= oldPrice ? 'rose' : 'fell' });
    }
    const movers = scanned.filter(m => m.move >= detect.min_move_points);

    // Related-market move: did markets *related* to a mover also move, or was the
    // move idiosyncratic? Scope, tightest first:
    //   1. sibling markets in the same event (e.g. other strikes of one contract),
    //   2. else all scanned markets in the same category,
    //   3. else null — no peer data, so disproportion can't be judged.
    // The median is taken over ALL scanned peers (flat ones included), so a lone
    // jump whose peers held still yields related = 0 ("provably flat") — which is
    // a distinct, fade-worthy signal, NOT the same as null ("we don't know").
    const byEvent = {};
    const byCategory = {};
    for (const m of scanned) {
      (byEvent[m.event_ticker] ||= []).push(m);
      if (m.category) (byCategory[m.category] ||= []).push(m);
    }
    for (const mv of movers) {
      const siblings = (byEvent[mv.event_ticker] || []).filter(s2 => s2.ticker !== mv.ticker);
      if (siblings.length) {
        mv.related = median(siblings.map(s2 => s2.move));
      } else {
        const peers = (byCategory[mv.category] || []).filter(s2 => s2.ticker !== mv.ticker);
        mv.related = peers.length ? median(peers.map(s2 => s2.move)) : null;
      }
    }

    // Entering new positions happens ONLY while a run is active.
    const entering = !!run && run.status === 'active';
    let selected = [], remaining = 0;
    if (entering) {
      const maxTtr = run.max_ttr_hours;
      const eligible = movers.filter(mv => {
        if (maxTtr == null) return true;
        if (!mv.close_time) return false; // unknown resolution → exclude when a cap is set
        const hrs = (new Date(mv.close_time) - new Date()) / 3600000;
        return hrs >= 0 && hrs <= maxTtr;
      });
      const fresh = [];
      for (const mv of eligible) {
        const seen = await pool.query(
          `SELECT 1 FROM wager_events WHERE external_id = $1 AND run_id = $2 AND created_at > NOW() - ($3 || ' hours')::interval LIMIT 1`,
          [mv.ticker, run.id, String(detect.rescan_cooldown_hours)]
        );
        if (!seen.rows.length) fresh.push(mv);
      }
      const todayCount = await pool.query(
        `SELECT COUNT(*)::int AS n FROM wager_events WHERE source = 'scanner' AND run_id = $1 AND created_at >= date_trunc('day', NOW())`,
        [run.id]
      );
      remaining = Math.max(0, detect.max_events_per_day - todayCount.rows[0].n);
      selected = fresh.sort((a, b) => b.move - a.move).slice(0, remaining);
    }

    const results = [];
    for (const mv of selected) {
      // Respect the spend cap mid-loop so a busy news day can't run up a bill.
      if (run.spend_cap_cents != null && run.spent_cents >= run.spend_cap_cents) {
        await pool.query(`UPDATE wager_runs SET status = 'settling' WHERE id = $1`, [run.id]);
        run.status = 'settling';
        break;
      }
      const desc = await generateNeutralDescription(mv.title, mv.dir);
      run.spent_cents += usageToCents(desc.usage);
      try {
        const r = await runWagerEvaluation({
          external_id: mv.ticker, source: 'scanner', instrument_type: 'kalshi',
          title: mv.title, description: desc.text,
          resolution_date: mv.close_time,
          current_price_cents: mv.price, pre_move_price_cents: mv.oldPrice,
          move_points: mv.move, related_move_points: mv.related,
        }, run);
        run.spent_cents += r.spent_cents || 0;
        results.push({ ticker: mv.ticker, move: mv.move, event_id: r.event_id, arms: r.arms.map(a => ({ arm: a.arm, state: a.state, contracts: a.contracts })) });
      } catch (e) {
        results.push({ ticker: mv.ticker, error: String(e.message || e) });
      }
    }
    if (run) await pool.query(`UPDATE wager_runs SET spent_cents = $1 WHERE id = $2`, [run.spent_cents, run.id]);

    // Housekeeping: keep snapshots to ~2 days.
    await pool.query(`DELETE FROM wager_price_snapshots WHERE ts < NOW() - INTERVAL '2 days'`).catch(() => {});

    res.json({
      run: run ? { id: run.id, name: run.name, status: run.status, spent_usd: +(run.spent_cents / 100).toFixed(2) } : null,
      entering,
      scanned_markets: markets.length,
      movers: movers.length,
      selected: selected.length,
      daily_remaining_after: entering ? Math.max(0, remaining - selected.length) : 0,
      results,
    });
  } catch (err) {
    console.error('Wager scan error:', err);
    res.status(500).json({ error: 'scan failed', detail: String(err.message || err) });
  }
});

// Recent evaluations (events + each arm's decision), for the Wager tab.
// Optional ?run_id=N filters to one run.
app.get('/api/wager/positions', async (req, res) => {
  try {
    const runId = req.query.run_id ? parseInt(req.query.run_id, 10) : null;
    const evs = runId
      ? await pool.query(`SELECT * FROM wager_events WHERE run_id = $1 ORDER BY created_at DESC LIMIT 50`, [runId])
      : await pool.query(`SELECT * FROM wager_events ORDER BY created_at DESC LIMIT 50`);
    const ids = evs.rows.map(e => e.id);
    const pos = ids.length
      ? await pool.query(`SELECT * FROM wager_positions WHERE event_id = ANY($1) ORDER BY created_at DESC`, [ids])
      : { rows: [] };
    const byEvent = {};
    for (const p of pos.rows) (byEvent[p.event_id] ||= []).push(p);
    res.json(evs.rows.map(e => ({ ...e, arms: byEvent[e.id] || [] })));
  } catch (err) {
    console.error('Wager positions error:', err);
    res.json([]);
  }
});

// ---- Run management ----

// Create a run. One active run at a time (v1). Settings are frozen at creation.
app.post('/api/wager/runs', async (req, res) => {
  try {
    const active = await getActiveRun();
    if (active) return res.status(409).json({ error: `Run "${active.name}" is still active — stop it before starting another.` });
    const {
      name, entry_window = 'ongoing',
      bankroll = WAGER.bankroll, arms = WAGER.arms,
      max_ttr_hours = null, spend_cap_usd = null, loss_stop_usd = null,
      overrides = {},
    } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!Object.prototype.hasOwnProperty.call(WINDOW_HOURS, entry_window)) return res.status(400).json({ error: 'invalid entry_window' });

    // Freeze settings: defaults merged with any overrides + the chosen arms.
    const settings = {
      version: WAGER.version,
      bankroll,
      arms: Array.isArray(arms) && arms.length ? arms : WAGER.arms,
      kellyFraction: overrides.kellyFraction ?? WAGER.kellyFraction,
      edge_stand_down: overrides.edge_stand_down ?? WAGER.edge_stand_down,
      edge_candidate: overrides.edge_candidate ?? WAGER.edge_candidate,
      detect: { ...WAGER.detect, ...(overrides.detect || {}) },
      rules: { ...WAGER.rules, ...(overrides.rules || {}) },
    };
    const windowHrs = WINDOW_HOURS[entry_window];
    const bankrollCents = Math.round(bankroll * 100);
    const spendCapCents = spend_cap_usd != null ? Math.round(spend_cap_usd * 100) : null;
    const lossStopCents = loss_stop_usd != null ? Math.round(loss_stop_usd * 100) : null;

    let ins;
    if (windowHrs == null) {
      ins = await pool.query(
        `INSERT INTO wager_runs (name, status, entry_window, entry_deadline, bankroll_cents, max_ttr_hours, spend_cap_cents, loss_stop_cents, settings)
         VALUES ($1,'active',$2, NULL, $3,$4,$5,$6,$7) RETURNING *`,
        [name.trim(), entry_window, bankrollCents, max_ttr_hours, spendCapCents, lossStopCents, settings]
      );
    } else {
      ins = await pool.query(
        `INSERT INTO wager_runs (name, status, entry_window, entry_deadline, bankroll_cents, max_ttr_hours, spend_cap_cents, loss_stop_cents, settings)
         VALUES ($1,'active',$2, NOW() + ($3 || ' hours')::interval, $4,$5,$6,$7,$8) RETURNING *`,
        [name.trim(), entry_window, String(windowHrs), bankrollCents, max_ttr_hours, spendCapCents, lossStopCents, settings]
      );
    }
    res.json(ins.rows[0]);
  } catch (err) {
    console.error('Create run error:', err);
    res.status(500).json({ error: 'Failed to create run', detail: String(err.message || err) });
  }
});

// List runs with a live (or, if complete, stored) report card.
app.get('/api/wager/runs', async (req, res) => {
  try {
    const runs = (await pool.query(`SELECT * FROM wager_runs ORDER BY started_at DESC LIMIT 50`)).rows;
    const out = [];
    for (const run of runs) {
      const report = (run.status === 'complete' && run.report) ? run.report : await generateRunReport(run.id);
      out.push({
        id: run.id, name: run.name, status: run.status,
        entry_window: run.entry_window, entry_deadline: run.entry_deadline,
        bankroll: run.bankroll_cents / 100,
        max_ttr_hours: run.max_ttr_hours,
        spend_cap_usd: run.spend_cap_cents != null ? run.spend_cap_cents / 100 : null,
        spent_usd: +(run.spent_cents / 100).toFixed(2),
        loss_stop_usd: run.loss_stop_cents != null ? run.loss_stop_cents / 100 : null,
        started_at: run.started_at, ended_at: run.ended_at,
        settings: run.settings, report,
      });
    }
    res.json(out);
  } catch (err) {
    console.error('List runs error:', err);
    res.json([]);
  }
});

// Manually stop a run: close it to new entries, then finalize if nothing is open.
app.post('/api/wager/runs/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query(`UPDATE wager_runs SET status = 'settling' WHERE id = $1 AND status = 'active'`, [id]);
    await maybeCompleteRun(id);
    const run = (await pool.query(`SELECT status FROM wager_runs WHERE id = $1`, [id])).rows[0];
    res.json({ ok: true, status: run?.status });
  } catch (err) {
    console.error('Stop run error:', err);
    res.json({ ok: false });
  }
});

// Settle an event to its real outcome and compute each open position's P&L.
async function settleEvent(eventId, outcome) {
  await pool.query(`UPDATE wager_events SET resolved = TRUE, outcome = $1, resolved_at = NOW() WHERE id = $2`, [outcome, eventId]);
  const posRes = await pool.query(`SELECT * FROM wager_positions WHERE event_id = $1 AND settled = FALSE`, [eventId]);
  for (const p of posRes.rows) {
    let pnl = 0;
    if (p.contracts > 0) {
      const won = (p.side === 'yes' && outcome) || (p.side === 'no' && !outcome);
      pnl = won
        ? p.contracts * (100 - p.entry_price_cents) - p.fees_cents
        : -(p.contracts * p.entry_price_cents) - p.fees_cents;
    }
    await pool.query(`UPDATE wager_positions SET settled = TRUE, pnl_cents = $1, settled_at = NOW() WHERE id = $2`, [pnl, p.id]);
  }
}

// Manual settlement (click YES/NO on the scoreboard). After settling, if the
// event belongs to a run, try to finalize that run.
app.post('/api/wager/resolve', async (req, res) => {
  const { event_id, outcome } = req.body || {};
  if (!event_id || outcome === undefined) return res.json({ ok: false });
  try {
    await settleEvent(event_id, outcome);
    const ev = (await pool.query(`SELECT run_id FROM wager_events WHERE id = $1`, [event_id])).rows[0];
    if (ev?.run_id) await maybeCompleteRun(ev.run_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Wager resolve error:', err);
    res.json({ ok: false });
  }
});

// Wager scoreboard — per-arm P&L and Brier, plus the pre-move-price baseline
// forecaster. Mirrors /admin/brier's click-to-resolve pattern.
app.get('/admin/wager', async (req, res) => {
  try {
    const evs = (await pool.query(`SELECT * FROM wager_events ORDER BY created_at DESC LIMIT 300`)).rows;
    const pos = (await pool.query(`SELECT * FROM wager_positions`)).rows;
    const jud = (await pool.query(`SELECT event_id, arm, fair_prob FROM wager_judgments`)).rows;

    const eventById = Object.fromEntries(evs.map(e => [e.id, e]));

    // Per-arm P&L (settled positions only)
    const arms = ['rules', 'jev', 'claude'];
    const pnl = Object.fromEntries(arms.map(a => [a, { pnl: 0, trades: 0, wins: 0 }]));
    for (const p of pos) {
      if (p.settled && p.contracts > 0) {
        pnl[p.arm].pnl += p.pnl_cents || 0;
        pnl[p.arm].trades++;
        if ((p.pnl_cents || 0) > 0) pnl[p.arm].wins++;
      }
    }

    // Brier per arm (over resolved events where that arm gave a probability),
    // plus baselines: the pre-move price and the entry (current) price.
    const brier = Object.fromEntries([...arms, 'baseline_premove', 'baseline_market'].map(a => [a, { sum: 0, n: 0 }]));
    for (const j of jud) {
      const e = eventById[j.event_id];
      if (!e || !e.resolved || j.fair_prob == null) continue;
      const o = e.outcome ? 1 : 0;
      brier[j.arm].sum += (Number(j.fair_prob) - o) ** 2;
      brier[j.arm].n++;
    }
    for (const e of evs) {
      if (!e.resolved) continue;
      const o = e.outcome ? 1 : 0;
      if (e.pre_move_price_cents != null) { brier.baseline_premove.sum += (e.pre_move_price_cents / 100 - o) ** 2; brier.baseline_premove.n++; }
      if (e.current_price_cents != null) { brier.baseline_market.sum += (e.current_price_cents / 100 - o) ** 2; brier.baseline_market.n++; }
    }
    const brierVal = a => brier[a].n > 0 ? (brier[a].sum / brier[a].n).toFixed(4) : '—';
    const dollars = c => (c / 100 >= 0 ? '$' : '-$') + Math.abs(c / 100).toFixed(2);

    const scoreRows = arms.map(a =>
      `<tr><td>${a}</td><td>${dollars(pnl[a].pnl)}</td><td>${pnl[a].trades}</td><td>${pnl[a].wins}/${pnl[a].trades}</td><td>${brierVal(a)}</td></tr>`
    ).join('') +
      `<tr style="opacity:0.6"><td>baseline · pre-move price</td><td>—</td><td>—</td><td>—</td><td>${brierVal('baseline_premove')}</td></tr>` +
      `<tr style="opacity:0.6"><td>baseline · market price</td><td>—</td><td>—</td><td>—</td><td>${brierVal('baseline_market')}</td></tr>`;

    const posByEvent = {};
    for (const p of pos) (posByEvent[p.event_id] ||= []).push(p);
    const eventRows = evs.map(e => {
      const summary = (posByEvent[e.id] || []).map(p =>
        `${p.arm}:${p.decision_state}${p.contracts > 0 ? ` ${p.side} x${p.contracts}` : ''}${p.settled && p.contracts > 0 ? ` (${dollars(p.pnl_cents)})` : ''}`
      ).join(' · ');
      const status = e.resolved
        ? (e.outcome ? '<span style="color:#6fa86f">YES</span>' : '<span style="color:#c46a6a">NO</span>')
        : `<button onclick="resolveW(${e.id}, true)" style="background:#2a3a2a;color:#6fa86f;border:1px solid #4a5a4a;padding:2px 8px;cursor:pointer;margin-right:4px;border-radius:3px">YES</button><button onclick="resolveW(${e.id}, false)" style="background:#3a2a2a;color:#c46a6a;border:1px solid #5a4a4a;padding:2px 8px;cursor:pointer;border-radius:3px">NO</button>`;
      return `<tr><td style="max-width:340px;word-wrap:break-word">${(e.title || '').replace(/</g, '&lt;').slice(0, 140)}</td><td style="font-size:11px">${summary}</td><td>${status}</td><td style="font-size:11px;color:rgba(230,215,190,0.4)">${new Date(e.created_at).toLocaleDateString()}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head><title>The Wager — Scoreboard</title>
<style>
  body { background:#1a1410; color:#e6d7be; font-family:'Courier New',monospace; padding:40px; max-width:1000px; margin:0 auto; }
  h1 { font-size:18px; color:#d4a84a; letter-spacing:0.1em; text-transform:uppercase; }
  h2 { font-size:14px; color:#d4a84a; letter-spacing:0.08em; text-transform:uppercase; margin-top:30px; }
  .meta { font-size:12px; color:rgba(230,215,190,0.4); margin-top:8px; }
  table { border-collapse:collapse; width:100%; margin-top:10px; }
  th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.1em; color:rgba(230,215,190,0.4); padding:8px; border-bottom:1px solid rgba(180,150,100,0.2); }
  td { padding:8px; border-bottom:1px solid rgba(180,150,100,0.08); font-size:13px; }
</style>
<script>
async function resolveW(id, outcome){ await fetch('/api/wager/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_id:id,outcome})}); location.reload(); }
</script>
</head><body>
<h1>The Wager — Scoreboard</h1>
<div class="meta">Paper money only · ${WAGER.version} · $${WAGER.bankroll.toLocaleString()} bankroll · quarter-Kelly · thresholds frozen: move≥${WAGER.rules.min_move_points}, ≥${WAGER.rules.min_move_multiple_vs_related}× related, ≥${WAGER.rules.min_days_to_resolution}d, ${WAGER.rules.min_entry_price_cents}–${WAGER.rules.max_entry_price_cents}¢</div>
<div class="meta">Brier: lower is better. The pre-move-price and market-price rows are non-trading baseline forecasters.</div>

<h2>Per-arm results</h2>
<table>
  <tr><th>Arm</th><th>Paper P&amp;L</th><th>Trades</th><th>Wins</th><th>Brier</th></tr>
  ${scoreRows}
</table>

<h2>Events</h2>
<table>
  <tr><th>Event</th><th>Arm decisions</th><th>Outcome</th><th>Logged</th></tr>
  ${eventRows}
</table>
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error('Wager admin error:', err);
    res.status(500).send('Database error');
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tomorrow's Witness running on port ${PORT}`);
});
