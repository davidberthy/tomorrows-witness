import re

# ==========================================
# 1. UPDATE SERVER.JS — Add OpenAI proxy endpoint
# ==========================================
with open("server.js", "r") as f:
    server = f.read()

openai_endpoint = """
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

"""

# Insert before CURATED MARKET SIGNALS section
server = server.replace(
    "// ==========================================\n// CURATED MARKET SIGNALS",
    openai_endpoint + "// ==========================================\n// CURATED MARKET SIGNALS"
)

with open("server.js", "w") as f:
    f.write(server)

print("1/3 Done - OpenAI endpoint added to server.js")

# ==========================================
# 2. UPDATE App.jsx — Add callOpenAI, LENS_CROSSMODEL, wire into pipeline
# ==========================================
with open("src/App.jsx", "r") as f:
    app = f.read()

# 2a. Add LENS_CROSSMODEL prompt after the PLACEHOLDER_PROMPT line
crossmodel_prompt = '''const LENS_CROSSMODEL = `You are an independent analyst providing a contrarian cross-check on a forecast about the future.

YOUR METHOD:
1. You are deliberately looking for what other forecasters might miss — blind spots, overlooked second-order effects, or consensus assumptions that may be wrong.
2. Start from base rates and historical analogies. How often do events like this actually play out as expected?
3. Guard against acquiescence bias: do not assume events will happen just because they are being discussed.
4. If the conventional wisdom seems right, say so — but explain why. If you see a crack in the consensus, flag it.

Keep your response to 120 words max. Be specific and concrete. State your implicit probability (e.g. "historically this is a 30/70 proposition").`;

'''

app = app.replace(
    "const PLACEHOLDER_PROMPT",
    crossmodel_prompt + "const PLACEHOLDER_PROMPT"
)

# 2b. Add callOpenAI function before callClaude
openai_function = '''async function callOpenAI(system, userContent) {
  try {
    const response = await fetch("/api/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    const data = await response.json();
    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content;
    }
    return "Cross-model perspective unavailable.";
  } catch (err) {
    console.error("OpenAI error:", err);
    return "Cross-model perspective unavailable.";
  }
}

'''

app = app.replace(
    "async function callClaude(",
    openai_function + "async function callClaude("
)

# 2c. Add 4th lens to parallel calls and update destructuring
app = app.replace(
    "const [optimist, pessimist, baseCase] = await Promise.all([",
    "const [optimist, pessimist, baseCase, crossModel] = await Promise.all(["
)

app = app.replace(
    '''    callClaude(LENS_BASECASE, groundedMsg).catch(
      () => "Base-rate perspective unavailable."
    ),
  ]);''',
    '''    callClaude(LENS_BASECASE, groundedMsg).catch(
      () => "Base-rate perspective unavailable."
    ),
    callOpenAI(LENS_CROSSMODEL, groundedContent).catch(
      () => "Cross-model perspective unavailable."
    ),
  ]);'''
)

# 2d. Update perspectives string to include 4th
app = app.replace(
    'const perspectives = `OPTIMIST MEMORY:\\n${optimist}\\n\\nCAUTIONARY MEMORY:\\n${pessimist}\\n\\nBASE-RATE MEMORY:\\n${baseCase}`;',
    'const perspectives = `OPTIMIST MEMORY:\\n${optimist}\\n\\nCAUTIONARY MEMORY:\\n${pessimist}\\n\\nBASE-RATE MEMORY:\\n${baseCase}\\n\\nINDEPENDENT CROSS-MODEL ANALYSIS (from a different AI system):\\n${crossModel}`;'
)

# 2e. Update status message
app = app.replace(
    'statusCb("Consulting three timelines...");',
    'statusCb("Consulting four timelines...");'
)

with open("src/App.jsx", "w") as f:
    f.write(app)

print("2/3 Done - Cross-model lens added to App.jsx")
print("3/3 All done! Run: npx vite build && git add . && git commit -m 'Add GPT-4o-mini cross-model lens' && git push heroku main")
