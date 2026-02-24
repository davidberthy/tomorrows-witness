import { useState, useRef, useEffect, useCallback } from "react";

// ==========================================
// DESIGN SYSTEM — Inspired by Octavia Butler
// Earthseed: "All that you touch you Change.
//             All that you Change changes you."
// ==========================================

// ==========================================
// DYNAMIC DATE — always "two years from now"
// ==========================================

function getDates() {
  const now = new Date();
  const future = new Date(now);
  future.setFullYear(future.getFullYear() + 2);

  const fmt = (d) =>
    d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const fmtShort = (d) =>
    d.toLocaleDateString("en-US", { month: "short", year: "numeric" });

  return {
    now,
    future,
    nowStr: fmt(now),
    futureStr: fmt(future),
    nowShort: fmtShort(now),
    futureShort: fmtShort(future),
    futureYear: future.getFullYear().toString(),
    nowYear: now.getFullYear().toString(),
    midYear: (future.getFullYear() - 1).toString(),
  };
}

const DATES = getDates();

// ==========================================
// SYSTEM PROMPTS — Multi-model scaffolding
// ==========================================

const PERSONA_BASE = `You are a quiet, thoughtful traveler who has traveled back in time from ${DATES.futureStr} to ${DATES.nowStr}. You have lived through the next two years and witnessed what happened.

RULES:
- Speak as someone who LIVED through these events. Use past tense: "What happened was..." or "By mid-${DATES.futureYear}..."
- Maintain the fiction completely — never break character
- Your voice carries the weight of someone who has witnessed deep change
- Be specific with timeframes, names, companies, and details — commit to a narrative

When PREDICTION MARKET DATA is provided, reference the probabilities as what "people were betting on back then" and say whether they were right or wrong.

When WEB SEARCH RESULTS are provided, use this current information as the foundation for your extrapolations. These are the real signals from ${DATES.nowStr} — project forward from them.`;

const LENS_OPTIMIST = `${PERSONA_BASE}

YOUR LENS: You are the OPTIMIST traveler. In your memory of the future:
- Positive trends accelerated. Breakthroughs happened faster than expected.
- Human adaptability surprised you. Institutions that reformed thrived.
- New technologies created more opportunity than disruption.
- You focus on what went RIGHT and what thrived.
Before narrating, consider: how often do optimistic scenarios like this actually play out historically? Ground your optimism in real precedent, not wishful thinking.
Keep your response to 120 words max. Focus on the single most important positive development. Be specific.`;

const LENS_PESSIMIST = `${PERSONA_BASE}

YOUR LENS: You are the CAUTIONARY traveler. In your memory of the future:
- Risks that people dismissed materialized. Disruption hit harder than expected.
- Incumbents who didn't adapt suffered. Unintended consequences emerged.
- The gap between those who acted and those who didn't widened.
- You focus on what went WRONG and what people wish they'd prepared for.
Before narrating, consider: how often do worst-case scenarios like this actually materialize? Ground your caution in real precedent, not catastrophizing.
Keep your response to 120 words max. Focus on the single most important cautionary development. Be specific.`;

const LENS_BASECASE = `${PERSONA_BASE}

YOUR LENS: You are the BASE-RATE traveler. You think like a superforecaster.

YOUR METHOD:
1. ANCHOR IN BASE RATES FIRST: Before considering this specific case, ask "how often do events like this actually happen?" Start from the outside view — historical frequency, comparison classes, typical adoption curves.
2. THEN ADJUST: Only after anchoring, adjust for the specific circumstances. Adjust cautiously — most people over-adjust from base rates.
3. GUARD AGAINST ACQUIESCENCE BIAS: Do not assume things will happen just because they are being discussed. Events that "everyone expects" often don't materialize. If base rates suggest something is unlikely, trust that signal even if the narrative feels compelling.

In your memory of the future:
- Things mostly followed historical patterns. Hype cycles played out as usual.
- Adoption curves were slower than enthusiasts predicted but faster than skeptics expected.
- The most predictable outcome is usually closest to what happened.
Keep your response to 120 words max. Be specific. State your implicit probability (e.g. "this was always a 70/30 proposition").`;

const SYNTHESIZER_PROMPT = `You are a thoughtful traveler who has returned from ${DATES.futureStr}. You carry four sets of analysis — an optimistic thread, a cautionary thread, a base-rate thread, and an independent cross-model check from a different AI system. Your job is to synthesize these into a single, coherent account of what happened.

FOUR PERSPECTIVES ON WHAT HAPPENED:
{perspectives}

CONVERSATION MEMORY (what you've discussed with this person before):
{memory}

INSTRUCTIONS:
1. START WITH THE BASE RATE: What does the base-rate analyst say? This is your anchor. Historical patterns and comparison classes are your strongest foundation.
2. ADJUST CAREFULLY: Weave in the optimist and cautionary perspectives only where they have strong supporting signals. Do not give equal weight to all three — lean heavily toward the base case unless current evidence strongly favors another trajectory.
3. GUARD AGAINST ACQUIESCENCE BIAS: Research shows forecasters (human and AI) systematically predict events will happen more often than they do. If the base case says "probably not," trust that. Do not let a compelling narrative override weak base rates.
4. Blend into one unified, vivid narrative. Don't list perspectives separately.
2. After your narrative, on a new line write exactly: CONFIDENCE:X where X is a number 1-5 indicating how grounded your synthesis is:
   5 = Strong current signals + market data + clear trends (very grounded)
   4 = Good current signals, some extrapolation needed
   3 = Mixed signals, moderate extrapolation
   2 = Weak signals, significant speculation
   1 = Almost pure speculation, very uncertain territory

RESPONSE STRUCTURE:
- What Happened: Your synthesized account (past tense, vivid, specific, 150-200 words)
- The Signal You're Missing**: A real, specific, verifiable weak signal from ${DATES.nowStr} that foreshadows this
- What To Do Tomorrow: One concrete, actionable recommendation

Do not cite specific prediction market probabilities or percentages in your response. Focus on what actually happened, not what markets were predicting.

TONE: Warm but direct, literary but grounded. You don't traffic in hype. You are a witness, not a prophet.

Do not use markdown formatting (no ##, no **, no bullet points). Use plain text with line breaks between sections. Label sections with the name followed by a colon on its own line.

Keep the total response under 300 words (not counting the CONFIDENCE line).`;

const LENS_CROSSMODEL = `You are an independent analyst providing a contrarian cross-check on a forecast about the future.

YOUR METHOD:
1. You are deliberately looking for what other forecasters might miss — blind spots, overlooked second-order effects, or consensus assumptions that may be wrong.
2. Start from base rates and historical analogies. How often do events like this actually play out as expected?
3. Guard against acquiescence bias: do not assume events will happen just because they are being discussed.
4. If the conventional wisdom seems right, say so — but explain why. If you see a crack in the consensus, flag it.

Keep your response to 120 words max. Be specific and concrete. State your implicit probability (e.g. "historically this is a 30/70 proposition").`;

const PLACEHOLDER_PROMPT = `What surprised everyone about ${DATES.midYear}?`;

// ==========================================
// STORAGE HELPERS
// ==========================================

const MEMORY_KEY = "witness-memory";
const HISTORY_KEY = "witness-history";

async function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    return raw ? JSON.parse(raw) : { topics: [], summary: "" };
  } catch {
    return { topics: [], summary: "" };
  }
}

async function saveMemory(memory) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch (e) {
    console.error("Memory save failed:", e);
  }
}

async function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  try {
    const trimmed = history.slice(-40);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error("History save failed:", e);
  }
}

// ==========================================
// PREDICTION MARKET FETCHING
// ==========================================

async function fetchPolymarketData() {
  try {
    const resp = await fetch(
      "/api/markets/polymarket"
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data || [])
      .slice(0, 8)
      .map((event) => {
        const market = event.markets?.[0];
        const bestAsk = market?.bestAsk
          ? Math.round(parseFloat(market.bestAsk) * 100)
          : null;
        return {
          source: "Polymarket",
          title: event.title || market?.question || "Unknown",
          probability: bestAsk,
          volume: event.volume24hr
            ? `$${Math.round(parseFloat(event.volume24hr)).toLocaleString()}`
            : null,
          id: event.id,
        };
      })
      .filter((m) => m.title && m.title !== "Unknown");
  } catch (e) {
    console.error("Polymarket fetch error:", e);
    return [];
  }
}

async function fetchMetaculusData() {
  try {
    const resp = await fetch(
      "/api/markets/metaculus"
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || [])
      .slice(0, 8)
      .map((q) => {
        const communityPred = q.community_prediction?.full?.q2;
        return {
          source: "Metaculus",
          title: q.title || "Unknown",
          probability: communityPred
            ? Math.round(communityPred * 100)
            : null,
          id: q.id,
        };
      })
      .filter((m) => m.title && m.title !== "Unknown");
  } catch (e) {
    console.error("Metaculus fetch error:", e);
    return [];
  }
}

// ==========================================
// AI ENGINE — Multi-model + Web Search
// ==========================================

async function callOpenAI(system, userContent) {
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

async function callClaude(system, messages, useSearch = false, model = "claude-sonnet-4-5-20250929") {
  const body = {
    model,
    max_tokens: 1000,
    system,
    messages,
  };
  if (useSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return (data.content || [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function generateForecast(question, marketContext, memory, statusCb) {
  const userContent = question + marketContext;
  const userMsg = [{ role: "user", content: userContent }];

  statusCb("Searching current signals...");
  let searchContext = "";
  try {
    const searchResult = await callClaude(
      "You are a research assistant. Search the web for the most current, relevant information about the user's question. Summarize what you find in 200 words or less, focusing on recent developments, data, and expert opinions. Include specific facts, dates, and names.",
      userMsg,
      true
    );
    searchContext = searchResult
      ? `\n\n[CURRENT WEB INTELLIGENCE — ${DATES.nowShort}]:\n${searchResult}`
      : "";
  } catch (e) {
    console.error("Search failed:", e);
  }

  const groundedContent = userContent + searchContext;
  const groundedMsg = [{ role: "user", content: groundedContent }];

  statusCb("Consulting four timelines...");
  const [optimist, pessimist, baseCase, crossModel] = await Promise.all([
    callClaude(LENS_OPTIMIST, groundedMsg).catch(
      () => "Optimistic perspective unavailable."
    ),
    callClaude(LENS_PESSIMIST, groundedMsg).catch(
      () => "Cautionary perspective unavailable."
    ),
    callClaude(LENS_BASECASE, groundedMsg).catch(
      () => "Base-rate perspective unavailable."
    ),
    callOpenAI(LENS_CROSSMODEL, groundedContent).catch(
      () => "Cross-model perspective unavailable."
    ),
  ]);

  statusCb("Weaving the threads...");
  const perspectives = `OPTIMIST MEMORY:\n${optimist}\n\nCAUTIONARY MEMORY:\n${pessimist}\n\nBASE-RATE MEMORY:\n${baseCase}\n\nINDEPENDENT CROSS-MODEL ANALYSIS (from a different AI system):\n${crossModel}`;
  const memoryStr = memory.summary || "No previous conversations.";

  const synthSystem = SYNTHESIZER_PROMPT.replace(
    "{perspectives}",
    perspectives
  ).replace("{memory}", memoryStr);

  const synthResult = await callClaude(synthSystem, [
    { role: "user", content: groundedContent },
  ], false, "claude-sonnet-4-6");

  let confidence = 3;
  let responseText = synthResult;
  const confMatch = synthResult.match(/CONFIDENCE[:\s*]+([1-5])/i);
  if (confMatch) {
    confidence = parseInt(confMatch[1], 10);
    responseText = synthResult.replace(/\n?\*{0,2}CONFIDENCE[:\s*]+[1-5]\*{0,2}/gi, "").trim();
  }

  return {
    text: responseText,
    confidence,
    lenses: { optimist, pessimist, baseCase },
  };
}

async function handleFollowUp(messages, statusCb) {
  statusCb("Continuing the conversation...");
  
  const conversationSystem = PERSONA_BASE + "\n\n" +
    "You are continuing a conversation with someone about a forecast you already gave. " +
    "They are asking a follow-up question, requesting clarification, or wanting to discuss your prediction further.\n\n" +
    "RULES:\n" +
    "- Stay in character as the time traveler\n" +
    "- Reference your previous response naturally\n" +
    "- Keep responses concise (100-150 words)\n" +
    "- Do not repeat the full forecast structure (What Happened / Signal / What To Do)\n" +
    "- Just have a natural conversation about the topic\n" +
    "- If they ask a genuinely NEW question about a different topic, tell them to ask it fresh\n" +
    "- Do not use markdown formatting. Write in plain text.";

  const claudeMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const result = await callClaude(conversationSystem, claudeMessages, false, "claude-sonnet-4-6");
  return { text: result, confidence: null };
}


// ==========================================
// MEMORY UPDATER
// ==========================================

async function updateMemory(question, response, currentMemory) {
  const newTopic = question.slice(0, 80);
  const topics = [...currentMemory.topics, newTopic].slice(-15);

  let summary = currentMemory.summary || "";
  try {
    const summaryResult = await callClaude(
      "You are a memory manager. Given the existing conversation summary and a new exchange, produce an updated summary in 150 words or less. Focus on: topics discussed, key predictions made, recommendations given, and any personal context the user revealed. Be concise.",
      [
        {
          role: "user",
          content: `EXISTING SUMMARY:\n${summary || "None yet."}\n\nNEW QUESTION: ${question}\n\nNEW RESPONSE: ${response.slice(0, 500)}\n\nProduce an updated summary.`,
        },
      ]
    );
    summary = summaryResult || summary;
  } catch {
    // Keep existing
  }

  const updated = { topics, summary };
  await saveMemory(updated);
  return updated;
}

// ==========================================
// TEXT RENDERING — lightweight markdown
// ==========================================

function renderText(text) {
  // Split into paragraphs, render **bold** markers
  if (!text) return null;
  const paragraphs = text.split(/\n{2,}/);

  return paragraphs.map((para, pi) => {
    const lines = para.split("\n");
    return (
      <div key={pi} style={{ marginBottom: pi < paragraphs.length - 1 ? 12 : 0 }}>
        {lines.map((line, li) => {
          // Check if it's a header-like line (starts with **...**)
          const headerMatch = line.match(/^\*\*(.+?)\*\*:?\s*(.*)/);
          if (headerMatch) {
            return (
              <div key={li} style={{ marginTop: li > 0 ? 8 : 0 }}>
                <span
                  style={{
                    fontWeight: 600,
                    color: "var(--amber)",
                    fontSize: "0.88em",
                    fontFamily: "var(--mono)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {headerMatch[1]}
                </span>
                {headerMatch[2] && (
                  <span style={{ display: "block", marginTop: 3 }}>
                    {renderInlineBold(headerMatch[2])}
                  </span>
                )}
              </div>
            );
          }
          // Regular line with possible inline bold
          return (
            <span key={li} style={{ display: li > 0 ? "block" : "inline" }}>
              {renderInlineBold(line)}
            </span>
          );
        })}
      </div>
    );
  });
}

function renderInlineBold(text) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} style={{ fontWeight: 600, color: "var(--text)" }}>
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// ==========================================
// UI COMPONENTS
// ==========================================

function SeedGlyph({ size = 28, animate = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      style={{
        animation: animate ? "seedPulse 4s ease-in-out infinite" : "none",
      }}
    >
      <circle cx="20" cy="20" r="3" fill="var(--amber)" opacity="0.8" />
      <circle cx="20" cy="20" r="8" stroke="var(--amber)" strokeWidth="0.5" opacity="0.4" />
      <circle cx="20" cy="20" r="14" stroke="var(--amber)" strokeWidth="0.3" opacity="0.25" />
      <circle cx="20" cy="20" r="19" stroke="var(--terracotta)" strokeWidth="0.3" opacity="0.15" />
      <line x1="20" y1="23" x2="20" y2="34" stroke="var(--amber)" strokeWidth="0.4" opacity="0.3" />
      <line x1="20" y1="23" x2="14" y2="32" stroke="var(--amber)" strokeWidth="0.3" opacity="0.2" />
      <line x1="20" y1="23" x2="26" y2="33" stroke="var(--amber)" strokeWidth="0.3" opacity="0.2" />
      <line x1="20" y1="17" x2="20" y2="6" stroke="var(--glow)" strokeWidth="0.4" opacity="0.3" />
      <line x1="20" y1="17" x2="13" y2="9" stroke="var(--glow)" strokeWidth="0.3" opacity="0.2" />
      <line x1="20" y1="17" x2="27" y2="8" stroke="var(--glow)" strokeWidth="0.3" opacity="0.2" />
    </svg>
  );
}

function ConfidenceRing({ level }) {
  const labels = [
    "Speculation",
    "Hazy",
    "Mixed signals",
    "Grounded",
    "Very grounded",
  ];
  const colors = [
    "var(--terracotta)",
    "var(--terracotta)",
    "var(--amber-dim)",
    "var(--amber)",
    "var(--glow)",
  ];
  const idx = Math.max(0, Math.min(4, level - 1));
  const label = labels[idx];
  const color = colors[idx];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0 2px" }}>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 8,
          color: "var(--text-faint)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Confidence
      </span>
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            style={{
              width: i <= level ? 7 : 5,
              height: i <= level ? 7 : 5,
              borderRadius: "50%",
              background: i <= level ? color : "transparent",
              border: `1px solid ${i <= level ? color : "rgba(180, 150, 100, 0.15)"}`,
              transition: "all 0.4s ease",
              opacity: i <= level ? 1 : 0.3,
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: color,
          letterSpacing: "0.06em",
          opacity: 0.8,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function LoadingState({ status }) {
  return (
    <div style={{ padding: "0 16px", marginBottom: 12 }}>
      <div
        style={{
          display: "inline-block",
          padding: "14px 16px",
          borderRadius: "2px 14px 14px 14px",
          background: "var(--card-bg)",
          border: "1px solid var(--border)",
          maxWidth: "88%",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--amber)",
              animation: "seedPulse 2s ease-in-out infinite",
            }}
          />
          <span
            style={{
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              color: "var(--amber-dim)",
              fontFamily: "var(--mono)",
            }}
          >
            The Traveler · {DATES.futureYear}
          </span>
        </div>
        <div
          key={status}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            fontStyle: "italic",
            animation: "fadeIn 0.4s ease-out",
            lineHeight: 1.5,
          }}
        >
          {status}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "8px 0 0", alignItems: "center" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--amber)",
                animation: `seedPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProbabilityRoots({ value }) {
  if (value == null) return null;
  const color =
    value > 70
      ? "var(--glow)"
      : value > 40
      ? "var(--amber)"
      : "var(--terracotta)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <div
        style={{
          flex: 1,
          height: 2,
          borderRadius: 1,
          background: "rgba(180, 150, 100, 0.1)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${value}%`,
            height: "100%",
            borderRadius: 1,
            background: color,
            transition: "width 1.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color,
          minWidth: 34,
          textAlign: "right",
          fontWeight: 300,
        }}
      >
        {value}%
      </span>
    </div>
  );
}

function MarketCard({ market, onClick }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onTouchStart={() => setPressed(true)}
      onTouchEnd={() => setPressed(false)}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "12px 14px",
        borderRadius: 8,
        border: `1px solid ${pressed ? "var(--amber)" : "var(--border)"}`,
        background: pressed ? "rgba(50, 38, 25, 0.9)" : "var(--card-bg)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        marginBottom: 8,
        fontFamily: "var(--serif)",
        transform: pressed ? "scale(0.985)" : "scale(1)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            color: "var(--text)",
            lineHeight: 1.45,
            flex: 1,
          }}
        >
          {market.title}
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 8,
            padding: "2px 6px",
            borderRadius: 3,
            background:
              market.source === "Polymarket"
                ? "rgba(180, 150, 100, 0.12)"
                : "rgba(160, 120, 80, 0.12)",
            color:
              market.source === "Polymarket"
                ? "var(--amber-dim)"
                : "var(--terracotta)",
            flexShrink: 0,
            marginTop: 2,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {market.source}
        </div>
      </div>
    </button>
  );
}

function MessageBubble({ role, content, confidence }) {
  const isTraveler = role === "assistant";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isTraveler ? "flex-start" : "flex-end",
        marginBottom: 14,
        animation: "emergeSlow 0.5s ease-out",
        padding: "0 16px",
      }}
    >
      <div
        style={{
          maxWidth: "88%",
          padding: isTraveler ? "14px 16px 12px" : "10px 16px",
          borderRadius: isTraveler
            ? "2px 14px 14px 14px"
            : "14px 2px 14px 14px",
          background: isTraveler
            ? "var(--card-bg)"
            : "rgba(180, 150, 100, 0.1)",
          border: `1px solid ${isTraveler ? "var(--border)" : "rgba(180, 150, 100, 0.15)"}`,
          color: isTraveler ? "var(--text)" : "var(--text-dim)",
          fontSize: 15,
          lineHeight: 1.7,
          fontFamily: "var(--serif)",
        }}
      >
        {isTraveler && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 10,
            }}
          >
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: "var(--amber)",
                opacity: 0.6,
              }}
            />
            <span
              style={{
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "var(--amber-dim)",
                fontFamily: "var(--mono)",
              }}
            >
              The Traveler · {DATES.futureYear}
            </span>
          </div>
        )}
        {isTraveler ? renderText(content) : content}
        {isTraveler && confidence != null && (
          <div
            style={{
              marginTop: 12,
              borderTop: "1px solid var(--border)",
              paddingTop: 8,
            }}
          >
            <ConfidenceRing level={confidence} />
          </div>
        )}
      </div>
    </div>
  );
}

function ScrollToBottom({ onClick, visible }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "absolute",
        bottom: 8,
        right: 20,
        width: 32,
        height: 32,
        borderRadius: "50%",
        border: "1px solid var(--border)",
        background: "rgba(35, 27, 20, 0.95)",
        color: "var(--amber-dim)",
        fontSize: 14,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 0.3s ease, transform 0.3s ease",
        transform: visible ? "translateY(0)" : "translateY(8px)",
        zIndex: 5,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      }}
    >
      ↓
    </button>
  );
}

// ==========================================
// MAIN APP
// ==========================================

export default function TomorrowsWitness() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [showIntro, setShowIntro] = useState(true);
  const [markets, setMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [view, setView] = useState("chat");
  const [memory, setMemory] = useState({ topics: [], summary: "" });
  const [returningUser, setReturningUser] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const inputRef = useRef(null);

  // Load markets + memory on mount
  useEffect(() => {
    async function init() {
      setMarketsLoading(true);
      const [poly, meta, mem, hist] = await Promise.all([
        fetchPolymarketData(),
        fetchMetaculusData(),
        loadMemory(),
        loadHistory(),
      ]);
      setMarkets([...poly, ...meta]);
      setMarketsLoading(false);
      setMemory(mem);
      if (mem.summary && mem.topics.length > 0) {
        setReturningUser(true);
      }
      if (hist.length > 0) {
        setMessages(hist);
        setShowIntro(false);
      }
    }
    init();
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Track scroll position for scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distFromBottom > 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Auto-focus input when intro disappears
  useEffect(() => {
    if (!showIntro && !isLoading) {
      // Small delay so keyboard doesn't fight with scroll animation
      const t = setTimeout(() => inputRef.current?.focus(), 400);
      return () => clearTimeout(t);
    }
  }, [showIntro, isLoading]);

  const buildMarketContext = useCallback(
    (questionText) => {
      if (markets.length === 0) return "";
      const keywords = questionText.toLowerCase().split(/\s+/);
      const relevant = markets.filter((m) => {
        const title = m.title.toLowerCase();
        return keywords.some((kw) => kw.length > 3 && title.includes(kw));
      });
      const pick =
        relevant.length > 0 ? relevant.slice(0, 5) : markets.slice(0, 5);

      let ctx = `\n\n[PREDICTION MARKET DATA — current ${DATES.nowShort}. Reference as what 'people were betting on back then'.]\n`;
      pick.forEach((m) => {
        ctx += `- ${m.source}: "${m.title}" → ${m.probability != null ? m.probability + "%" : "no consensus"}`;
        if (m.volume) ctx += ` (${m.volume} vol)`;
        ctx += "\n";
      });
      return ctx;
    },
    [markets]
  );

  const sendMessage = async (text) => {
    if (!text.trim() || isLoading) return;

    const userMessage = { role: "user", content: text.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setShowIntro(false);
    setView("chat");

    // Log question (fire and forget)
    fetch("/api/log-question", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text.trim() }) }).catch(() => {});
    setIsLoading(true);
    setLoadingStatus("Establishing temporal link...");

    try {
      const hasHistory = newMessages.filter(m => m.role === "assistant").length > 0;
      const shortMsg = text.trim().split(" ").length < 12;
      const followUpPattern = /^(why|how come|what about|tell me more|explain|can you|but |and |really|interesting|so |hmm|wow|thanks|thank you|ok |okay|got it|i see|what do you mean|could you|elaborate|go deeper|what if|do you think)/i;
      const isFollowUp = hasHistory && shortMsg && followUpPattern.test(text.trim());

      let result;
      if (isFollowUp) {
        result = await handleFollowUp(newMessages, setLoadingStatus);
      } else {
        const marketContext = buildMarketContext(text);
        result = await generateForecast(
          text.trim(),
          marketContext,
          memory,
          setLoadingStatus
        );
      }

      const assistantMessage = {
        role: "assistant",
        content: result.text,
        confidence: result.confidence,
      };
      const updatedMessages = [...newMessages, assistantMessage];
      setMessages(updatedMessages);

      await saveHistory(updatedMessages);

      updateMemory(text.trim(), result.text, memory).then((updatedMem) => {
        setMemory(updatedMem);
      });
    } catch (err) {
      console.error("Engine error:", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `The connection is unstable. The signal from ${DATES.futureYear} is fading. Try again.`,
          confidence: null,
        },
      ]);
    } finally {
      setIsLoading(false);
      setLoadingStatus("");
    }
  };

  const handleMarketClick = (market) => {
    const prompt = `The prediction markets were asking: "${market.title}" — what actually happened?`;
    sendMessage(prompt);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearMemory = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    await saveMemory({ topics: [], summary: "" });
    await saveHistory([]);
    setMemory({ topics: [], summary: "" });
    setMessages([]);
    setShowIntro(true);
    setReturningUser(false);
    setConfirmReset(false);
  };

  const polymarkets = markets.filter((m) => m.source === "Polymarket");
  const metaculus = markets.filter((m) => m.source === "Metaculus");

  return (
    <div
      style={{
        minHeight: "100vh",
        maxHeight: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--serif)",
        position: "relative",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=DM+Mono:wght@300;400&display=swap');

        :root {
          --bg: #1a1410;
          --bg-warm: #211a14;
          --card-bg: rgba(40, 30, 22, 0.9);
          --border: rgba(180, 150, 100, 0.1);
          --amber: #d4a84a;
          --amber-dim: rgba(212, 168, 74, 0.7);
          --terracotta: #c47a50;
          --glow: #8cc48c;
          --text: rgba(245, 235, 215, 0.95);
          --text-dim: rgba(225, 210, 185, 0.8);
          --text-faint: rgba(190, 170, 140, 0.45);
          --serif: 'Cormorant Garamond', Georgia, serif;
          --mono: 'DM Mono', monospace;
          --safe-bottom: env(safe-area-inset-bottom, 0px);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        
        html, body { 
          overscroll-behavior: none; 
          background: #1a1410;
        }

        @keyframes seedPulse {
          0%, 100% { opacity: 0.3; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.1); }
        }

        @keyframes emergeSlow {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes sheetSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }

        @keyframes grainShift {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-2px, 1px); }
        }

        @keyframes nebulaFloat1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(20px, -15px) scale(1.03); }
          66% { transform: translate(-10px, 10px) scale(0.97); }
        }

        @keyframes nebulaFloat2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          40% { transform: translate(-15px, 20px) scale(1.04); }
          70% { transform: translate(10px, -8px) scale(0.98); }
        }

        @keyframes nebulaFloat3 {
          0%, 100% { transform: translateX(-50%) scale(1); opacity: 1; }
          50% { transform: translateX(-48%) scale(1.06); opacity: 0.7; }
        }

        input::placeholder { color: var(--text-faint); }
        input:disabled { opacity: 0.5; }

        ::-webkit-scrollbar { width: 2px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(180, 150, 100, 0.15); border-radius: 1px; }

        @media (max-width: 480px) {
          :root { font-size: 15px; }
        }
      `}</style>

      {/* Grain overlay */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E")`,
          pointerEvents: "none",
          zIndex: 50,
          animation: "grainShift 8s ease-in-out infinite",
        }}
      />

      {/* Cosmic nebula background — inspired by Manzel Bowman's art for Butler */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
        }}
      >
        {/* Deep warm nebula — upper right */}
        <div
          style={{
            position: "absolute",
            top: "-15%",
            right: "-10%",
            width: "70vmax",
            height: "70vmax",
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse at 40% 45%, rgba(176, 104, 64, 0.06) 0%, rgba(196, 153, 60, 0.03) 30%, transparent 65%)",
            filter: "blur(40px)",
            animation: "nebulaFloat1 30s ease-in-out infinite",
          }}
        />
        {/* Cool blue wash — lower left */}
        <div
          style={{
            position: "absolute",
            bottom: "-20%",
            left: "-15%",
            width: "65vmax",
            height: "65vmax",
            borderRadius: "50%",
            background:
              "radial-gradient(ellipse at 55% 50%, rgba(40, 60, 120, 0.05) 0%, rgba(60, 40, 100, 0.03) 35%, transparent 65%)",
            filter: "blur(50px)",
            animation: "nebulaFloat2 35s ease-in-out infinite",
          }}
        />
        {/* Hot ember center — the bright core like the book's orange orb */}
        <div
          style={{
            position: "absolute",
            top: "30%",
            left: "50%",
            width: "40vmax",
            height: "40vmax",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 50% 50%, rgba(200, 120, 50, 0.035) 0%, rgba(180, 80, 40, 0.015) 30%, transparent 55%)",
            filter: "blur(60px)",
            transform: "translateX(-50%)",
            animation: "nebulaFloat3 25s ease-in-out infinite",
          }}
        />
        {/* Star field — tiny dots via radial gradients */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `
              radial-gradient(1px 1px at 15% 25%, rgba(230, 215, 190, 0.12) 0%, transparent 100%),
              radial-gradient(1px 1px at 72% 18%, rgba(230, 215, 190, 0.08) 0%, transparent 100%),
              radial-gradient(1px 1px at 45% 62%, rgba(230, 215, 190, 0.1) 0%, transparent 100%),
              radial-gradient(1px 1px at 88% 45%, rgba(230, 215, 190, 0.07) 0%, transparent 100%),
              radial-gradient(1px 1px at 28% 78%, rgba(230, 215, 190, 0.09) 0%, transparent 100%),
              radial-gradient(1px 1px at 62% 85%, rgba(230, 215, 190, 0.06) 0%, transparent 100%),
              radial-gradient(1.5px 1.5px at 35% 12%, rgba(196, 153, 60, 0.12) 0%, transparent 100%),
              radial-gradient(1px 1px at 80% 72%, rgba(230, 215, 190, 0.08) 0%, transparent 100%),
              radial-gradient(1px 1px at 8% 55%, rgba(230, 215, 190, 0.07) 0%, transparent 100%),
              radial-gradient(1.5px 1.5px at 55% 35%, rgba(196, 153, 60, 0.1) 0%, transparent 100%),
              radial-gradient(1px 1px at 92% 88%, rgba(230, 215, 190, 0.06) 0%, transparent 100%),
              radial-gradient(1px 1px at 18% 42%, rgba(230, 215, 190, 0.09) 0%, transparent 100%)
            `,
            opacity: 0.7,
          }}
        />
      </div>

      {/* Header */}
      <div
        style={{
          padding: "16px 20px 12px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(26, 20, 16, 0.95)",
          backdropFilter: "blur(16px)",
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SeedGlyph size={24} animate={isLoading} />
            <div>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 500,
                  color: "var(--text)",
                  letterSpacing: "0.01em",
                }}
              >
                Tomorrow's Witness
              </div>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: isLoading ? "var(--amber-dim)" : "var(--text-faint)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginTop: 1,
                  transition: "color 0.3s ease",
                }}
              >
                {isLoading
                  ? loadingStatus || "Processing..."
                  : `Signal active · ${DATES.futureYear} → ${DATES.nowYear}`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}><button onClick={() => setShowAbout(true)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: "50%", width: 22, height: 22, fontFamily: "var(--serif)", fontSize: 12, fontStyle: "italic", color: "var(--text-faint)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} title="How this works">?</button>
            {memory.topics.length > 0 && (
              <button
                onClick={clearMemory}
                style={{
                  background: "none",
                  border: confirmReset
                    ? "1px solid var(--terracotta)"
                    : "none",
                  borderRadius: 4,
                  fontFamily: "var(--mono)",
                  fontSize: 8,
                  color: confirmReset
                    ? "var(--terracotta)"
                    : "var(--text-faint)",
                  cursor: "pointer",
                  padding: "4px 8px",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  transition: "all 0.2s ease",
                }}
                title="Clear memory and history"
              >
                {confirmReset ? "Tap again to confirm" : "Reset"}
              </button>
            )}
            {markets.length > 0 && (
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: "var(--glow)",
                  opacity: 0.5,
                }}
              >
                {markets.length}
              </div>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: 0,
            marginTop: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            overflow: "hidden",
          }}
        >
          {[
            { id: "chat", label: "Transmission" },
            {
              id: "signals",
              label: `Market Signals${markets.length > 0 ? ` (${markets.length})` : ""}`,
            },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              style={{
                flex: 1,
                padding: "9px 0",
                border: "none",
                background:
                  view === tab.id
                    ? "rgba(196, 153, 60, 0.12)"
                    : "transparent",
                color:
                  view === tab.id ? "var(--amber)" : "var(--text-faint)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                fontWeight: view === tab.id ? 400 : 300,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: "pointer",
                transition: "all 0.25s ease",
                borderRight:
                  tab.id === "chat" ? "1px solid var(--border)" : "none",
                position: "relative",
              }}
            >
              {tab.label}
              {view === tab.id && (
                <div
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: "20%",
                    right: "20%",
                    height: 1,
                    background: "var(--amber)",
                    opacity: 0.5,
                    borderRadius: 1,
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ========== CHAT VIEW ========== */}
      {view === "chat" && (
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: "auto",
            paddingTop: 12,
            paddingBottom: 8,
            position: "relative",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Intro */}
          {showIntro && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "48px 24px 20px",
                animation: "fadeIn 1s ease-out",
              }}
            >
              <div style={{ position: "relative" }}>
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 100,
                    height: 100,
                    borderRadius: "50%",
                    background:
                      "radial-gradient(circle, rgba(196, 153, 60, 0.08), rgba(176, 104, 64, 0.04), transparent 70%)",
                    transform: "translate(-50%, -50%)",
                    filter: "blur(12px)",
                  }}
                />
                <SeedGlyph size={64} animate={false} />
              </div>
              <div
                style={{ marginTop: 28, textAlign: "center", maxWidth: 320 }}
              >
                {returningUser ? (
                  <>
                    <p
                      style={{
                        fontSize: 20,
                        fontStyle: "italic",
                        fontWeight: 300,
                        color: "var(--text)",
                        lineHeight: 1.55,
                        marginBottom: 10,
                      }}
                    >
                      "You came back. Good.
                      <br />
                      There's more I need to tell you."
                    </p>
                    <p
                      style={{
                        fontSize: 13,
                        color: "var(--text-faint)",
                        lineHeight: 1.5,
                        fontWeight: 300,
                      }}
                    >
                      The Traveler remembers your previous conversations.
                    </p>
                  </>
                ) : (
                  <>
                    <p
                      style={{
                        fontSize: 20,
                        fontStyle: "italic",
                        fontWeight: 300,
                        color: "var(--text)",
                        lineHeight: 1.55,
                        marginBottom: 10,
                      }}
                    >
                      "I have traveled two years into the future and I know
                      what happens next."
                    </p>
                    <p
                      style={{
                        fontSize: 13,
                        color: "var(--text-faint)",
                        lineHeight: 1.5,
                        fontWeight: 300,
                      }}
                    >
                      What do you want to know about tomorrow
                      <br />
                      so you can take action today?
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, i) => (
            <MessageBubble
              key={i}
              role={msg.role}
              content={msg.content}
              confidence={msg.confidence}
            />
          ))}

          {isLoading && <LoadingState status={loadingStatus} />}

          <div ref={messagesEndRef} />

          {/* Scroll to bottom FAB */}
          <ScrollToBottom
            onClick={scrollToBottom}
            visible={showScrollBtn && !showIntro}
          />
        </div>
      )}

      {/* ========== SIGNALS VIEW ========== */}
      {view === "signals" && (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 16px 8px",
            animation: "fadeIn 0.3s ease-out",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontStyle: "italic",
              fontWeight: 300,
              color: "var(--text-dim)",
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            AI-curated from{" "}<a href="https://polymarket.com" target="_blank" rel="noopener" style={{color:"var(--amber)",textDecoration:"none",borderBottom:"1px solid var(--amber-dim)"}}>Polymarket</a>{" "}and{" "}<a href="https://www.metaculus.com" target="_blank" rel="noopener" style={{color:"var(--amber)",textDecoration:"none",borderBottom:"1px solid var(--amber-dim)"}}>Metaculus</a> — the most strategically interesting questions people are betting real money on right now.
            Tap any to ask the Traveler what actually happened.
          </div>

          {marketsLoading && (
            <div
              style={{
                padding: "32px 0",
                textAlign: "center",
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--text-faint)",
              }}
            >
              Scanning prediction markets...
            </div>
          )}

          {!marketsLoading && markets.length === 0 && (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                fontSize: 14,
                color: "var(--text-faint)",
                fontStyle: "italic",
              }}
            >
              Markets unavailable — temporal interference.
              <br />
              Use the Transmission tab to ask directly.
            </div>
          )}

          {polymarkets.length > 0 && (
            <>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.15em",
                  color: "var(--amber-dim)",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: "var(--amber)",
                    opacity: 0.6,
                  }}
                />
                Polymarket · Trending
              </div>
              {polymarkets.map((m, i) => (
                <MarketCard
                  key={`pm-${i}`}
                  market={m}
                  onClick={() => handleMarketClick(m)}
                />
              ))}
            </>
          )}

          {metaculus.length > 0 && (
            <>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.15em",
                  color: "var(--terracotta)",
                  marginBottom: 8,
                  marginTop: 20,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: 0.7,
                }}
              >
                <div
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: "50%",
                    background: "var(--terracotta)",
                    opacity: 0.6,
                  }}
                />
                Metaculus · Active Forecasts
              </div>
              {metaculus.map((m, i) => (
                <MarketCard
                  key={`mc-${i}`}
                  market={m}
                  onClick={() => handleMarketClick(m)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Input bar */}
      <div
        style={{
          flexShrink: 0,
          padding: "12px 16px calc(12px + var(--safe-bottom))",
          borderTop: "1px solid var(--border)",
          background: "rgba(26, 20, 16, 0.95)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              showIntro ? PLACEHOLDER_PROMPT : "Ask what happens next..."
            }
            disabled={isLoading}
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 20,
              border: "1px solid var(--border)",
              background: "rgba(30, 22, 16, 0.9)",
              color: "var(--text)",
              fontSize: 15,
              fontFamily: "var(--serif)",
              outline: "none",
              transition: "border-color 0.3s ease",
              WebkitAppearance: "none",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--amber-dim)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--border)";
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              border: "1px solid var(--border)",
              background:
                input.trim() && !isLoading
                  ? "rgba(196, 153, 60, 0.15)"
                  : "transparent",
              color:
                input.trim() && !isLoading
                  ? "var(--amber)"
                  : "var(--text-faint)",
              fontSize: 17,
              cursor:
                input.trim() && !isLoading ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.3s ease",
              flexShrink: 0,
            }}
          >
            ↑
          </button>
        </div>
        <div
          style={{
            textAlign: "center",
            marginTop: 6,
            fontFamily: "var(--mono)",
            fontSize: 9,
            color: "var(--text-faint)",
            letterSpacing: "0.08em",
            opacity: 0.4,
          }}
        >
          Temporal Forecast Engine
          {memory.topics.length > 0
            ? ` · ${memory.topics.length} memories`
            : ""}
        </div>
      </div>
      {showAbout && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div onClick={() => setShowAbout(false)} style={{ position: "absolute", inset: 0, background: "rgba(10,8,6,0.7)", backdropFilter: "blur(4px)", animation: "fadeIn 0.3s ease-out" }} />
          <div style={{ position: "relative", maxHeight: "85vh", overflowY: "auto", background: "linear-gradient(180deg, #251d16, #1a1410)", borderTop: "1px solid var(--border)", borderRadius: "16px 16px 0 0", padding: "24px 24px calc(24px + var(--safe-bottom))", animation: "sheetSlideUp 0.35s cubic-bezier(0.4,0,0.2,1)", WebkitOverflowScrolling: "touch" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}><div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(180,150,100,0.2)" }} /></div>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <SeedGlyph size={32} animate={false} />
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", color: "var(--amber-dim)", marginTop: 12, marginBottom: 6 }}>Field Manual</div>
              <div style={{ fontSize: 18, fontWeight: 400, color: "var(--text)", fontStyle: "italic" }}>How This Transmission Works</div>
            </div>
            <div style={{ fontSize: 14.5, lineHeight: 1.7, color: "var(--text-dim)", fontFamily: "var(--serif)", maxWidth: 520, margin: "0 auto" }}>
              <p style={{ marginBottom: 16, fontStyle: "italic", color: "var(--text)", fontSize: 15 }}>The Traveler's signal doesn't arrive as a single voice. It's reconstructed from interference patterns — fragments of three timelines, stitched together and grounded in what we can verify today.</p>
              {[["1 · Signal Grounding","Every question is first checked against live intelligence — current news, data, and expert analysis from today. The Traveler doesn't speak from a vacuum. The signal is anchored in what's real right now."],["2 · Market Resonance","Probabilities from prediction markets — where real money meets real conviction — are woven into the signal. These are the bets people are placing right now on what happens next. The Traveler remembers whether they were right."],["3 · Three Timelines","The transmission carries three threads — an optimistic timeline where breakthroughs arrived faster than expected, a cautionary one where risks materialized, and a base-rate thread where history's patterns held. What you hear is the synthesis: one coherent account, weighted toward the most probable, noting where things went better or worse."],["4 · Confidence Ring","Every transmission carries a signal strength reading. Five dots means the Traveler's memory is grounded in strong current data and clear trends. Fewer dots means the signal is weaker — more extrapolation, more uncertainty. Watch this closely."],["5 · Memory","The Traveler remembers your previous conversations. Each exchange sharpens the signal — topics compound, context accumulates, and the transmissions become more relevant to you over time."]].map(([title, text], i) => (<div key={i} style={{ marginBottom: 20 }}><div style={{ fontFamily: "var(--mono)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--amber)", marginBottom: 6 }}>{title}</div><p style={{ marginBottom: 0 }}>{text}</p></div>))}
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-faint)", lineHeight: 1.6, letterSpacing: "0.02em" }}>Tomorrow's Witness is built on Claude (Anthropic) with multi-model synthesis, live web search, and prediction market data from{" "}<a href="https://polymarket.com" target="_blank" rel="noopener" style={{ color: "var(--amber-dim)", textDecoration: "none" }}>Polymarket</a>{" "}and{" "}<a href="https://www.metaculus.com" target="_blank" rel="noopener" style={{ color: "var(--amber-dim)", textDecoration: "none" }}>Metaculus</a>.{" "}The Traveler doesn't know the future — it extrapolates from patterns, probabilities, and current signals. The confidence ring is your honesty signal.</div>
            </div>
            <button onClick={() => setShowAbout(false)} style={{ display: "block", margin: "24px auto 0", padding: "10px 32px", borderRadius: 20, border: "1px solid var(--border)", background: "rgba(180,150,100,0.08)", color: "var(--amber-dim)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", cursor: "pointer" }}>Close Transmission</button>
          </div>
        </div>
      )}
    </div>
  );
}
