// =============================================================================
// sqm-regions.mjs — shared region → SQM query-string map for the Demand Score
// SQM ingests (weekly rents + vacancy rates). Both endpoints take the same
// params, so this is the single source of truth for the 36 demand-score regions
// + National. Build a URL as:
//   `https://sqmresearch.com.au/property/${path}?${qs}`
//   path = 'weekly-rents' | 'vacancy-rates'
// (query styles are the user's curated searches — region / postcode / type=r).
// =============================================================================
export const SQM_REGIONS = [
  { slug: 'adelaide',       qs: 'region=sa-Adelaide&type=c' },
  { slug: 'albury',         qs: 'postcode=2640' },
  { slug: 'ballarat',       qs: 'postcode=3350' },
  { slug: 'bendigo',        qs: 'postcode=3550' },
  { slug: 'brisbane',       qs: 'region=qld-Brisbane&type=c' },
  { slug: 'bunbury',        qs: 'postcode=6230' },
  { slug: 'bundaberg',      qs: 'postcode=4670' },
  { slug: 'cairns',         qs: 'type=r&region=QLD-Cairns' },
  { slug: 'canberra',       qs: 'region=act-Canberra&type=c' },
  { slug: 'central-coast',  qs: 'type=r&region=NSW-Central+Coast' },
  { slug: 'coffs-harbour',  qs: 'postcode=2450' },
  { slug: 'darwin',         qs: 'region=nt-Darwin&type=c' },
  { slug: 'geelong',        qs: 'postcode=3220' },
  { slug: 'gladstone',      qs: 'postcode=4680' },
  { slug: 'gold-coast',     qs: 'type=r&region=QLD-Gold+Coast' },
  { slug: 'perth',          qs: 'region=wa-Perth&type=c' },
  { slug: 'sydney',         qs: 'region=nsw-Sydney&type=c' },
  { slug: 'hobart',         qs: 'region=tas-Hobart&type=c' },
  { slug: 'ipswich',        qs: 'type=r&region=QLD-Ipswich' },
  { slug: 'launceston',     qs: 'postcode=7250' },
  { slug: 'mackay',         qs: 'postcode=4740' },
  { slug: 'mandurah',       qs: 'postcode=6210' },
  { slug: 'melbourne',      qs: 'region=vic-Melbourne&type=c' },
  { slug: 'mildura',        qs: 'postcode=3500' },
  { slug: 'australia',      qs: 'national=1' },
  { slug: 'newcastle',      qs: 'postcode=2300' },
  { slug: 'orange',         qs: 'postcode=2800' },
  { slug: 'port-macquarie', qs: 'postcode=2444' },
  { slug: 'rockhampton',    qs: 'postcode=4700' },
  { slug: 'rockingham',     qs: 'postcode=6168' },
  { slug: 'sunshine-coast', qs: 'type=r&region=QLD-Sunshine+Coast' },
  { slug: 'tamworth',       qs: 'type=r&region=NSW-Tamworth' },
  { slug: 'toowoomba',      qs: 'type=r&region=QLD-Toowoomba' },
  { slug: 'townsville',     qs: 'postcode=4810' },
  { slug: 'wagga-wagga',    qs: 'postcode=2650&hu=1' },
  { slug: 'wodonga',        qs: 'postcode=3690' },
  { slug: 'wollongong',     qs: 'postcode=2500' },
];

export const SQM_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
export const sqmUrl = (path, qs) => `https://sqmresearch.com.au/property/${path}?${qs}`;
