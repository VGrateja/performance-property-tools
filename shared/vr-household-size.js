/* =============================================================================
   vr-household-size.js — ONE SOURCED AVERAGE HOUSEHOLD SIZE PER VR MARKET.

   The vacancy-rate model divides population by this number to get households,
   and households drive the property base, the surplus and both forecast years.
   It used to be the VR Projections workbook's ROUNDED ASSUMPTION — Melbourne
   2.6, Sydney 2.7, Rockingham 2.0 — captioned "ABS Census" in the tool even
   though no Census publishes 2.0 for Rockingham. Kia, 2026-08-26: "update the
   household sizes to be more accurate". This file is that update: one official
   projection for 2026 per market, with the publisher, vintage, geography and
   URL beside it so the number can always be traced back.

   Consumed by scripts/build-vr-demand.mjs --canonical, which writes `value`
   into payload.hhSize and `source` into payload.hhSizeSource, and re-derives
   households = population / hhSize and properties = households / (1 - VR).
   The VR Projection tool and the Buying/Selling VR slide read hhSizeSource off
   the payload for their caption, so the label always travels with the figure.

   ── SOURCE HIERARCHY (the rule that picked each row) ─────────────────────────
   1  CAPITALS + AUSTRALIA -> ABS, Household and Family Projections, Australia,
      2021-2046 (cat. 3236.0, released 28 June 2024). Verified 2026-08-26 to
      publish Greater Capital City level: dataflow ABS_HH_PROV has exactly 26
      regions — Australia, 8 states, 8 GCCSAs, 7 rest-of-states and Other
      Territories. NO SA4/SA3/LGA, despite the dimension being named
      ASGS_2011_STATE_GCCSA_SA4_SA3_SA2. That is why regional markets cannot
      use ABS and fall to rank 2.
   2  REGIONAL MARKETS -> the state government's own LGA projection, because
      every regional market in this model IS exactly one LGA (see the REGIONAL
      map in scripts/ingest-abs-population.mjs, which is where the population
      these figures divide comes from).
   3  ABS Census 2021 -> fallback only. Published to ONE DECIMAL, so it is no
      better than the assumption it would replace. Not used by any row here;
      the exact Census ratio is carried as `census2021` for cross-checking.

   ── GEOGRAPHY: EVERY ROW MATCHES ITS OWN POPULATION ──────────────────────────
   Capitals: Greater Capital City (GCCSA) — the same basis as the stored
   population (ingest-abs-population.mjs keeps the SUA figure separately as
   population_sua; the capitals' `population` is GCCSA).
   Regionals: the market's single LGA. Never a broader region — the VIC LGA
   workbook exists precisely so Ballarat is not read off Central Highlands
   (2.297 vs 2.362, a 2.9% error) or Mildura off Mallee (2.368 vs 2.325).

   ── DEFINITIONAL CAVEAT, DELIBERATE AND UNCHANGED ────────────────────────────
   Every publisher defines average household size on PRIVATE DWELLINGS:
   persons living in occupied private dwellings / households. The VR model
   divides TOTAL population (ERP) by it, which treats the ~1-2% of people in
   non-private dwellings — hospitals, prisons, halls of residence, hotels — as
   if they formed households. So `households` sits ~1-2% above the source's own
   household count. THIS IS THE MODEL'S PRE-EXISTING CONVENTION and it is not
   changed here; only the divisor got more accurate. `erpBasis` on each row is
   what the figure would be on the model's own total-ERP basis, so the size of
   the gap is visible per market and switching convention later is a data
   change rather than a research job.

   ── PRECISION ────────────────────────────────────────────────────────────────
   `value` is rounded to 3 decimals — exactly what the tool and the slides
   print — so anyone can reproduce the stored household count from the number
   on screen. `exact` keeps the unrounded published/derived ratio.

   ── MAINTENANCE ──────────────────────────────────────────────────────────────
   Revisit when a publisher issues a new vintage (ABS 3236.0 is 2021-based and
   due to be re-based after the 2026 Census; VIF, QGSO, WA Tomorrow and the NSW
   projections each run on their own cycle). Change a value here, then
   `node scripts/build-vr-demand.mjs --canonical --write`. That same command is
   the recovery if a `build-vr-forecast.mjs --write` ever puts the workbook's
   rounded assumption back — it reads hhSize from the xlsx "median hh size"
   column and does not know about this file.
   ============================================================================= */
(function (root) {
  'use strict';

  /* Publishers, spelled out once so each row stays readable. */
  const ABS = {
    publisher: 'Australian Bureau of Statistics',
    publication: 'Household and Family Projections, Australia, 2021-2046 (cat. 3236.0), released 28 June 2024 — Series II',
    url: 'https://www.abs.gov.au/statistics/people/population/household-and-family-projections-australia/latest-release',
    basis: 'projected persons in private dwellings (total projected persons less usual residents of non-private dwellings) / projected total households, Series II. Read 2026-08-26 from dataflows ABS_HH_PROV 1.0.0 (HH_TYPE=4, PROJ_SERIES=2) and ABS_PERSONS_PROJ 1.1.0 (AGE=TT, PERSON_LA=16 and 15) on data.api.abs.gov.au. Series II and Series III are identical at 2026; Series I is the low bound.',
  };
  const VIF = {
    publisher: 'Victorian Department of Transport and Planning',
    publication: 'Victoria in Future 2023, Second Release (December 2023) — LGA projections to 2036',
    url: 'https://www.planning.vic.gov.au/guides-and-resources/data-and-insights/victoria-in-future',
    basis: 'published "Average household size (HHS)" = POPD (persons in occupied private dwellings) / OPD (occupied private dwellings), Dwellings_and_Households sheet, 2026 column. Base ERP 30 June 2022. Release 2 carries full precision; Release 1 rounds HHS to 1 decimal and must not be used.',
  };
  /* QUEENSLAND IS THE ONE DERIVED SOURCE IN THIS FILE — read this before
     quoting a Queensland figure. QGSO publishes projected HOUSEHOLDS by LGA
     and projected ERP by LGA, but NOT average household size, and its only
     published per-dwelling LGA ratio is the OCCUPANCY RATE, which puts VACANT
     dwellings in the denominator and so runs 0.03-0.14 BELOW household size
     (worst on Gold Coast and Sunshine Coast, exactly where the holiday stock
     is). Occupancy rate is therefore NOT a substitute and is not used here.
     What is used: household size = ERP x (1 - non-private-dwelling share) /
     households, with the NPD share taken from QGSO's living-arrangement table
     at SA4/GCCSA level — the finest geography QGSO publishes it on. Every
     input is official; only the last division is ours.
     Sensitivity: roughly +/-0.03 in household size per +/-1pp in the NPD share.
     Validated at state level, where QGSO publishes both sides directly:
     Queensland 2026 = (5,663,247 - 89,919) / 2,239,205 = 2.489, and the same
     method reproduces the 2021 base at 2.513 against an ABS Census exact
     2.536 — the ~0.02 gap is structural (QGSO grosses households up to ERP
     consistency faster than persons) and shows up consistently per LGA too.
     MAINTENANCE FLAG: the 2023-edition LGA household file has been WITHDRAWN
     from the live QGSO site — the page now says a 2025 edition is due later in
     2026 — so the figures below were read from the Internet Archive copy. The
     2025-edition dwelling file already on the live site implies materially
     higher ERP (Bundaberg 2026 at 108,447 vs the 2023 edition's 103,553), so
     expect these to move when QGSO publishes the 2025-edition households. */
  const QLD = {
    publisher: 'Queensland Government Statistician\'s Office',
    publication: 'Queensland Government population and household projections, 2023 edition (2021-based), medium series — LGA',
    url: 'https://www.qgso.qld.gov.au/statistics/theme/population/population-projections/regions',
    basis: 'DERIVED, not published: ERP x (1 - non-private-dwelling share) / households. Households from "projected-households-medium-series-household-type-lga-qld-2021-2046.xlsx" (issue 2986), ERP from "qld-population-projections-regions-reports-lga-snapshot-2023-edn.xlsx" (issue 5276), NPD share from "projected-population-series-living-arrangement-sa4-qld-2021-2046.xlsx" (issue 2711) at SA4/GCCSA level. Both LGA files were withdrawn from the live site and were read from the Internet Archive (snapshots 2023-11-07 / 2023-11-19). QGSO publishes no LGA household-size series; its LGA "occupancy rate" includes vacant dwellings and is not one.',
  };
  /* WESTERN AUSTRALIA — WA Tomorrow, and the reason only ONE WA market uses it.
     WA Tomorrow's CURRENT release (Report No. 12) and Report No. 11 are
     POPULATION ONLY — neither contains the word "household". The only WA
     household/average-household-size publication that has ever existed is
     Report No. 8 (WAPC, July 2012), built on 2006 Census living-arrangement
     propensities, which happens to terminate exactly at 2026.
     A 2012 projection has to earn its place, so each WA market was tested
     against the one hard fact available: does Report No. 8's own 2021 value
     land within 0.10 of ABS's published Census 2021 average household size?
         Rockingham   2.57 vs 2.6   -0.03   PASS -> used below
         Mandurah     2.28 vs 2.4   -0.12   FAIL -> left unchanged
         Bunbury      2.38 vs 2.2   +0.18   FAIL -> left unchanged
     Only Rockingham's household-size model is still calibrated, so only
     Rockingham takes a Report No. 8 figure. Note the test is deliberately run
     against ABS's PUBLISHED figure rather than a Census ratio computed from
     dwelling counts — see the census2021 note below for why those two are not
     the same statistic. Report No. 8's population forecasts have drifted badly
     (its 2026 figures overshoot the current ERP by 9% at Bunbury, 22% at
     Mandurah, 8% at Rockingham), but the model consumes the RATIO, not the
     level, and the ratio is the far more stable of the two. */
  const WAT = {
    publisher: 'Western Australian Planning Commission / Department of Planning',
    publication: 'WA Tomorrow, Population Report No. 8 (2006 to 2026): Household Forecasts for all Local Government Authorities in WA, July 2012 — Band C (median)',
    url: 'https://www.wa.gov.au/government/document-collections/wa-tomorrow-12-population-forecast-data-tables',
    basis: 'published average household size, Band C (the median band, per Report No. 11 p.6) = persons in households / households, where households are family + group + lone-person private households and non-private-dwelling residents are excluded from the numerator. 2026 is the report\'s terminal year, so nothing is interpolated. VINTAGE WARNING: published 2012 on 2006 Census propensities, and it is the ONLY WA household publication — Reports No. 11 and No. 12 dropped households entirely. Delisted from wa.gov.au; read from the Internet Archive copy of Household_Forecasts_July_2012.pdf (Table 1) and its companion Household_Projections_.xls. This is the row in this file most in need of a refresh.',
  };
  const NSW = {
    publisher: 'NSW Department of Planning, Housing and Infrastructure (published as DPE)',
    publication: '2022 NSW Population, Household and Implied Dwelling Demand Projections — LGAs (ASGS 2020)',
    url: 'https://data.nsw.gov.au/data/dataset/2022-nsw-population-projections',
    basis: 'published "Average Household Size for Projected Households (persons per household)" sheet, 2026 column = population in private dwellings / households. VINTAGE NOTE: the newer 2024 release does NOT publish households or household size at all — it carries population, age/sex and (Regional NSW only) implied dwelling demand, which is households PLUS an unoccupied-dwelling allowance and so cannot be used as a denominator. The 2022 release is therefore the most recent official NSW household-size projection, and is what is used here.',
  };

  /* value    : the figure the model uses and the tools print (3 dp)
     exact    : the unrounded published or derived ratio
     erpBasis : the same market on the model's own total-ERP basis, for the
                private-dwelling caveat above (null where not derivable)
     census2021 : ABS Census 2021 cross-check. NEVER USED by the model — it is
                here so a projection that has drifted somewhere strange is
                visible. For the 28 regional LGAs it is the exact ratio from
                Census table G36 (persons in occupied private dwellings /
                occupied private dwellings, ABS Data API C21_G36_LGA); for the
                capitals it is ABS's published figure, which is 1 dp. NOTE the
                two are not quite the same statistic: G36's denominator counts
                every occupied private dwelling including visitor-only and
                non-classifiable ones, so its ratio runs slightly BELOW ABS's
                published "average household size" (table G02) — most visibly
                in holiday markets, e.g. Mandurah G36 2.309 against a published
                2.4. Compare like with like before drawing a conclusion. */
  const VR_HOUSEHOLD_SIZE = {

    /* ── AUSTRALIA + THE EIGHT CAPITALS — ABS 3236.0, GCCSA ──────────────────
       All nine on one publisher, one method, one vintage. That matters more
       than it looks: the product compares capitals with each other constantly
       (the Buying/Selling peer rule sends every capital to Sydney), so a
       divisor sourced differently for one capital would put a methodological
       step into exactly the comparison the slide is making. */
    australia: { value: 2.528, exact: 2.528434, erpBasis: 2.576938,
      geography: 'Australia', source: 'ABS 3236.0 · Australia 2026', year: 2026, census2021: 2.5, ...ABS },
    sydney: { value: 2.656, exact: 2.655585, erpBasis: 2.690666,
      geography: 'Greater Sydney (GCCSA 1GSYD)', source: 'ABS 3236.0 · Greater Sydney 2026', year: 2026, census2021: 2.7, ...ABS },

    /* MELBOURNE — ABS 2.590, NOT VIF's 2.564. THE ONE JUDGEMENT CALL IN THIS
       FILE, so the reasoning is recorded rather than left implicit.
       Victoria in Future 2023 R2 puts Metro Melbourne 2026 at 2.5638 and is the
       fresher base (ERP 30 June 2022 vs ABS's 2021), which is a real point in
       its favour — VIF's own 2026 ERP for Metro Melbourne, 5,444,516, lands
       0.16% from the actual we hold, where ABS's 5,481,049 is 0.84% out.
       ABS wins anyway on the two things that matter more here:
         GEOGRAPHY — ABS is Greater Melbourne GCCSA exactly, which is the
           geography of the population it divides. VIF's "Metro Melbourne" is
           the metropolitan LGAs and only approximates the GCCSA.
         CONSISTENCY — the other seven capitals have no state equivalent of
           comparable standing, so they are all ABS. Melbourne on VIF alone
           would bake a ~1% publisher step into every Melbourne-vs-Sydney
           comparison the product draws.
       The capital/regional publisher split is unavoidable (ABS publishes no
       LGA household projection at all), but the capital-to-capital set can be
       kept clean, and is.
       TO SWITCH TO VIF: value 2.564, exact 2.563824, geography 'Metro
       Melbourne (VIF2023 metropolitan regions)', source 'VIF2023 · Metro
       Melbourne 2026', spread ...VIF — then rebuild. It moves Melbourne's
       households by about +21,300 and tightens its forecast. */
    melbourne: { value: 2.590, exact: 2.589893, erpBasis: 2.628274,
      geography: 'Greater Melbourne (GCCSA 2GMEL)', source: 'ABS 3236.0 · Greater Melbourne 2026', year: 2026, census2021: 2.6,
      alternative: { value: 2.564, exact: 2.563824, source: 'VIF2023 · Metro Melbourne 2026', note: 'Victoria in Future 2023 R2, Dwellings_and_Households, Metro Melbourne: POPD 5,372,777 / OPD 2,095,590. Not used — see the comment above.' },
      ...ABS },

    brisbane: { value: 2.590, exact: 2.590061, erpBasis: 2.637631,
      geography: 'Greater Brisbane (GCCSA 3GBRI)', source: 'ABS 3236.0 · Greater Brisbane 2026', year: 2026, census2021: 2.6, ...ABS },
    adelaide: { value: 2.453, exact: 2.452741, erpBasis: 2.493944,
      geography: 'Greater Adelaide (GCCSA 4GADE)', source: 'ABS 3236.0 · Greater Adelaide 2026', year: 2026, census2021: 2.5, ...ABS },
    perth: { value: 2.583, exact: 2.583262, erpBasis: 2.624256,
      geography: 'Greater Perth (GCCSA 5GPER)', source: 'ABS 3236.0 · Greater Perth 2026', year: 2026, census2021: 2.6, ...ABS },
    hobart: { value: 2.421, exact: 2.420845, erpBasis: 2.473777,
      geography: 'Greater Hobart (GCCSA 6GHOB)', source: 'ABS 3236.0 · Greater Hobart 2026', year: 2026, census2021: 2.4, ...ABS },
    /* Darwin is the biggest single move in this file (2.6 -> 2.763). It is not
       an error: Greater Darwin has an unusually large non-private-dwelling and
       mobile population, so the ERP-based projection sits well above the
       Census-night count. ABS's own 2021 base for Darwin is 2.722 against a
       2.6 Census figure, i.e. the gap predates 2026 and is structural. */
    darwin: { value: 2.763, exact: 2.762553, erpBasis: 2.852974,
      geography: 'Greater Darwin (GCCSA 7GDAR)', source: 'ABS 3236.0 · Greater Darwin 2026', year: 2026, census2021: 2.6, ...ABS },
    /* The ACT has no capital-city / rest-of-state split in the ASGS, so ABS
       region 8ACTE returns values identical to the state. GCCSA and state are
       the same geography here — this is not a rest-of-state substitution. */
    canberra: { value: 2.486, exact: 2.486324, erpBasis: 2.545764,
      geography: 'Australian Capital Territory (GCCSA 8ACTE — identical to the state; the ACT has no capital/rest-of-state split)',
      source: 'ABS 3236.0 · ACT 2026', year: 2026, census2021: 2.5, ...ABS },

    /* ── VICTORIA — Victoria in Future 2023 R2, LGA workbook ────────────────
       Audited: summing the constituent LGAs' POPD and OPD and re-dividing
       reproduces the Regional Partnership figures in the Regions workbook to
       4 dp for Barwon, Central Highlands, Loddon Campaspe, Mallee and Ovens
       Murray — same release, same geography definitions, same method. */
    ballarat: { value: 2.297, exact: 2.2967, erpBasis: 2.345,
      geography: 'Ballarat (C) — LGA 20570', source: 'VIF2023 · Ballarat (C) 2026', year: 2026, census2021: 2.3647, ...VIF },
    bendigo: { value: 2.368, exact: 2.3675, erpBasis: 2.4035,
      geography: 'Greater Bendigo (C) — LGA 22620', source: 'VIF2023 · Greater Bendigo (C) 2026', year: 2026, census2021: 2.4128, ...VIF },
    geelong: { value: 2.380, exact: 2.3797, erpBasis: 2.4336,
      geography: 'Greater Geelong (C) — LGA 22750', source: 'VIF2023 · Greater Geelong (C) 2026', year: 2026, census2021: 2.4226, ...VIF },
    mildura: { value: 2.368, exact: 2.3678, erpBasis: 2.3979,
      geography: 'Mildura (RC) — LGA 24780', source: 'VIF2023 · Mildura (RC) 2026', year: 2026, census2021: 2.4309, ...VIF },
    wodonga: { value: 2.355, exact: 2.3554, erpBasis: 2.4184,
      geography: 'Wodonga (C) — LGA 27170', source: 'VIF2023 · Wodonga (C) 2026', year: 2026, census2021: 2.4357, ...VIF },

    /* ── NEW SOUTH WALES — 2022 DPE LGA projections ─────────────────────────
       See the vintage note on NSW above: the 2024 release dropped households
       entirely, so this is the current official household-size projection. */
    albury: { value: 2.269, exact: 2.269, erpBasis: 2.328,
      geography: 'Albury (C) — LGA 10050', source: 'NSW DPHI 2022 · Albury 2026', year: 2026, census2021: 2.3334, ...NSW },
    'central-coast': { value: 2.449, exact: 2.449, erpBasis: 2.487,
      geography: 'Central Coast (C) (NSW) — LGA 11650', source: 'NSW DPHI 2022 · Central Coast 2026', year: 2026, census2021: 2.4762, ...NSW },
    'coffs-harbour': { value: 2.377, exact: 2.377, erpBasis: 2.422,
      geography: 'Coffs Harbour (C) — LGA 11800', source: 'NSW DPHI 2022 · Coffs Harbour 2026', year: 2026, census2021: 2.4556, ...NSW },
    newcastle: { value: 2.332, exact: 2.332, erpBasis: 2.396,
      geography: 'Newcastle (C) — LGA 15900 (the Newcastle LGA, not Newcastle-Maitland)', source: 'NSW DPHI 2022 · Newcastle 2026', year: 2026, census2021: 2.3609, ...NSW },
    orange: { value: 2.366, exact: 2.366, erpBasis: 2.437,
      geography: 'Orange (C) — LGA 16150', source: 'NSW DPHI 2022 · Orange 2026', year: 2026, census2021: 2.4779, ...NSW },
    'port-macquarie': { value: 2.241, exact: 2.241, erpBasis: 2.282,
      geography: 'Port Macquarie-Hastings (A) — LGA 16380', source: 'NSW DPHI 2022 · Port Macquarie-Hastings 2026', year: 2026, census2021: 2.3336, ...NSW },
    tamworth: { value: 2.388, exact: 2.388, erpBasis: 2.446,
      geography: 'Tamworth Regional (A) — LGA 17310', source: 'NSW DPHI 2022 · Tamworth Regional 2026', year: 2026, census2021: 2.4508, ...NSW },
    'wagga-wagga': { value: 2.405, exact: 2.405, erpBasis: 2.494,
      geography: 'Wagga Wagga (C) — LGA 17750', source: 'NSW DPHI 2022 · Wagga Wagga 2026', year: 2026, census2021: 2.4989, ...NSW },
    wollongong: { value: 2.478, exact: 2.478, erpBasis: 2.532,
      geography: 'Wollongong (C) — LGA 18450', source: 'NSW DPHI 2022 · Wollongong 2026', year: 2026, census2021: 2.5065, ...NSW },

    /* ── QUEENSLAND — QGSO 2023 edition, medium series, LGA (DERIVED) ───────
       See the QLD block above for the derivation and its caveats. Ipswich sits
       inside Greater Brisbane GCCSA but is modelled here as its own LGA, which
       is also how its population is sourced — so its 2.669 is the Ipswich LGA
       figure, not Greater Brisbane's 2.590. */
    bundaberg: { value: 2.281, exact: 2.281, erpBasis: 2.313,
      geography: 'Bundaberg (R) — LGA 31820', source: 'QGSO 2023 · Bundaberg 2026', year: 2026, census2021: 2.3649, ...QLD },
    cairns: { value: 2.419, exact: 2.419, erpBasis: 2.452,
      geography: 'Cairns (R) — LGA 32080', source: 'QGSO 2023 · Cairns 2026', year: 2026, census2021: 2.4641, ...QLD },
    gladstone: { value: 2.383, exact: 2.383, erpBasis: 2.436,
      geography: 'Gladstone (R) — LGA 33360', source: 'QGSO 2023 · Gladstone 2026', year: 2026, census2021: 2.5032, ...QLD },
    'gold-coast': { value: 2.485, exact: 2.485, erpBasis: 2.513,
      geography: 'Gold Coast (C) — LGA 33430', source: 'QGSO 2023 · Gold Coast 2026', year: 2026, census2021: 2.5308, ...QLD },
    ipswich: { value: 2.669, exact: 2.669, erpBasis: 2.707,
      geography: 'Ipswich (C) — LGA 33960 (its own LGA, not Greater Brisbane)', source: 'QGSO 2023 · Ipswich 2026', year: 2026, census2021: 2.7480, ...QLD },
    mackay: { value: 2.384, exact: 2.384, erpBasis: 2.450,
      geography: 'Mackay (R) — LGA 34770', source: 'QGSO 2023 · Mackay 2026', year: 2026, census2021: 2.5163, ...QLD },
    rockhampton: { value: 2.395, exact: 2.395, erpBasis: 2.449,
      geography: 'Rockhampton (R) — LGA 36370', source: 'QGSO 2023 · Rockhampton 2026', year: 2026, census2021: 2.4581, ...QLD },
    'sunshine-coast': { value: 2.440, exact: 2.440, erpBasis: 2.472,
      geography: 'Sunshine Coast (R) — LGA 36720', source: 'QGSO 2023 · Sunshine Coast 2026', year: 2026, census2021: 2.4836, ...QLD },
    toowoomba: { value: 2.399, exact: 2.399, erpBasis: 2.457,
      geography: 'Toowoomba (R) — LGA 36910', source: 'QGSO 2023 · Toowoomba 2026', year: 2026, census2021: 2.4592, ...QLD },
    townsville: { value: 2.438, exact: 2.438, erpBasis: 2.499,
      geography: 'Townsville (C) — LGA 37010', source: 'QGSO 2023 · Townsville 2026', year: 2026, census2021: 2.4763, ...QLD },

    /* ── WESTERN AUSTRALIA — one market only; see the WAT block above ───────
       Rockingham replaces a stored 2.0, which was not a household size at all:
       WA Tomorrow says 2.55, ABS Census 2021 says 2.6, and Rockingham's whole
       Band C series runs 2.67 (2006) down to 2.55 (2026) without ever going
       near 2.0. Treat the old value as a data-entry error, now corrected. */
    rockingham: { value: 2.55, exact: 2.55, erpBasis: null,
      geography: 'Rockingham (C) — LGA 57490', source: 'WA Tomorrow No. 8 · Rockingham 2026 (Band C)', year: 2026, census2021: 2.5721, ...WAT },

  };

  /* ── DELIBERATELY NOT IN THE TABLE ────────────────────────────────────────
     Three markets keep the VR Projections workbook's assumption because no
     source beat it. They are listed here so a later maintainer can see they
     were researched and rejected, not simply missed. Absent from the table,
     they keep their stored hhSize and their "ABS Census" caption — which, at
     one decimal, is roughly what the stored figure has always been.

     bunbury    2.4 kept. WA Tomorrow No. 8 (the only WA household source) puts
                2026 at 2.35, but its 2021 value of 2.38 overshoots ABS's
                published Census 2021 figure of 2.2 by 0.18 — it has drifted
                off this market. The Census ratio itself (2.188) cannot be
                substituted: it is a COUNT-based ratio, and dividing our
                ERP-based population by it would overstate Bunbury's households
                by roughly 17%. Nothing here is better than what is stored.
     mandurah   2.4 kept. WA Tomorrow No. 8 puts 2026 at 2.24, but its 2021
                value of 2.28 undershoots ABS's published 2.4 by 0.12, and a
                fall from 2.4 to 2.24 in five years is far faster than any
                observed trend. ABS's published Census 2021 figure IS 2.4 —
                exactly the stored value — so there is nothing to change.
     launceston 2.4 kept. Tasmania has no government household projection at
                all: Treasury's TasPOPP 2024, 2019 and 2014 releases are
                population-only. The one 2026 figure in existence is 2.37, from
                a REMPLAN study for the Northern Tasmania Development
                Corporation that the State Planning Office adopted in its NTRLUS
                State of Play Report (March 2025) — but it is measured as total
                population / occupied dwellings, an ERP basis rather than the
                private-dwelling basis every other row uses, and it lands within
                0.03 of the stored value regardless. Not a good enough reason,
                on an inconsistent basis, to move the number.

     Any of the three becomes a one-line addition the moment a current source
     appears: WA Tomorrow reinstating households, or a Tasmanian Treasury
     household projection, would each settle a market immediately. */
  const VR_HOUSEHOLD_SIZE_UNCHANGED = {
    bunbury: 'WA Tomorrow No. 8 fails its 2021 check (+0.18 vs ABS Census 2.2); Census ratio is count-based and not usable against ERP. Workbook assumption 2.4 retained.',
    mandurah: 'WA Tomorrow No. 8 fails its 2021 check (-0.12 vs ABS Census 2.4); ABS published Census 2021 equals the stored 2.4. Workbook assumption 2.4 retained.',
    launceston: 'No Tasmanian government household projection exists (TasPOPP is population-only). The only 2026 figure, REMPLAN 2.37, is on a total-population basis and within 0.03 anyway. Workbook assumption 2.4 retained.',
  };

  root.VrHouseholdSize = { VR_HOUSEHOLD_SIZE, VR_HOUSEHOLD_SIZE_UNCHANGED };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
