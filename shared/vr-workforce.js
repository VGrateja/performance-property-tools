/* =============================================================================
   vr-workforce.js — INFRASTRUCTURE WORKFORCE MODIFIER. Manual input, quarterly.

   The ONE input in the vacancy-rate model with no automated feed anywhere. It
   is compiled by hand from major-project workforce schedules and covers only
   the markets with material project pipelines. Everything else in the model
   (population, household size, vacancy rates, commencements, NI/IM/OM) comes
   from Forge — do not add anything here that Forge carries.

   y1 / y2 = extra PEOPLE expected in the market from project workforces in
   forecast year 1 and year 2. They are converted to households at the region's
   average household size, exactly like any other incoming people.

   NOT A DOUBLE COUNT. The source workbook's IM tab holds G = E + WF; the
   pipeline stores column E, the WF-free base. Verified on live payloads:
   Perth 12,144 · Townsville 412 · Mackay 398 · Darwin -2,055 all equal the
   split base, so ADDING these numbers reproduces G. Anyone re-wiring the IM
   feed must keep pulling column E — pulling the combined G and adding this
   table would count the workforce twice.

   The 1.0 multiplier is an OPEN ASSUMPTION: no local-hire, FIFO or
   camp-accommodation discount is applied, so every project worker is treated
   as a new resident forming a household at the region's average size. That is
   tolerable while this is a manual side-input but becomes far more visible now
   the demand side is automated. Calibration path: QGSO non-resident population.

   To update: edit the numbers, bump REVIEWED, commit. A market with no entry
   disables the workforce toggle rather than silently applying zero.

   Dual-use: loaded as a <script> in the browser (globalThis.VrWorkforce) and
   imported by scripts/build-vr-demand.mjs, so the tool and the seeder can
   never drift apart.
   ============================================================================= */
(function (root) {
  'use strict';

  const REVIEWED = 'August 2026';

  const TABLE = {
    perth:       { y1: 286,        y2: 958.285714 },
    townsville:  { y1: 1805,       y2: 942 },
    rockingham:  { y1: 254.28,     y2: 257.14 },
    darwin:      { y1: 819.123809, y2: 239.2 },
    mackay:      { y1: 2142.4,     y2: 240.933333 },
    mandurah:    { y1: 169.26,     y2: 169.26 },
    rockhampton: { y1: 120,        y2: 82.5 },
    gladstone:   { y1: 26.25,      y2: 168.075 },
  };

  const forRegion = slug => TABLE[slug] || null;
  const markets = () => Object.keys(TABLE);

  root.VrWorkforce = { TABLE, REVIEWED, forRegion, markets };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
