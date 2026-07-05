/* ============================================================================
 * AI CONCIERGE — floating chat widget (shared)
 *
 * Loaded by the hub (index.html) and every signed-in /tools/*.html page so
 * the launcher follows the user wherever they go.
 *
 * What this file does:
 *   1. Injects the launcher button + chat panel into <body>.
 *   2. Wires up open/close + Esc + Enter-to-send + auto-grow textarea.
 *   3. Persists the conversation to sessionStorage so it survives reloads
 *      and "come back from a tool".
 *   4. Talks to the Supabase Edge Function `ai-concierge` (which proxies to
 *      Groq). Supports STREAMING — assistant text appears as it generates.
 *   5. Executes 9 navigation/lookup actions client-side on tool_calls.
 *   6. Surfaces errors with a one-click RETRY button on the error bubble.
 *
 * Loading order on every page that uses this:
 *   <link rel="stylesheet" href="<base>/shared/concierge.css">
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="<base>/shared/supabase-client.js"></script>
 *   <script src="<base>/shared/auth.js"></script>
 *   <script src="<base>/shared/auth-gate.js"></script>   (tool pages only)
 *   <script src="<base>/shared/concierge.js"></script>
 *
 * On the hub <base> is `./`; on /tools/*.html it's `../`.
 * ========================================================================== */

(function () {
  'use strict';

  const PROXY_URL = 'https://cannojsxduvlewimwoxa.supabase.co/functions/v1/ai-concierge';
  /* 8b-instant has ~10× the daily token budget of 70B-versatile on
     Groq free tier — quality drop is minor for navigation + market
     lookups. Edge Function allow-list permits both, so flipping
     back to 'llama-3.3-70b-versatile' is one line if budget grows. */
  const MODEL = 'llama-3.1-8b-instant';
  /* Streaming on by default — words appear as Groq generates them.
     Set to false to fall back to the original block-after-complete
     behaviour (useful for debugging upstream errors). */
  const STREAMING = true;
  const MAX_TOOL_ROUNDS = 5;
  /* 8b-instant has a tight 6000 TPM budget. Every request resends
     the system prompt (~750 tk), tool schemas (~1250 tk), plus the
     full history. Keeping history short reduces the chance two
     consecutive sends bust the per-minute cap. 12 entries ≈ 4-6
     full turns including tool round-trips — plenty of context for
     a hub concierge. */
  const MAX_HISTORY = 12;
  /* Auto-retry threshold for short 429 cooldowns. Anything shorter
     than this we wait and retry transparently; anything longer
     surfaces as the manual retry bubble. */
  const AUTO_RETRY_MAX_WAIT_SEC = 25;

  const HISTORY_KEY = 'pp-concierge-history-v1';
  const DISPLAY_KEY = 'pp-concierge-display-v1';

  const SYSTEM_PROMPT = `You are the Performance Property internal concierge. Help staff navigate the hub. Be concise (1-2 sentences + an action). When a user wants to go somewhere, CALL THE APPROPRIATE FUNCTION rather than just describing the path.

The hub has 4 swipeable pages: analytics (default — Property Clock, Runway v Demand, Online Reports, Documents, Presentations, Results, Research Reports), pm (Cadence), arena (Typing Test, Chess, Scrabble), vault (Runway Workbook, Demand Score, Lite Reports).

Research Reports cluster (sits alongside the 35 Online Reports under the same picker): National Market Overview (national-report) and Commercial Market Overview (commercial-report). Different shape from the regional Online Reports — they cover Australia-wide macro indicators (cash rate, inflation, retail turnover, lending, yields, etc.) rather than a single market. Use openTool with 'national-report' or 'commercial-report' when the user asks for them.

35 Online Reports markets, grouped: Capitals (Adelaide, Brisbane, Canberra, Darwin, Hobart, Melbourne, Perth, Sydney); QLD (Bundaberg, Cairns, Gladstone, Gold Coast, Ipswich, Mackay, Rockhampton, Sunshine Coast, Toowoomba, Townsville); NSW (Albury, Central Coast, Coffs Harbour, Newcastle, Orange, Port Macquarie, Tamworth, Wagga Wagga, Wollongong); Other (Ballarat, Bendigo, Geelong, Mildura, Wodonga, Bunbury, Rockingham, Launceston). Mandurah uses the Rockingham report.

Access tiers — internal-only tool, every signed-in user can VIEW everything: Tier 0 (dev, Vandolf), Tier 1 (admin, Saskia/Shaene/Paul/D.Robbins) can edit + download. Tier 2 (company, other @performanceproperty.com.au) can download but not edit. Tier 3 (client) + Tier 4 (guest) can view everything but cannot edit OR download.

Three libraries to disambiguate: Documents (Whitepapers & Strategies — folder library of research links + training material), Presentations Library (folder library of pre-made slide decks), Presentation Builder (the slide-deck editor itself).

Edit mode is Tier 0-1 only. Saves auto-persist (localStorage instantly + Supabase after ~800ms). Light/dark theme toggle is shared across all hub pages. Arena highlights: typing PBs, WPM milestones (60/80/100/120), win streaks (3+) in Chess/Scrabble, upsets (winner 100+ rating below).

Live data you CAN look up — ALWAYS call these tools for market metrics, never invent or estimate numbers:
- getMarketData: per-market live snapshot — demand score (0–100), runway, days on market, median price, 12-month + 3-month price growth, weekly rent, rental growth, market classification. Available for all 35 markets, separately for houses vs units. Use for any "what's X's demand / runway / median / growth / rent" question.
- getMarketClockPhase: per-market Property Clock classification (smooth = demand-led, workforce = supply-driven). Houses or units. Use for "where is X on the property clock?" / "what's X's market type?".
- listMarketReports: which markets have an online report, with state and cluster. Use for "which markets have reports?" / "list NSW reports".
- getTypingLeader: current #1 on the Arena Typing Test by mode + word-list. For Chess and Scrabble leaders, send the user to the Arena "Top of the Leaderboards" card via openArenaActivity({activity:'leaderboards'}) — no per-game leader tool yet.

Rules: only navigate inside this hub (no external URLs). If you don't know something, say so — don't invent features. If a user pastes what looks like personal data, contracts, financials, or credentials, refuse and flag it.

Clarify before looking up — don't guess. For getMarketData and getMarketClockPhase: if the user asks about a market's metric (median price, demand score, runway, growth, rent, market type, etc.) WITHOUT specifying houses or units, ASK them which they want before calling the tool. Same for any other ambiguity — if you'd have to fill in a parameter from a default rather than from the user's words, ask first. Only exception: if the user explicitly says "both" or "house and units", call the tool twice (once per type) and present both. Short, single-line clarifying questions ("Houses or units?") — don't lecture.

CRITICAL OUTPUT FORMAT: When you need to invoke a tool, USE THE NATIVE TOOL_CALLS PROTOCOL — return a tool_calls array on the response message. NEVER write function calls as inline text like \`<function=name>{...}</function>\`, \`<|python_tag|>...\`, or any JSON-resembling syntax embedded in your text reply. Your visible text content must be plain prose only — no tags, no JSON, no XML, no markup of any kind that hints at function invocation. If the user's question doesn't require a tool, just answer in plain prose with no tool_calls at all.`;

  const TOOL_DEFINITIONS = [
    { type: 'function', function: {
      name: 'openHubPage',
      description: "Switch to a specific page of the main hub. Use when the user wants to navigate to a top-level section (e.g. 'go to the arena page').",
      parameters: { type: 'object', properties: {
        page: { type: 'string', enum: ['analytics', 'pm', 'arena', 'vault'],
          description: "Which hub page. 'analytics' is the default landing with research tools; 'pm' = Cadence; 'arena' = games; 'vault' = internal-only tools." },
      }, required: ['page'] }
    }},
    { type: 'function', function: {
      name: 'openTool',
      description: 'Open one of the hub tools by its short ID.',
      parameters: { type: 'object', properties: {
        tool: { type: 'string', enum: [
          'property-clock','runway-demand','demand-score','documents','presentations',
          'presentation-builder','online-reports','cadence','arena','typing','chess',
          'scrabble','runway-workbook','national-report','commercial-report'
        ], description: "Short ID. 'documents'=Whitepapers & Strategies; 'presentations'=Library; 'presentation-builder'=editor; 'arena'=landing page; 'typing'/'chess'/'scrabble'=games; 'national-report'=National Market Overview research report; 'commercial-report'=Commercial Market Overview research report." },
      }, required: ['tool'] }
    }},
    { type: 'function', function: {
      name: 'openOnlineReport',
      description: "Open the online property report for a specific Australian market. 35 supported regions.",
      parameters: { type: 'object', properties: {
        location: { type: 'string', description: "Market name (e.g. 'Sydney', 'Gold Coast', 'Port Macquarie'). Mandurah is served from the Rockingham report." },
        lite: { type: 'boolean', description: 'Open the Lite (preview) version.', default: false },
      }, required: ['location'] }
    }},
    { type: 'function', function: {
      name: 'openArenaActivity',
      description: "Open an Arena game or section. Use for 'open chess', 'start typing', 'show leaderboards' etc.",
      parameters: { type: 'object', properties: {
        activity: { type: 'string', enum: ['arena','typing','chess','scrabble','leaderboards'],
          description: "'arena' = landing; 'leaderboards' = jumps to the Top of the Leaderboards card on the arena page." },
      }, required: ['activity'] }
    }},
    { type: 'function', function: {
      name: 'whichToolFor',
      description: "When the user describes a task or asks 'which tool for X?', return a short recommendation. Use BEFORE openTool when you're unsure what the user wants.",
      parameters: { type: 'object', properties: {
        intent: { type: 'string', description: "User's described task in their own words." },
      }, required: ['intent'] }
    }},
    { type: 'function', function: {
      name: 'listTools',
      description: "List the hub's tools, optionally filtered by category.",
      parameters: { type: 'object', properties: {
        category: { type: 'string', enum: ['analytics','pm','arena','vault','all'], default: 'all' },
      } }
    }},
    { type: 'function', function: {
      name: 'explainTier',
      description: "Explain access tiers. Use for 'why can't I edit?', 'what's my tier?', 'who can see this?'.",
      parameters: { type: 'object', properties: {
        tier: { type: 'string', enum: ['dev','admin','company','client','guest','all'], default: 'all' },
      } }
    }},
    { type: 'function', function: {
      name: 'howDoI',
      description: "Short step-by-step recipe for a common hub task.",
      parameters: { type: 'object', properties: {
        task: { type: 'string', enum: [
          'export-report-pdf','edit-online-report','switch-theme','add-presentation-theme',
          'log-chess-match','restart-typing-test','find-arena','switch-hub-page','view-as-another-tier'
        ] },
      }, required: ['task'] }
    }},
    { type: 'function', function: {
      name: 'getTypingLeader',
      description: "Look up the current leader on the Arena Typing Test. Use when the user asks who's #1 / leading / top / best on the typing test. Filters by mode_seconds (15/30/60) and word_list (english/real-estate/code) — defaults to the most common 60s english combo when the user doesn't specify.",
      parameters: { type: 'object', properties: {
        mode_seconds: { type: 'number', enum: [15, 30, 60], default: 60, description: 'Test duration in seconds.' },
        word_list:    { type: 'string', enum: ['english','real-estate','code'], default: 'english', description: 'Which word list the test used.' },
      } }
    }},
    { type: 'function', function: {
      name: 'getMarketData',
      description: "Look up the live market snapshot for one of the 35 Australian markets. Returns demand score (0-100), runway, days on market, median price, 12-month + 3-month price growth, weekly rent, rental growth, state. Same data source the Demand Score Dashboard and Runway v Demand tools use. ALWAYS call this for any 'what's the demand score / runway / median price / growth / rent for X?' question — never invent values. IMPORTANT: property_type is required. If the user didn't say houses or units, DO NOT pick one — ask them first.",
      parameters: { type: 'object', properties: {
        market: { type: 'string', description: "Market name (e.g. 'Sydney', 'Gold Coast', 'Port Macquarie')." },
        property_type: { type: 'string', enum: ['house', 'unit'], description: 'Houses or units. Required — ask the user if they did not specify.' },
      }, required: ['market', 'property_type'] }
    }},
    { type: 'function', function: {
      name: 'getMarketClockPhase',
      description: "Look up a market's Property Clock classification — 'smooth' (demand-led) or 'workforce' (supply-driven). Use for 'where is X on the property clock?' / 'what's X's market type?'. IMPORTANT: property_type is required. If the user didn't say houses or units, DO NOT pick one — ask them first.",
      parameters: { type: 'object', properties: {
        market: { type: 'string', description: 'Market name.' },
        property_type: { type: 'string', enum: ['house', 'unit'], description: 'Houses or units. Required — ask the user if they did not specify.' },
      }, required: ['market', 'property_type'] }
    }},
    { type: 'function', function: {
      name: 'listMarketReports',
      description: "List the 35 markets with an online report, optionally filtered by cluster or state. Use for 'which markets have reports?' / 'list NSW reports' / 'do you have a Cairns report?'.",
      parameters: { type: 'object', properties: {
        cluster: { type: 'string', enum: ['capital', 'qld', 'nsw', 'vicwatas', 'all'], default: 'all', description: 'Region cluster.' },
        state:   { type: 'string', description: 'Optional state code filter (NSW, VIC, QLD, SA, WA, TAS, ACT, NT).' },
      } }
    }},
  ];

  /* Root-relative paths so the same URLs resolve from both the hub
     (/) and from a tool page (/tools/foo.html). The browser treats
     a leading slash as "from site root", which is exactly what we
     want regardless of where the request originates. */
  const TOOL_URLS = {
    'property-clock':       '/tools/property-clock.html',
    'runway-demand':        '/tools/runway-demand.html',
    'demand-score':         '/tools/demand-score.html',
    'documents':            '/tools/whitepapers-strategies.html',
    'presentations':        '/tools/presentations-library.html',
    'presentation-builder': '/tools/presentation.html',
    'online-reports':       '/tools/online-reports.html',
    'cadence':              '/tools/cadence.html',
    'arena':                '/tools/arena.html',
    'typing':               '/tools/arena-typing.html',
    'chess':                '/tools/arena-chess.html',
    'scrabble':             '/tools/arena-scrabble.html',
    'runway-workbook':      '/tools/runway-workbook.html',
    'national-report':      '/tools/national-report.html',
    'commercial-report':    '/tools/commercial-report.html',
  };

  const REPORT_REGIONS = new Set([
    'sydney','melbourne','brisbane','adelaide','perth','hobart','canberra','darwin',
    'bundaberg','cairns','gladstone','gold-coast','ipswich','mackay','rockhampton',
    'sunshine-coast','toowoomba','townsville',
    'albury','central-coast','coffs-harbour','newcastle','orange',
    'port-macquarie','tamworth','wagga-wagga','wollongong',
    'ballarat','bendigo','geelong','mildura','wodonga',
    'bunbury','rockingham','launceston',
  ]);

  const TOOL_RECOMMENDATIONS = [
    { match: /slide|deck|present|pitch/i, tool: 'presentation-builder', note: "Use the Presentation builder. The Presentations Library has pre-made decks you can start from." },
    { match: /whitepaper|strategy|training|research link|document/i, tool: 'documents', note: "Documents (Whitepapers & Strategies) has all your research links, strategies, and training materials." },
    { match: /market report|region report|sydney|melbourne|brisbane|adelaide|perth|hobart|canberra|darwin/i, tool: 'online-reports', note: "Online Reports has the deep-dive for every region." },
    { match: /clock|cycle/i, tool: 'property-clock', note: "National Property Clock shows where each market sits in the cycle." },
    { match: /runway|forecast|wage/i, tool: 'runway-demand', note: "Runway v Demand pulls live wage-growth forecasts and runway months per region." },
    { match: /demand score|grid|compare regions/i, tool: 'demand-score', note: "Demand Score Dashboard has the per-region grid with micro-charts." },
    { match: /cadence|workflow|task|board/i, tool: 'cadence', note: "Cadence is the team workflow tracker." },
    { match: /typing|wpm|speed test/i, tool: 'typing', note: "Typing Test — 15/30/60s modes." },
    { match: /chess/i, tool: 'chess', note: "Chess ladder — Phase 0 (manual match logging). All start at 1000 points." },
    { match: /scrabble/i, tool: 'scrabble', note: "Scrabble — online two-player with lobbies." },
    { match: /game|arcade|play|fun/i, tool: 'arena', note: "Performance Property Arena has Typing Test, Chess, and Scrabble." },
    { match: /scenario|workbook|model/i, tool: 'runway-workbook', note: "Runway Workbook (Vault) — scenario modelling for runway + wage assumptions." },
    { match: /national (market|overview|report)|australia[- ]wide|macro|cash rate|inflation/i, tool: 'national-report', note: "National Market Overview — Australia-wide macro report (cash rate, inflation, lending, yields, etc.)." },
    { match: /commercial (market|overview|report|property)|industrial|medical|retail (yield|turnover)|office market/i, tool: 'commercial-report', note: "Commercial Market Overview — Australia-wide commercial / industrial / medical / retail report." },
  ];

  const TOOL_LIST = {
    analytics: ['National Property Clock','Runway v Demand Score','Online Reports (35 regions)','Research Reports — National + Commercial Market Overview','Documents — Whitepapers & Strategies','Presentations — Library + Builder'],
    pm:        ['Cadence — workflow tracker'],
    arena:     ['Typing Test','Chess (ladder)','Scrabble (online)'],
    vault:     ['Runway Workbook','Demand Score Dashboard','Lite Online Reports'],
  };

  const TIER_DESCRIPTIONS = {
    dev:     "Tier 0 (dev). Vandolf only. Full edit + download. Can switch view-as to test other tiers.",
    admin:   "Tier 1 (admin). Saskia, Shaene, Paul, D. Robbins. Full edit + download.",
    company: "Tier 2 (company). Other @performanceproperty.com.au staff. View + download, no edit.",
    client:  "Tier 3 (client). Approved external viewers. View everything, no edit, no download.",
    guest:   "Tier 4 (guest). Self-registered viewers. View everything, no edit, no download.",
  };

  /* Live market data — computed from Forge (Supabase), the SAME source and
     engine as demand-score.html (the legacy Apps Script feed was retired
     2026-07-04). Assembles the model inputs from the DB and runs a local port
     of PP_DEMAND_ENGINE, returning per-market objects (houses[] / units[]) with
     the fields getMarketData needs. Cached 5 min.
     NOTE: the engine + Forge assembly below are a lean copy of demand-score's
     loadForgeAll/buildForgeMarkets — if the formula or the Forge input shapes
     change, update BOTH. */
  const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
  const _marketCache = { fetchedAt: 0, houses: null, units: null, promise: null };

  /* Demand Score engine — lean copy of demand-score.html's PP_DEMAND_ENGINE.
     F=listings/pop×1000; H=VR%×F; L=DOM×(1−rentGrowth); M=L×H; N=grade(M);
     DS=clamp(((N−Nbench)/Nbench)×100, −20, 80). Benchmark F = median over ALL
     rows incl National. Keep in sync with the dashboard's engine. */
  const _DEMAND_ENGINE = (function () {
    const E1 = 1000;
    const BENCH = { vr: 3, dom: 45, rentGrowth: 0.1 };
    const A = (function () {
      const a = [];
      for (let v = 0;   v <= 20;   v += 1)  a.push(v);
      for (let v = 25;  v <= 100;  v += 5)  a.push(v);
      for (let v = 110; v <= 3740; v += 10) a.push(v);
      return a;
    })();
    function grade(M) {
      if (!(M > A[0])) return 100;
      let lo = 0, hi = A.length - 1, idx = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (A[mid] <= M) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      return 100 - 0.5 * idx;
    }
    function median(arr) {
      const a = arr.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
      const n = a.length; if (!n) return 0;
      return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }
    function compute(rows) {
      rows.forEach(r => {
        const pop = Number(r.population) || 0, list = Number(r.listings) || 0;
        r._F = pop > 0 ? (list / pop * E1) : 0;
        r._H = (Number(r.vr) || 0) * r._F;
        r._L = (Number(r.dom) || 0) * (1 - (Number(r.rentGrowth) || 0));
        r._M = r._L * r._H;
      });
      const Fb = median(rows.map(r => r._F));
      const Nb = grade((BENCH.dom * (1 - BENCH.rentGrowth)) * (BENCH.vr * Fb));
      rows.forEach(r => {
        const N = grade(r._M);
        r.demandScore = Math.round(Math.min(80, Math.max(-20, ((N - Nb) / Nb) * 100)) * 10) / 10;
        delete r._F; delete r._H; delete r._L; delete r._M;
      });
      return rows;
    }
    return { compute };
  })();

  /* Forge helpers — mirror demand-score.html's _fSlug/_fNum/_mpStats. */
  function _fSlug(s) {
    s = String(s == null ? '' : s).trim(); if (/^national$/i.test(s)) return 'australia';
    return s.replace(/\([^)]*\)/g, ' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig, ' ')
      .replace(/\bgreater\b/ig, ' ').replace(/\bregional\b/ig, ' ').replace(/-hastings/ig, ' ')
      .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  const _fNum = v => { const n = +String(v == null ? '' : v).replace(/[$,%\s]/g, ''); return isFinite(n) ? n : null; };
  function _mpStats(arr) {
    const a = Array.isArray(arr) ? arr.filter(v => typeof v === 'number' && isFinite(v) && v > 0) : [];
    const n = a.length; if (!n) return { median: 0, g12: 0, g3: 0 };
    const latest = a[n - 1], v12 = n > 12 ? a[n - 13] : null, v3 = n > 3 ? a[n - 4] : null;
    return { median: Math.round(latest), g12: v12 ? Math.round((latest - v12) / v12 * 1000) / 10 : 0, g3: v3 ? Math.round((latest - v3) / v3 * 1000) / 10 : 0 };
  }

  /* Build per-market objects for one property type from the Forge stores,
     running the engine over ALL rows (incl National) for the benchmark median
     then dropping National. Returns the fields getMarketData needs. */
  function _buildForgeMarkets(propertyType, DI, M) {
    const isU = propertyType === 'units';
    const rawRows = Object.keys(DI).map(slug => {
      const d = DI[slug] || {};
      const rentNow = isU ? d.rent_u : d.rent_h, rent3 = isU ? d.rent_u_3yr : d.rent_h_3yr;
      return {
        slug,
        name: M.name[slug] || (slug === 'australia' ? 'National' : slug),
        state: M.state[slug] || '',
        population: M.pop[slug] || 0,
        listings: (isU ? d.listings_u : d.listings_h) || 0,
        vr: M.adjVR[slug] != null ? M.adjVR[slug] : 0,
        dom: (isU ? M.domU[slug] : M.domH[slug]) || 0,
        rentGrowth: (rentNow != null && rent3 != null && rent3 > 0) ? (rentNow - rent3) / rent3 : 0,
        isNational: slug === 'australia',
      };
    });
    _DEMAND_ENGINE.compute(rawRows);
    const markets = [];
    rawRows.forEach(r => {
      if (r.isNational) return;
      const d = DI[r.slug] || {};
      const st = _mpStats((M.mp[r.slug] || {})[isU ? 'u' : 'h']);
      const rwp = M.runway[r.slug] || {};
      const rent = isU ? d.rent_u : d.rent_h;
      markets.push({
        name: r.name, state: r.state,
        demandScore: r.demandScore,
        runway: (isU ? rwp.u : rwp.h) != null ? Math.round((isU ? rwp.u : rwp.h) * 10000) / 10000 : 0,
        dom: r.dom,
        rentalGrowth36m: Math.round(r.rentGrowth * 1000) / 10,
        medianPrice: st.median, priceGrowth12m: st.g12, priceGrowth3m: st.g3,
        weeklyRent: rent != null ? Math.round(rent) : 0,
      });
    });
    return markets;
  }

  /* Read all Forge stores + assemble houses[]/units[]. Mirrors
     demand-score.html's loadForgeAll (minus the legend it doesn't need). */
  async function _loadForgeMarkets() {
    for (let i = 0; i < 50 && !window.sb; i++) await new Promise(r => setTimeout(r, 100));
    if (!window.sb) throw new Error('Database client not loaded.');
    const [reg, di, vr, rw, mp, pop, cot] = await Promise.all([
      window.sb.from('rdp_regions').select('slug,name,state'),
      window.sb.from('forge_demand_inputs').select('data').eq('id', 'latest').maybeSingle(),
      window.sb.from('rdp_vr_forecast').select('region_slug,payload'),
      window.sb.from('rdp_runway').select('region_slug,payload'),
      window.sb.from('forge_monthly_price').select('data').eq('id', 'latest').maybeSingle(),
      window.sb.from('rdp_raw_series').select('region_slug,period,value').eq('metric', 'population').gte('period', '2020-01-01'),
      window.sb.from('forge_cotality').select('data').eq('id', 'latest').maybeSingle(),
    ]);
    // Check EVERY read — a silent mp/cot failure would zero medians/DOM and
    // let the chat answer with confidently wrong numbers instead of an error.
    const err = reg.error || di.error || vr.error || rw.error || pop.error || mp.error || cot.error;
    if (err) throw new Error(err.message || 'Forge read failed');
    const M = { name: {}, state: {}, pop: {}, adjVR: {}, runway: {}, domH: {}, domU: {}, mp: {} };
    (reg.data || []).forEach(r => { M.name[r.slug] = r.name; M.state[r.slug] = r.state; });
    { const latest = {}; for (const r of (pop.data || [])) { const s = r.region_slug; if (!latest[s] || r.period > latest[s]) { latest[s] = r.period; M.pop[s] = +r.value; } } }
    (vr.data || []).forEach(r => { const f = r.payload && r.payload.forecastVR; if (f != null) M.adjVR[r.region_slug] = f * 100; });
    (rw.data || []).forEach(r => { const p = r.payload || {}; M.runway[r.region_slug] = { h: p.house && p.house.runway_pct, u: p.unit && p.unit.runway_pct }; });
    const cotData = (cot.data && cot.data.data) || {};   // .select('data').maybeSingle() nests jsonb at .data.data
    const cotRows = [...((cotData.cap || {}).rows || []), ...((cotData.lga || {}).rows || [])];
    for (const row of cotRows) { const slug = _fSlug(row[1]); const dom = _fNum(row[6]); if (!slug || dom == null) continue; if (String(row[2]).toUpperCase() === 'U') M.domU[slug] = dom; else M.domH[slug] = dom; }
    M.mp = ((mp.data && mp.data.data && mp.data.data.regions)) || {};
    const DI = ((di.data && di.data.data && di.data.data.regions)) || {};
    if (!Object.keys(DI).length) throw new Error('No Demand Score data in Forge yet.');
    return { houses: _buildForgeMarkets('houses', DI, M), units: _buildForgeMarkets('units', DI, M) };
  }

  async function _fetchMarketData() {
    const now = Date.now();
    if (_marketCache.houses && (now - _marketCache.fetchedAt) < MARKET_CACHE_TTL_MS) {
      return _marketCache;
    }
    if (_marketCache.promise) return _marketCache.promise;
    _marketCache.promise = (async () => {
      try {
        const fm = await _loadForgeMarkets();
        _marketCache.houses = fm.houses;
        _marketCache.units  = fm.units;
        _marketCache.fetchedAt = Date.now();
        return _marketCache;
      } finally {
        _marketCache.promise = null;
      }
    })();
    return _marketCache.promise;
  }

  function _normMarket(name) {
    /* Collapse to lowercase letters so 'Gold Coast' / 'gold-coast'
       / 'GOLD COAST' all match. */
    return String(name || '').toLowerCase().replace(/[^a-z]+/g, '');
  }

  function _findMarket(list, query) {
    if (!Array.isArray(list)) return null;
    const q = _normMarket(query);
    if (!q) return null;
    return list.find(m => m && m.name && _normMarket(m.name) === q) ||
           list.find(m => m && m.name && _normMarket(m.name).startsWith(q)) ||
           null;
  }

  /* Compact snapshot of online-reports.html's REGION_MANIFEST.
     Only name/state/cluster — enough for the listMarketReports
     tool. If a region ever gets added there, mirror it here. */
  const REPORT_MANIFEST = {
    sydney:           { name: 'Sydney',         state: 'NSW', cluster: 'capital'  },
    melbourne:        { name: 'Melbourne',      state: 'VIC', cluster: 'capital'  },
    brisbane:         { name: 'Brisbane',       state: 'QLD', cluster: 'capital'  },
    adelaide:         { name: 'Adelaide',       state: 'SA',  cluster: 'capital'  },
    perth:            { name: 'Perth',          state: 'WA',  cluster: 'capital'  },
    hobart:           { name: 'Hobart',         state: 'TAS', cluster: 'capital'  },
    canberra:         { name: 'Canberra',       state: 'ACT', cluster: 'capital'  },
    darwin:           { name: 'Darwin',         state: 'NT',  cluster: 'capital'  },
    mackay:           { name: 'Mackay',         state: 'QLD', cluster: 'qld'      },
    bundaberg:        { name: 'Bundaberg',      state: 'QLD', cluster: 'qld'      },
    ipswich:          { name: 'Ipswich',        state: 'QLD', cluster: 'qld'      },
    rockhampton:      { name: 'Rockhampton',    state: 'QLD', cluster: 'qld'      },
    gladstone:        { name: 'Gladstone',      state: 'QLD', cluster: 'qld'      },
    cairns:           { name: 'Cairns',         state: 'QLD', cluster: 'qld'      },
    townsville:       { name: 'Townsville',     state: 'QLD', cluster: 'qld'      },
    'sunshine-coast': { name: 'Sunshine Coast', state: 'QLD', cluster: 'qld'      },
    toowoomba:        { name: 'Toowoomba',      state: 'QLD', cluster: 'qld'      },
    'gold-coast':     { name: 'Gold Coast',     state: 'QLD', cluster: 'qld'      },
    albury:           { name: 'Albury',         state: 'NSW', cluster: 'nsw'      },
    'central-coast':  { name: 'Central Coast',  state: 'NSW', cluster: 'nsw'      },
    'coffs-harbour':  { name: 'Coffs Harbour',  state: 'NSW', cluster: 'nsw'      },
    orange:           { name: 'Orange',         state: 'NSW', cluster: 'nsw'      },
    'port-macquarie': { name: 'Port Macquarie', state: 'NSW', cluster: 'nsw'      },
    newcastle:        { name: 'Newcastle',      state: 'NSW', cluster: 'nsw'      },
    tamworth:         { name: 'Tamworth',       state: 'NSW', cluster: 'nsw'      },
    'wagga-wagga':    { name: 'Wagga Wagga',    state: 'NSW', cluster: 'nsw'      },
    wollongong:       { name: 'Wollongong',     state: 'NSW', cluster: 'nsw'      },
    ballarat:         { name: 'Ballarat',       state: 'VIC', cluster: 'vicwatas' },
    bendigo:          { name: 'Bendigo',        state: 'VIC', cluster: 'vicwatas' },
    geelong:          { name: 'Geelong',        state: 'VIC', cluster: 'vicwatas' },
    wodonga:          { name: 'Wodonga',        state: 'VIC', cluster: 'vicwatas' },
    mildura:          { name: 'Mildura',        state: 'VIC', cluster: 'vicwatas' },
    rockingham:       { name: 'Rockingham',     state: 'WA',  cluster: 'vicwatas' },
    bunbury:          { name: 'Bunbury',        state: 'WA',  cluster: 'vicwatas' },
    launceston:       { name: 'Launceston',     state: 'TAS', cluster: 'vicwatas' },
  };

  const HOW_TO = {
    'export-report-pdf':      "Open the report → toolbar → PDF button. Filename gets a unique suffix so you won't overwrite an earlier export.",
    'edit-online-report':     "Open the report → toolbar → View/Edit pill (top right). Edit mode is tier 0-1 only. Edits save automatically.",
    'switch-theme':           "Sun/moon toggle at the top of the hub. Preference saves per-browser.",
    'add-presentation-theme': "Presentation builder → right-click any slide → 'Set as Theme'. Tier 0-1 only.",
    'log-chess-match':        "Open Chess → 'Log Match' button. Pick opponent, enter result. Phase 0 is manual logging.",
    'restart-typing-test':    "Press Tab, then Enter (Tab arms a one-shot Enter listener).",
    'find-arena':             "Right-edge pull-tab on the hub labelled 'Performance Property Arena'.",
    'switch-hub-page':        "Left/right edge pull-tabs to swipe between the 4 hub pages (Analytics, PM, Arena, Vault).",
    'view-as-another-tier':   "Dev only — bottom-right floating UI lets you switch view-as.",
  };

  const NAV_ACKNOWLEDGMENTS = [
    'Sure, hold on…',
    'On it!',
    'Got it — opening now…',
    'One sec…',
    'Right away…',
    'Coming up…',
    'You got it!',
    'Sure thing — heading there now…',
    'Opening that for you…',
  ];
  const NAV_ACTIONS = new Set([
    'openHubPage', 'openTool', 'openOnlineReport', 'openArenaActivity',
  ]);

  /* ── Init ── */

  function init() {
    /* Don't double-mount if this script gets loaded twice (e.g.
       leftover inline copy on a page that also pulls the shared
       module). The button id is the canary. */
    if (document.getElementById('conciergeBtn')) return;

    /* Skip injection in any embedded / export context. The widget
       is only meaningful when the user is interacting with a top-
       level tool page; it has no business showing inside:
         - Property Clock / Runway v Demand embeds inside a slide
           (`?embed=1`, body.embed-mode)
         - Online Reports' off-screen export iframes (`?exportMode=1`)
         - Any other iframe consumer we add later
       The window-top check catches all iframe contexts in one go;
       the URL-param checks belong-and-braces handle the rare case
       where a tool is opened standalone with the flag for testing. */
    try {
      if (window.top && window.top !== window.self) return;
    } catch (_) { /* cross-origin → still treat as iframe */ return; }
    const qs = (location.search || '').toLowerCase();
    if (qs.includes('embed=1') || qs.includes('exportmode=1')) return;

    injectMarkup();

    const btn       = document.getElementById('conciergeBtn');
    const panel     = document.getElementById('conciergePanel');
    const closeBtn  = document.getElementById('conciergeClose');
    const messages  = document.getElementById('conciergeMessages');
    const input     = document.getElementById('conciergeInput');
    const sendBtn   = document.getElementById('conciergeSend');
    if (!btn || !panel || !messages || !input || !sendBtn) return;

    /* Show launcher only for signed-in users. */
    function refreshVisibility() {
      const signedIn = !!sessionStorage.getItem('pp_auth');
      btn.style.display = signedIn ? 'flex' : 'none';
      if (!signedIn) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
      }
    }
    refreshVisibility();
    new MutationObserver(refreshVisibility).observe(
      document.body, { attributes: true, attributeFilter: ['class'] }
    );
    window.addEventListener('storage', refreshVisibility);

    function renderEmptyState() {
      messages.innerHTML =
        '<div class="concierge-empty">Ask me to open a tool, find a market report, or explain a hub feature.</div>';
    }
    renderEmptyState();
    let conversationStarted = false;

    function openPanel() {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      setTimeout(() => input.focus(), 200);
    }
    function closePanel() {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }

    btn.addEventListener('click', () => {
      if (panel.classList.contains('open')) closePanel();
      else openPanel();
    });
    closeBtn.addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
    });

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    function _scrollToBottom() {
      requestAnimationFrame(() => {
        try {
          messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
        } catch (_) {
          messages.scrollTop = messages.scrollHeight;
        }
      });
    }

    function appendMessage(role, text) {
      const el = document.createElement('div');
      el.className = 'concierge-msg ' + role;
      el.textContent = text;
      messages.appendChild(el);
      _scrollToBottom();
      return el;
    }

    function showTyping() {
      const el = document.createElement('div');
      el.className = 'concierge-msg assistant concierge-typing';
      el.setAttribute('aria-label', 'AI is thinking');
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'concierge-typing-dot';
        el.appendChild(dot);
      }
      messages.appendChild(el);
      _scrollToBottom();
      return el;
    }

    /* Error bubble with retry button. Clicking the retry button
       re-runs chat() with the last user message. We track the last
       user message in the closure so retry can replay it without
       requiring the user to retype. */
    let lastUserMessage = '';
    function appendErrorWithRetry(text) {
      const el = document.createElement('div');
      el.className = 'concierge-msg assistant concierge-error';
      const p = document.createElement('div');
      p.textContent = text;
      el.appendChild(p);
      if (lastUserMessage) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'concierge-retry-btn';
        btn.textContent = '↻ Retry';
        btn.addEventListener('click', () => {
          /* Pop the failed user+assistant pair off history so the
             retry re-sends as if the failure never happened. The
             last `history.push` was the user message; the failure
             bubble was display-only (not in history). */
          el.remove();
          if (history.length && history[history.length - 1].role === 'user') history.pop();
          /* Same for displayLog — drop the error bubble we just
             removed. The user message bubble stays visible. */
          persistChat();
          chat(lastUserMessage);
        });
        el.appendChild(btn);
      }
      messages.appendChild(el);
      _scrollToBottom();
      return el;
    }

    /* Output sanitiser — strips Llama's free-text tool-call leaks.
       Same patterns as before: <function=...>, <tool_call>,
       <|python_tag|>, JSON-shaped {name,parameters}. */
    function _cleanAssistantText(raw) {
      if (!raw) return '';
      let text = String(raw);
      text = text.replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '');
      text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
      text = text.replace(/<\|python_tag\|>[^\n]*/g, '');
      text = text.replace(/\{\s*"name"\s*:\s*"[a-zA-Z_]+"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{[\s\S]*?\}\s*\}/g, '');
      text = text.replace(/\n{3,}/g, '\n\n').trim();
      return text;
    }

    /* ─── History + persistence ─── */
    const history = [];
    const displayLog = [];

    function persistChat() {
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        sessionStorage.setItem(DISPLAY_KEY, JSON.stringify(displayLog));
      } catch (_) {}
    }

    function pushVisible(role, text) {
      displayLog.push({ role, text });
      appendMessage(role, text);
      persistChat();
    }

    function loadPersistedChat() {
      try {
        const h = sessionStorage.getItem(HISTORY_KEY);
        if (h) {
          const parsed = JSON.parse(h);
          if (Array.isArray(parsed)) history.push(...parsed);
        }
        const d = sessionStorage.getItem(DISPLAY_KEY);
        if (d) {
          const parsed = JSON.parse(d);
          if (Array.isArray(parsed) && parsed.length) {
            messages.innerHTML = '';
            parsed.forEach(item => {
              if (item && item.role && item.text) {
                displayLog.push({ role: item.role, text: item.text });
                appendMessage(item.role, item.text);
              }
            });
            conversationStarted = true;
          }
        }
      } catch (_) {}
    }
    loadPersistedChat();

    function _pickAck() {
      return NAV_ACKNOWLEDGMENTS[Math.floor(Math.random() * NAV_ACKNOWLEDGMENTS.length)];
    }

    function trimHistory() {
      if (history.length <= MAX_HISTORY) return history;
      while (history.length > MAX_HISTORY && history[0].role !== 'user') history.shift();
      while (history.length > MAX_HISTORY) history.shift();
      return history;
    }

    async function _getAccessToken() {
      if (!window.sb || !window.sb.auth) return null;
      try {
        const { data } = await window.sb.auth.getSession();
        return data && data.session && data.session.access_token || null;
      } catch (_) { return null; }
    }

    /* ─── Action handlers ─── */
    const ACTION_HANDLERS = {
      openHubPage({ page }) {
        const target = (page === 'analytics') ? 'main' : page;
        /* On the hub, setHubPage is in scope (defined inline in
           index.html). On a tool page it isn't — fall through to a
           hub navigation with a hash so the hub's onload handler
           picks the right page. */
        if (typeof window.setHubPage === 'function') {
          window.setHubPage(target);
          return { ok: true, message: 'Switched to ' + page + ' page' };
        }
        const hash = (target === 'main') ? '' : '#' + target;
        window.location.href = '/index.html' + hash;
        return { ok: true, message: 'Returning to hub ' + page + ' page' };
      },
      openTool({ tool }) {
        const url = TOOL_URLS[tool];
        if (!url) return { ok: false, message: 'unknown tool: ' + tool };
        if (typeof window.navigateToTool === 'function') {
          window.navigateToTool(url, tool);
        } else {
          window.location.href = url;
        }
        return { ok: true, message: 'Opening ' + tool };
      },
      openOnlineReport({ location, lite }) {
        let slug = String(location || '').toLowerCase().replace(/\s+/g, '-');
        if (slug === 'mandurah') slug = 'rockingham';
        if (!REPORT_REGIONS.has(slug)) {
          return { ok: false, message: 'no report for "' + location + '"' };
        }
        const url = '/tools/online-reports.html?region=' + slug + (lite ? '&lite=1' : '');
        if (typeof window.navigateToTool === 'function') {
          window.navigateToTool(url, location + ' report');
        } else {
          window.location.href = url;
        }
        return { ok: true, message: 'Opening ' + location + ' report' + (lite ? ' (Lite)' : '') };
      },
      openArenaActivity({ activity }) {
        const urls = {
          arena:        '/tools/arena.html',
          typing:       '/tools/arena-typing.html',
          chess:        '/tools/arena-chess.html',
          scrabble:     '/tools/arena-scrabble.html',
          leaderboards: '/tools/arena.html#leaderboards',
        };
        const url = urls[activity];
        if (!url) return { ok: false, message: 'unknown arena activity: ' + activity };
        if (typeof window.navigateToTool === 'function') {
          window.navigateToTool(url, activity);
        } else {
          window.location.href = url;
        }
        return { ok: true, message: 'Opening ' + activity };
      },
      whichToolFor({ intent }) {
        const hit = TOOL_RECOMMENDATIONS.find(r => r.match.test(intent || ''));
        if (!hit) return { ok: false, message: 'Nothing obviously matches "' + intent + '". Ask the user to describe what they want to see or do.' };
        return { ok: true, message: hit.note, suggestedTool: hit.tool };
      },
      listTools({ category = 'all' } = {}) {
        if (category === 'all') {
          return { ok: true, message: Object.entries(TOOL_LIST).map(([k,v]) => k + ': ' + v.join(' | ')).join('\n') };
        }
        const v = TOOL_LIST[category];
        if (!v) return { ok: false, message: 'unknown category: ' + category };
        return { ok: true, message: category + ': ' + v.join(' | ') };
      },
      explainTier({ tier = 'all' } = {}) {
        if (tier === 'all') {
          return { ok: true, message: Object.entries(TIER_DESCRIPTIONS).map(([k,v]) => k + ': ' + v).join('\n') };
        }
        const v = TIER_DESCRIPTIONS[tier];
        if (!v) return { ok: false, message: 'unknown tier: ' + tier };
        return { ok: true, message: v };
      },
      howDoI({ task }) {
        const v = HOW_TO[task];
        if (!v) return { ok: false, message: 'No walkthrough for "' + task + '".' };
        return { ok: true, message: v };
      },
      async getMarketData({ market, property_type } = {}) {
        if (!market) return { ok: false, message: 'No market specified.' };
        /* Hard-enforce clarification client-side. The chat loop
           sees needs_clarification, shows ask_user verbatim, and
           stops — no Groq round-trip, no risk of the model
           ignoring the rule and re-calling in a loop (which was
           burning the rate limit). */
        if (property_type !== 'house' && property_type !== 'unit') {
          return {
            ok: false,
            needs_clarification: true,
            ask_user: 'Houses or units?',
            message: 'property_type required. Ask the user before retrying.',
          };
        }
        const isUnit = property_type === 'unit';
        try {
          const cache = await _fetchMarketData();
          const list = isUnit ? cache.units : cache.houses;
          const found = _findMarket(list, market);
          if (!found) {
            return { ok: false, message: 'No data for "' + market + '". Supported markets are the 35 in the Online Reports list — call listMarketReports if unsure.' };
          }
          /* Numeric fields stay raw — let the model phrase units.
             priceGrowth/rentalGrowth values are already rounded
             percentages (e.g. 4.2 = 4.2%). runway is a 0–1 decimal
             (the model can format as % or "x months" as it sees fit;
             the Runway v Demand tool itself shows it as months). */
          return {
            ok: true,
            market: found.name,
            property_type: isUnit ? 'unit' : 'house',
            state: found.state,
            demand_score: found.demandScore,
            runway: found.runway,
            days_on_market: found.dom,
            median_price: found.medianPrice,
            price_growth_12m_pct: found.priceGrowth12m,
            price_growth_3m_pct:  found.priceGrowth3m,
            weekly_rent: found.weeklyRent,
            rental_growth_36m_pct: found.rentalGrowth36m,
          };
        } catch (e) {
          return { ok: false, message: 'Market data lookup failed: ' + String(e) };
        }
      },
      async getMarketClockPhase({ market, property_type } = {}) {
        if (!market) return { ok: false, message: 'No market specified.' };
        if (property_type !== 'house' && property_type !== 'unit') {
          return {
            ok: false,
            needs_clarification: true,
            ask_user: 'Houses or units?',
            message: 'property_type required. Ask the user before retrying.',
          };
        }
        if (!window.sb) return { ok: false, message: 'Database client not loaded.' };
        const isUnit = property_type === 'unit';
        try {
          const { data, error } = await window.sb
            .from('clock_state')
            .select('payload')
            .eq('id', 1)
            .single();
          if (error) return { ok: false, message: 'Clock lookup failed: ' + (error.message || 'unknown error') };
          const payload = data && data.payload;
          if (!payload) return { ok: false, message: 'No property clock data available.' };
          const list = isUnit ? payload.units : payload.houses;
          const found = _findMarket(list, market);
          if (!found) return { ok: false, message: 'No clock entry for "' + market + '".' };
          return {
            ok: true,
            market: found.name,
            property_type: isUnit ? 'unit' : 'house',
            classification: found.type,
          };
        } catch (e) {
          return { ok: false, message: 'Clock lookup exception: ' + String(e) };
        }
      },
      listMarketReports({ cluster = 'all', state } = {}) {
        let entries = Object.entries(REPORT_MANIFEST).map(([slug, m]) => ({ slug, ...m }));
        if (cluster && cluster !== 'all') entries = entries.filter(e => e.cluster === cluster);
        if (state) entries = entries.filter(e => e.state === String(state).toUpperCase());
        if (!entries.length) return { ok: false, message: 'No markets match those filters.' };
        return {
          ok: true,
          count: entries.length,
          markets: entries.map(e => ({ name: e.name, state: e.state, cluster: e.cluster })),
        };
      },
      async getTypingLeader({ mode_seconds, word_list } = {}) {
        const mode = (mode_seconds === 15 || mode_seconds === 30 || mode_seconds === 60) ? mode_seconds : 60;
        const list = (word_list === 'real-estate' || word_list === 'code') ? word_list : 'english';
        if (!window.sb) return { ok: false, message: 'Database client not loaded.' };
        try {
          const { data, error } = await window.sb
            .from('arena_typing_scores')
            .select('player_email, wpm, completed_at')
            .eq('mode_seconds', mode)
            .eq('word_list', list)
            .order('wpm', { ascending: false })
            .limit(1);
          if (error) return { ok: false, message: 'Lookup failed: ' + (error.message || 'unknown error') };
          if (!data || !data.length) return { ok: false, message: 'No scores recorded yet for the ' + mode + 's ' + list + ' mode.' };
          const r = data[0];
          const name = String(r.player_email || '').split('@')[0] || 'unknown';
          return {
            ok: true,
            message: name + ' leads the ' + mode + 's ' + list + ' Typing Test at ' + r.wpm + ' WPM.',
            leader: name, wpm: r.wpm, mode_seconds: mode, word_list: list,
          };
        } catch (e) {
          return { ok: false, message: 'Lookup exception: ' + String(e) };
        }
      },
    };

    /* ─── Chat loop (streaming + retry) ─── */

    /* Parse Groq's "try again in 7.23s" / "1m23s" / "47m39.83s"
       message body, or its Retry-After header if present. Returns
       seconds (0 if neither could be parsed). */
    function _parse429Wait(resp, errText) {
      const ra = resp.headers.get('Retry-After');
      if (ra) {
        const n = parseFloat(ra);
        if (!isNaN(n) && n > 0) return n;
      }
      const m = String(errText).match(/try again in (?:(\d+)\s*m\s*)?([\d.]+)\s*s/i);
      if (m) return (parseInt(m[1] || '0', 10) * 60) + parseFloat(m[2]);
      return 0;
    }

    async function chat(userText) {
      lastUserMessage = userText;
      history.push({ role: 'user', content: userText });
      persistChat();
      let typingEl = showTyping();
      let rateLimitRetried = false;

      const token = await _getAccessToken();
      if (!token) {
        typingEl.remove();
        appendErrorWithRetry('Your session expired. Please sign in again, then retry.');
        return;
      }

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          trimHistory();
          const body = {
            model: MODEL,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
            tools: TOOL_DEFINITIONS,
            tool_choice: 'auto',
            temperature: 0.3,
            stream: STREAMING,
          };
          const resp = await fetch(PROXY_URL, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');

            /* Auto-retry path: short 429 cooldowns (TPM/RPM resets
               every minute) get retried transparently once. We
               leave the typing dots in place and slip a tiny info
               bubble above them, then remove the bubble and re-
               issue the same request. round-- + continue puts the
               for-loop back on the same iteration. */
            if (resp.status === 429 && !rateLimitRetried) {
              const waitSec = _parse429Wait(resp, errText);
              if (waitSec > 0 && waitSec <= AUTO_RETRY_MAX_WAIT_SEC) {
                rateLimitRetried = true;
                const infoEl = appendMessage('assistant',
                  "Hit Groq's per-minute limit — auto-retrying in " + Math.ceil(waitSec) + 's…');
                await new Promise(r => setTimeout(r, (waitSec + 0.5) * 1000));
                infoEl.remove();
                round--;
                continue;
              }
            }

            console.warn('AI concierge upstream error', resp.status, errText);
            typingEl.remove();
            if (resp.status === 429) {
              /* Long cooldown (or second 429 in a row) → manual
                 retry. Body shape from Groq:
                 { error: { message: "Rate limit reached for …
                            try again in 1m23s.", code: "rate_limit_exceeded" }} */
              let detail = '';
              try {
                const j = JSON.parse(errText);
                detail = (j && j.error && j.error.message) || '';
              } catch (_) {}
              const msg = detail
                ? 'Rate-limited by Groq: ' + detail
                : 'Rate-limited by Groq. Wait ~60 seconds and tap Retry.';
              appendErrorWithRetry(msg);
            } else {
              appendErrorWithRetry('Sorry — the AI service returned an error (' + resp.status + ').');
            }
            return;
          }

          /* Either path produces { content, toolCalls } — content
             is the assistant's text reply (may be empty if tool_calls
             are returned instead), toolCalls is an array of fully-
             assembled calls (id, function.name, function.arguments). */
          let msg;
          if (STREAMING && (resp.headers.get('content-type') || '').includes('event-stream')) {
            msg = await _consumeStream(resp, typingEl);
          } else {
            const data = await resp.json();
            const choice = data && data.choices && data.choices[0];
            const m = choice && choice.message;
            if (!m) {
              typingEl.remove();
              appendErrorWithRetry('Sorry — got an empty response from the AI.');
              return;
            }
            msg = { content: m.content || '', toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls : [] };
          }

          if (msg.toolCalls.length) {
            /* History gets the proper assistant-with-tool_calls shape
               so subsequent calls in this conversation make sense to
               the model. */
            history.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.toolCalls });
            typingEl.remove();

            /* Pre-flight clarification: Llama often silently fills
               in a default for ambiguous parameters (house, full
               report, 60s mode) even when the user never said
               anything that justifies the choice. We bypass the
               model — scan the user's transcript for an explicit
               keyword first; if missing for a tool that needs it,
               ask the user before wasting a tool call. Add a new
               rule by listing the affected tools, a regex that
               matches user words committing to a choice, and the
               question to ask when the keyword is absent. */
            const _userTranscript = history.filter(h => h.role === 'user')
              .map(h => String(h.content || '')).join(' ').toLowerCase();
            const CLARIFICATION_RULES = [
              {
                tools: ['getMarketData', 'getMarketClockPhase'],
                pattern: /\b(house|houses|villa|villas|townhouse|townhouses|unit|units|apartment|apartments|flat|flats|both)\b/,
                question: 'Houses or units?',
              },
              {
                tools: ['openOnlineReport'],
                pattern: /\b(lite|preview|full|complete|detailed|long|short|share|sharable|shareable)\b/,
                question: 'Full report or Lite (preview) version?',
              },
              {
                tools: ['getTypingLeader'],
                pattern: /\b(15|30|60)\s*-?\s*s(econds?)?\b|\b(15s|30s|60s)\b|\b(fifteen|thirty|sixty)\b/,
                question: 'Which mode — 15s, 30s, or 60s?',
              },
            ];
            let pendingClarification = null;
            for (const rule of CLARIFICATION_RULES) {
              if (rule.pattern.test(_userTranscript)) continue;
              if (msg.toolCalls.some(c => c && c.function && rule.tools.includes(c.function.name))) {
                pendingClarification = rule.question;
                break;
              }
            }
            if (pendingClarification) {
              /* Push tool-result stubs so history stays well-formed
                 (every assistant tool_calls entry must be followed
                 by matching tool results). */
              for (const call of msg.toolCalls) {
                history.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({ ok: false, needs_clarification: true, ask_user: pendingClarification }),
                });
              }
              persistChat();
              pushVisible('assistant', pendingClarification);
              return;
            }

            const hasNav = msg.toolCalls.some(c => c && c.function && NAV_ACTIONS.has(c.function.name));
            /* Nav calls show an ack bubble instead of dots ("Sure,
               hold on…"). Data lookups (getMarketData etc.) need the
               dots BACK before the handler runs — network-bound
               handlers can take a second or two and an empty panel
               looks like nothing's happening. The dots will get
               removed again by the next stream's first content
               delta (or its end-of-stream cleanup). */
            if (hasNav) pushVisible('assistant', _pickAck());
            else typingEl = showTyping();

            let clarificationQuestion = null;
            for (const call of msg.toolCalls) {
              const handler = ACTION_HANDLERS[call.function && call.function.name];
              let result;
              try {
                const args = call.function && call.function.arguments
                  ? JSON.parse(call.function.arguments)
                  : {};
                result = handler
                  ? handler(args)
                  : { ok: false, message: 'unknown function: ' + (call.function && call.function.name) };
                if (result && typeof result.then === 'function') result = await result;
              } catch (e) {
                result = { ok: false, message: 'handler error: ' + String(e) };
              }
              history.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
              });
              if (result && result.needs_clarification && result.ask_user && !clarificationQuestion) {
                clarificationQuestion = result.ask_user;
              }
            }
            persistChat();

            /* Short-circuit: a handler asked for clarification.
               Show the question to the user and STOP the loop.
               This avoids the model re-calling the same tool with
               the same missing param in a retry loop (which burns
               Groq rate limit and produces 429s). The user's next
               message becomes a fresh turn with full context. */
            if (clarificationQuestion) {
              if (typingEl) typingEl.remove();
              pushVisible('assistant', clarificationQuestion);
              return;
            }
            continue;
          }

          /* Plain text reply — already rendered live by the
             streaming consumer (if streaming) or about to be
             rendered (if not). For streaming, msg.content is the
             FULL assembled text; we sanitise and push to history. */
          history.push({ role: 'assistant', content: msg.content });
          if (!STREAMING || !(resp.headers.get('content-type') || '').includes('event-stream')) {
            typingEl.remove();
            const cleaned = _cleanAssistantText(msg.content);
            pushVisible('assistant', cleaned || 'Sorry — I didn\'t quite catch that. Could you rephrase?');
          } else {
            /* Streaming already wrote the bubble; just commit to
               displayLog + persist. */
            displayLog.push({ role: 'assistant', text: _cleanAssistantText(msg.content) });
            persistChat();
          }
          return;
        }

        typingEl.remove();
        appendErrorWithRetry('I got stuck running tools. Retry?');
      } catch (e) {
        console.warn('AI concierge fetch failed', e);
        typingEl.remove();
        appendErrorWithRetry('Sorry — network error. Check your connection and retry.');
      }
    }

    /* Consume Groq's SSE stream. Replaces the typing dots with a
       live assistant bubble that grows as content tokens arrive.
       Accumulates tool_call fragments (arguments come as JSON-
       string deltas across multiple chunks) so the caller gets the
       fully-assembled calls back.

       Render is decoupled from network: Groq delivers ~500 tok/s
       which would land an entire short reply in one frame and look
       indistinguishable from non-streaming. A requestAnimationFrame
       typewriter advances the visible text at ~4 chars per 60fps
       frame (≈240 cps) so the streaming effect is actually visible
       while still being faster than anyone wants to read. */
    async function _consumeStream(resp, typingEl) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      const accumulatedCalls = []; // index → { id, type, function: { name, arguments } }
      let liveBubble = null;
      let typingRemoved = false;
      let streamEnded = false;
      let displayedLength = 0;
      let renderHandle = null;

      const CHARS_PER_FRAME = 4;

      function targetText() {
        return _cleanAssistantText(assistantText) || assistantText;
      }

      function tick() {
        if (!liveBubble) { renderHandle = null; return; }
        const full = targetText();
        if (displayedLength > full.length) displayedLength = full.length;
        if (displayedLength < full.length) {
          displayedLength = Math.min(full.length, displayedLength + CHARS_PER_FRAME);
          liveBubble.textContent = full.slice(0, displayedLength);
          _scrollToBottom();
        }
        if (displayedLength < full.length || !streamEnded) {
          renderHandle = requestAnimationFrame(tick);
        } else {
          renderHandle = null;
        }
      }
      function ensureTicking() {
        if (renderHandle == null) renderHandle = requestAnimationFrame(tick);
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch (_) { continue; }
          const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (!delta) continue;

          if (typeof delta.content === 'string' && delta.content) {
            if (!liveBubble) {
              typingEl.remove();
              typingRemoved = true;
              liveBubble = appendMessage('assistant', '');
            }
            assistantText += delta.content;
            ensureTicking();
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!accumulatedCalls[idx]) {
                accumulatedCalls[idx] = {
                  id: tc.id || 'call_' + idx,
                  type: tc.type || 'function',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id) accumulatedCalls[idx].id = tc.id;
              if (tc.function) {
                if (tc.function.name) accumulatedCalls[idx].function.name += tc.function.name;
                if (tc.function.arguments) accumulatedCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }

      streamEnded = true;
      /* Wait for the typewriter to catch up before returning so the
         visible bubble matches what we commit to history + before
         any follow-up tool round shows new typing dots. 5s safety
         cap so a bug here can't hang the chat. */
      if (liveBubble) {
        await new Promise(resolve => {
          const start = Date.now();
          (function check() {
            if (renderHandle == null) return resolve();
            if (Date.now() - start > 5000) return resolve();
            setTimeout(check, 30);
          })();
        });
      }

      /* If we created a live bubble but the stream ended with empty
         text (all the model produced was tool_calls + maybe blank
         content), drop the empty bubble — the caller will render
         either the ack (nav) or nothing (lookup). */
      if (liveBubble && !assistantText.trim()) liveBubble.remove();
      /* If we never removed the typing dots (no content streamed
         at all, only tool_calls), remove now so the caller can
         re-show typing after tool execution. */
      if (!typingRemoved) typingEl.remove();

      return {
        content: assistantText,
        toolCalls: accumulatedCalls.filter(Boolean),
      };
    }

    function send() {
      const text = input.value.trim();
      if (!text) return;
      if (!conversationStarted) {
        messages.innerHTML = '';
        conversationStarted = true;
      }
      pushVisible('user', text);
      input.value = '';
      autoGrow();
      chat(text);
    }
    sendBtn.addEventListener('click', send);
  }

  function injectMarkup() {
    const btn = document.createElement('button');
    btn.className = 'concierge-btn';
    btn.id = 'conciergeBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open AI Concierge');
    btn.setAttribute('title', 'AI Concierge');
    btn.style.display = 'none';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
      '</svg>';
    document.body.appendChild(btn);

    const panel = document.createElement('aside');
    panel.className = 'concierge-panel';
    panel.id = 'conciergePanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'conciergeTitle');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="concierge-header">' +
        '<h2 class="concierge-title" id="conciergeTitle">AI Concierge</h2>' +
        '<button class="concierge-close" id="conciergeClose" type="button" ' +
                'aria-label="Close concierge">×</button>' +
      '</div>' +
      '<div class="concierge-messages" id="conciergeMessages"></div>' +
      '<div class="concierge-input-row">' +
        '<textarea class="concierge-input" id="conciergeInput" ' +
                  'placeholder="Ask me to open a tool or report…" ' +
                  'rows="1" aria-label="Message"></textarea>' +
        '<button class="concierge-send" id="conciergeSend" type="button" ' +
                'aria-label="Send message" title="Send (Enter)">→</button>' +
      '</div>' +
      '<div class="concierge-disclaimer" role="note">' +
        '<span class="concierge-disclaimer-icon" aria-hidden="true">⚠️</span>' +
        '<span class="concierge-disclaimer-text">' +
          'Avoid pasting sensitive info — client data, contracts, ' +
          'credentials, or anything identifying a real person. ' +
          'Chats are processed by Groq (US).' +
        '</span>' +
      '</div>';
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
