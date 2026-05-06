/* ─────────────────────────────────────────────────────────────────────
   PPA Online Reports — Chart theme
   ---------------------------------------------------------------------
   Single source of truth for colours, fonts, and palette tokens used by
   every chart module. To re-skin every report, edit this file only.

   Usage from a chart module:
     const T = window.PpaCharts.theme;
     lineStyle: { color: T.colors.house }
   ───────────────────────────────────────────────────────────────────── */
window.PpaCharts = window.PpaCharts || {};

window.PpaCharts.theme = {
  colors: {
    /* Series colours — matched to the reference Looker PDF.
       `house` / `unit` are the LINE colours (deep navy / orange) used
       on Median Price + YoY where lines need maximum contrast.
       `houseBar` / `unitBar` are the BAR colours (cyan / cool gray)
       used on Stock vs DoM + Long-Term Trends — softer fills that
       read well at 50%-page width. */
    house:        '#0b1a24',
    unit:         '#d99759',
    houseBar:     '#5cc8e0',
    unitBar:      '#bcc3c8',
    investor:     '#1e6feb',
    ownerOcc:     '#5cc8e0',
    /* Cash Rate / Variable Rate: matched to the Sydney PDF (Yield
       vs Cash Rate pages 25/26). Cash Rate is orange and Variable
       Rate is medium-gray — the previous token values had these
       swapped/misassigned (gray + red). Both tokens were unused
       before this fix, so no other charts are affected. */
    cashRate:     '#d99759',
    variableRate: '#7c8a98',
    longTerm:     '#7c8a98',
    sydney:       '#1e6feb',
    nsw:          '#d99759',
    national:     '#5cc8e0',
    male:         '#1e6feb',
    female:       '#e54a86',

    /* Period overlay tints — saturation tuned so the bands read clearly
       over the cyan-tinted chart background (matching the Sydney PDF). */
    growthBand:   'rgba(155,215,225,0.55)',
    correctBand:  'rgba(180,185,192,0.50)',

    /* Crisis markers */
    crisis:       '#d94242',
    crisisBg:     '#e57b7b',

    /* Neutrals */
    text:         '#1a2838',
    textMuted:    '#6c7a88',
    grid:         'rgba(0,0,0,0.06)',
    axisLine:     '#6a7a88',
  },

  /* Categorical palette — 19 distinct colours (matches PDF Industry chart).
     Used by donut/pie/stacked-bar charts that need many series. */
  palette18: [
    '#1e6feb','#16bfd6','#f8f2c2','#f2a880','#e8a04b',
    '#7bb241','#5d48c2','#3598e4','#e54a86','#ea5f3b',
    '#667585','#ec3c66','#5db34a','#8b8fa5','#e8a23b',
    '#a060c8','#e6bccb','#d06e9a','#9cd8f5'
  ],

  fonts: {
    /* Inside the chart canvas — matches PDF aesthetic */
    chart: 'Ubuntu, "Roboto", sans-serif',
    /* Outside the chart canvas (page text) */
    page:  'Roboto, system-ui, sans-serif',
  },

  /* Pre-built ECharts text-style objects so chart modules don't repeat
     them. Weights deliberately slightly heavy + slightly darker grey so
     the small in-chart text reads clean at print resolution. */
  axis: {
    fontFamily: 'Ubuntu, "Roboto", sans-serif',
    fontSize: 10,
    color: '#2f3d4a',
    fontWeight: 500,
  },
  legend: {
    fontFamily: 'Ubuntu, "Roboto", sans-serif',
    fontSize: 11,
    color: '#15212c',
    fontWeight: 600,
  },
  axisName: {
    fontFamily: 'Ubuntu, "Roboto", sans-serif',
    fontStyle: 'italic',
    fontSize: 10,
    color: '#2f3d4a',
    fontWeight: 500,
  },
};
