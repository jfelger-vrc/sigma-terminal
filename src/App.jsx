import { useState, useMemo, useEffect, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend, BarChart, Bar, Cell,
  ComposedChart, ReferenceLine, ScatterChart, Scatter, ZAxis
} from "recharts";

// ─── API CONFIGURATION ──────────────────────────────────────────────────────
// Priority: 1) Environment variable VITE_FRED_API_KEY (for Vite deployment), 2) Runtime input (settings panel)
// Note: env var only works in Vite builds — in artifact sandbox, use the settings panel
// FRED calls go through /api/fred proxy to avoid CORS:
// - Local dev: Vite proxy forwards to api.stlouisfed.org (see vite.config.js)
// - Production (Vercel): /api/fred.js serverless function proxies the request
const FRED_BASE = "/api/fred";
const FISCAL_BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";
const FISCAL_PROXY = "/api/fiscal/services/api/fiscal_service";
const TIC_PROXY = "/api/tic";

let FRED_API_KEY = import.meta.env.VITE_FRED_API_KEY || "";

// ─── FRED FETCH HELPERS ─────────────────────────────────────────────────────
async function fetchFredSeries(seriesId, startDate = "2020-01-01", frequency = null) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: FRED_API_KEY,
    file_type: "json",
    observation_start: startDate,
    sort_order: "asc",
  });
  if (frequency) params.set("frequency", frequency);
  const res = await fetch(`${FRED_BASE}?${params}`);
  if (!res.ok) throw new Error(`FRED ${seriesId}: ${res.status}`);
  const data = await res.json();
  return data.observations
    .filter(o => o.value !== ".")
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

async function fetchFredMultiple(seriesMap, startDate = "2020-01-01", frequency = null) {
  const entries = Object.entries(seriesMap);
  const results = await Promise.all(
    entries.map(([key, id]) => fetchFredSeries(id, startDate, frequency).then(data => ({ key, data })))
  );
  const byDate = {};
  results.forEach(({ key, data }) => {
    data.forEach(({ date, value }) => {
      const dk = date.slice(0, 7);
      if (!byDate[dk]) byDate[dk] = { date: dk };
      byDate[dk][key] = value;
    });
  });
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── FED BALANCE SHEET FETCH ────────────────────────────────────────────────
async function fetchFedData() {
  const raw = await fetchFredMultiple({
    total: "WALCL",
    treasuries: "TREAST",
    mbs: "WSHOMCB",
    rrp: "RRPONTSYD",
    tga: "WTREGEN",
    reserves: "WRESBAL",
  }, "2020-01-01", "m");

  return raw
    .filter(d => d.total && d.treasuries && d.mbs)
    .map(d => {
      // WALCL, TREAST, WSHOMCB, WTREGEN, WRESBAL are in millions
      // RRPONTSYD is in billions
      const total = d.total / 1e6;
      const treasuries = d.treasuries / 1e6;
      const mbs = d.mbs / 1e6;
      const rrp = (d.rrp || 0) / 1e3;
      const tga = (d.tga || 0) / 1e6;
      const reserves = (d.reserves || 0) / 1e6;
      const other = Math.max(0, total - treasuries - mbs);
      return {
        date: d.date,
        total: +total.toFixed(3),
        treasuries: +treasuries.toFixed(3),
        mbs: +mbs.toFixed(3),
        other: +other.toFixed(3),
        rrp: +rrp.toFixed(3),
        tga: +tga.toFixed(3),
        reserves: +reserves.toFixed(3),
        netLiquidity: +(total - rrp - tga).toFixed(3),
      };
    });
}

// ─── YIELDS & RATES FETCH ───────────────────────────────────────────────────
async function fetchRatesData() {
  return await fetchFredMultiple({
    ffr: "FEDFUNDS",
    sofr: "SOFR",
    y2: "DGS2",
    y10: "DGS10",
    y30: "DGS30",
  }, "2022-01-01", "m");
}

async function fetchBreakevenData() {
  return await fetchFredMultiple({
    be5y: "T5YIE",
    be10y: "T10YIE",
  }, "2022-01-01", "m");
}

async function fetchYieldCurveSnapshots() {
  const mats = {
    "1M": "DGS1MO", "3M": "DGS3MO", "6M": "DGS6MO",
    "1Y": "DGS1", "2Y": "DGS2", "3Y": "DGS3",
    "5Y": "DGS5", "7Y": "DGS7", "10Y": "DGS10",
    "20Y": "DGS20", "30Y": "DGS30",
  };
  const all = {};
  for (const [label, id] of Object.entries(mats)) {
    all[label] = await fetchFredSeries(id, "2019-01-01", "d");
  }
  const getVal = (label, target) => {
    const s = all[label];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].date <= target) return s[i].value;
    }
    return null;
  };
  const snapDates = {
    "Pre-COVID (Jan '20)": "2020-01-15",
    "Pre-Hike (Jan '22)": "2022-01-15",
    "Peak Inversion (Jul '23)": "2023-07-10",
  };
  const curves = {};
  // Current
  const currentCurve = {};
  for (const label of Object.keys(mats)) {
    const s = all[label];
    currentCurve[label] = s[s.length - 1]?.value || null;
  }
  curves["Current"] = currentCurve;
  // Historical
  for (const [name, date] of Object.entries(snapDates)) {
    curves[name] = {};
    for (const label of Object.keys(mats)) {
      curves[name][label] = getVal(label, date);
    }
  }
  return curves;
}

// ─── TREASURY FISCALDATA FETCH ──────────────────────────────────────────────
async function fetchDebtData() {
  const url = `${FISCAL_PROXY}/v2/accounting/od/debt_to_penny?` +
    `fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt` +
    `&sort=-record_date&page[size]=2000&filter=record_date:gte:2020-01-01`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FiscalData debt: ${res.status}`);
  const data = await res.json();
  // Group by month, take last reading per month
  const byMonth = {};
  data.data.forEach(d => {
    const m = d.record_date.slice(0, 7);
    byMonth[m] = {
      date: m,
      total: +(parseFloat(d.tot_pub_debt_out_amt) / 1e12).toFixed(2),
      public: +(parseFloat(d.debt_held_public_amt) / 1e12).toFixed(2),
      intra: +(parseFloat(d.intragov_hold_amt) / 1e12).toFixed(2),
    };
  });
  return Object.values(byMonth).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── MONTHLY TREASURY STATEMENT (Receipts & Outlays) ────────────────────────
async function fetchMTSData() {
  // MTS Table 1 structure per record_date (one MTS report):
  //   SL row: "FY 2024" header (null values)
  //   MTH rows: Oct, Nov, Dec... (actual monthly data for that FY)
  //   SL row: "Year-to-Date" (cumulative, skip)
  //   SL row: "FY 2025" header
  //   MTH rows: Oct, Nov... (current FY months)
  //   SL row: "Year-to-Date"
  // We want MTH rows only, using FY headers to assign fiscal years.

  const url = `${FISCAL_PROXY}/v1/accounting/mts/mts_table_1?` +
    `filter=record_date:gte:2021-10-01` +
    `&sort=-record_date` +
    `&page[size]=5000`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MTS ${res.status}`);
  const data = await res.json();

  const parseAmt = (v) => {
    if (v == null || v === "null" || v === "") return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };

  const MONTH_MAP = {
    october: 10, november: 11, december: 12,
    january: 1, february: 2, march: 3,
    april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9,
  };

  // Group rows by record_date (each = one MTS report)
  const byReport = {};
  data.data.forEach(d => {
    const rd = d.record_date;
    if (!byReport[rd]) byReport[rd] = [];
    byReport[rd].push(d);
  });

  // Extract monthly data with proper FY assignment
  const monthlyMap = {}; // "YYYY-MM" → data (latest report wins)

  Object.entries(byReport).forEach(([reportDate, rows]) => {
    // Sort by line_code_nbr so FY headers come before their months
    rows.sort((a, b) => parseInt(a.line_code_nbr) - parseInt(b.line_code_nbr));

    let currentFY = null;
    rows.forEach(row => {
      // FY header rows (e.g. "FY 2024") establish which FY subsequent MTH rows belong to
      if (row.record_type_cd === "SL" && /^FY \d{4}$/.test(row.classification_desc)) {
        currentFY = parseInt(row.classification_desc.replace("FY ", ""));
        return;
      }

      // Only process monthly data rows
      if (row.record_type_cd !== "MTH" || !currentFY) return;

      const monthName = row.classification_desc.toLowerCase();
      const calMonth = MONTH_MAP[monthName];
      if (!calMonth) return;

      // FY starts in October: Oct–Dec = prior calendar year, Jan–Sep = FY year
      const calYear = calMonth >= 10 ? currentFY - 1 : currentFY;
      const dateKey = `${calYear}-${String(calMonth).padStart(2, "0")}`;

      const rcpt = parseAmt(row.current_month_gross_rcpt_amt);
      const outly = parseAmt(row.current_month_gross_outly_amt);
      const dfct = parseAmt(row.current_month_dfct_sur_amt);

      if (rcpt === 0 && outly === 0) return;

      // Keep the version from the latest report date (most current revision)
      if (!monthlyMap[dateKey] || reportDate > monthlyMap[dateKey].reportDate) {
        monthlyMap[dateKey] = {
          date: dateKey,
          fy: currentFY,
          calMonth,
          revenue: +(rcpt / 1e9).toFixed(1),
          spending: +(Math.abs(outly) / 1e9).toFixed(1),
          deficit: +(-Math.abs(dfct) / 1e9).toFixed(1), // negative = deficit
          reportDate,
        };
        // April has negative dfct (surplus) — preserve sign
        if (dfct < 0) monthlyMap[dateKey].deficit = +(Math.abs(dfct) / 1e9).toFixed(1);
      }
    });
  });

  const monthly = Object.values(monthlyMap)
    .filter(d => d.revenue > 0 && d.spending > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (monthly.length === 0) {
    throw new Error("MTS: could not parse monthly data.");
  }

  console.log(`MTS: parsed ${monthly.length} months, ${monthly[0].date} → ${monthly[monthly.length - 1].date}`);

  // Build cumulative deficit by fiscal year
  const FY_MONTHS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
  const fyMap = {};

  monthly.forEach(d => {
    const fyKey = `fy${d.fy}`;
    if (!fyMap[fyKey]) fyMap[fyKey] = { months: [] };
    const fyMonthIdx = d.calMonth >= 10 ? d.calMonth - 10 : d.calMonth + 2;
    fyMap[fyKey].months.push({ idx: fyMonthIdx, deficit: d.deficit });
  });

  const fyDeficit = FY_MONTHS.map((month, idx) => {
    const row = { month };
    Object.entries(fyMap).forEach(([fyKey, fyData]) => {
      const monthsUpTo = fyData.months
        .filter(m => m.idx <= idx)
        .sort((a, b) => a.idx - b.idx);
      if (monthsUpTo.length > 0 && monthsUpTo[monthsUpTo.length - 1].idx === idx) {
        let cumulative = 0;
        monthsUpTo.forEach(m => cumulative += m.deficit);
        row[fyKey] = +cumulative.toFixed(1);
      } else {
        row[fyKey] = null;
      }
    });
    return row;
  });

  return { monthly, fyDeficit, fyKeys: Object.keys(fyMap).sort() };
}

// ─── TIC MAJOR FOREIGN HOLDERS ──────────────────────────────────────────────
async function fetchTICData() {
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const countryData = {};   // { "Japan": { "2024-12": 1061.5, ... }, ... }
  let grandTotalByDate = {};

  // Helper to clean country names
  const cleanCountryName = (name) => {
    let country = name.replace(/"/g, "").trim();
    if (country === "China, Mainland") return "China";
    if (country === "Korea, South") return "South Korea";
    return country;
  };

  // --- 1. Fetch HISTORICAL data (mfhhis01.txt) ---
  try {
    const res = await fetch(`${TIC_PROXY}/Publish/mfhhis01.txt`);
    if (res.ok) {
      const text = await res.text();
      const lines = text.split("\n");

      let i = 0;
      while (i < lines.length) {
        const line = lines[i].replace(/\r/, "");

        // Look for month header rows (e.g., "\tDec\tNov\tOct...")
        const monthMatch = line.match(/^\t+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\t/);
        if (monthMatch) {
          const months = line.split("\t").filter(s => s.trim());

          // Next line has "Country" and years
          i++;
          if (i >= lines.length) break;
          const yearLine = lines[i].replace(/\r/, "");
          const yearParts = yearLine.split("\t").filter(s => s.trim());
          const years = yearParts.slice(1);

          // Build date columns
          const dateCols = months.map((m, j) => {
            const yr = years[j] || years[0];
            const mi = MONTH_NAMES.indexOf(m);
            if (mi === -1 || !yr) return null;
            return `${yr}-${String(mi + 1).padStart(2, "0")}`;
          });

          // Skip dashes line
          i++;
          if (i < lines.length && lines[i].includes("------")) i++;

          // Parse country rows until we hit empty line, "Of which:", or another block
          while (i < lines.length) {
            const row = lines[i].replace(/\r/, "");
            if (!row.trim() || row.trim().startsWith("Of which:")) break;
            if (/^\t+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\t/.test(row)) break;

            const parts = row.split("\t");
            let country = cleanCountryName(parts[0]);
            if (!country) { i++; continue; }

            const values = parts.slice(1).map(v => {
              const cleaned = v.trim().replace(/,/g, "");
              if (!cleaned || cleaned === "null" || cleaned === "*") return 0;
              const n = parseFloat(cleaned);
              return isNaN(n) ? 0 : n;
            });

            if (country === "Grand Total") {
              dateCols.forEach((d, j) => {
                if (d && values[j]) grandTotalByDate[d] = values[j];
              });
            } else {
              if (!countryData[country]) countryData[country] = {};
              dateCols.forEach((d, j) => {
                if (d && values[j] > 0) {
                  countryData[country][d] = values[j];
                }
              });
            }
            i++;
          }
        } else {
          i++;
        }
      }
      console.log("TIC: parsed historical mfhhis01.txt");
    }
  } catch (e) {
    console.warn("TIC: historical fetch failed, continuing with current source", e);
  }

  // --- 2. Fetch CURRENT data (slt_table5.html) - overwrites overlapping dates ---
  const currentRes = await fetch(`${TIC_PROXY}/resource-center/data-chart-center/tic/Documents/slt_table5.html`);
  if (!currentRes.ok) throw new Error(`TIC current ${currentRes.status}`);
  const html = await currentRes.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) throw new Error("TIC: no table found in slt_table5.html");

  const rows = table.querySelectorAll("tr");
  let dateColumns = []; // ["2025-11", "2025-10", ...]

  for (const row of rows) {
    const cells = row.querySelectorAll("td, th");
    if (cells.length === 0) continue;

    const firstCell = cells[0].textContent.trim();

    // Check if this row contains date headers (must be BEFORE skip filters)
    // The "Country" row has format: "Country", "2025-10", "2025-09", ...
    if (cells[1]?.textContent.trim().match(/^\d{4}-\d{2}$/)) {
      dateColumns = [];
      for (let i = 1; i < cells.length; i++) {
        const cellText = cells[i].textContent.trim();
        if (cellText.match(/^\d{4}-\d{2}$/)) {
          dateColumns.push(cellText);
        }
      }
      console.log(`TIC: found ${dateColumns.length} date columns from slt_table5`);
      continue;
    }

    // Skip non-data rows
    if (!firstCell ||
        firstCell.startsWith("Of Which") ||
        firstCell.startsWith("Notes") ||
        firstCell.startsWith("Holdings") ||
        firstCell.startsWith("Billions") ||
        firstCell.startsWith("Link:") ||
        firstCell === "Country") continue;

    // Skip if we don't have date columns yet
    if (dateColumns.length === 0) continue;

    // This is a country data row
    let country = cleanCountryName(firstCell);
    if (!country || country === "Grand Total") {
      if (country === "Grand Total") {
        for (let i = 1; i < cells.length && i - 1 < dateColumns.length; i++) {
          const val = parseFloat(cells[i].textContent.trim().replace(/,/g, ""));
          if (!isNaN(val) && val > 0) {
            grandTotalByDate[dateColumns[i - 1]] = val;
          }
        }
      }
      continue;
    }

    if (!countryData[country]) countryData[country] = {};

    for (let i = 1; i < cells.length && i - 1 < dateColumns.length; i++) {
      const val = parseFloat(cells[i].textContent.trim().replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        countryData[country][dateColumns[i - 1]] = val; // Overwrites historical
      }
    }
  }

  console.log("TIC: parsed current slt_table5.html");

  // --- 3. Build display dates: quarterly for old, monthly for last 18 months ---
  const allDates = [...new Set([
    ...Object.values(countryData).flatMap(c => Object.keys(c)),
    ...Object.keys(grandTotalByDate)
  ])].sort();

  const now = new Date();
  const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 18, 1);
  const cutoffStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;

  const displayDates = allDates.filter(d => {
    if (d >= cutoffStr) return true; // Monthly for last 18 months
    // Quarterly (Mar, Jun, Sep, Dec) for older data
    const month = parseInt(d.split("-")[1], 10);
    return [3, 6, 9, 12].includes(month);
  }).filter(d => d >= "2020-01");

  // Country colors (stable assignment)
  const COUNTRY_COLORS = {
    Japan: "#ef4444", China: "#f59e0b", "United Kingdom": "#3b82f6",
    Luxembourg: "#8b5cf6", "Cayman Islands": "#22d3ee", Canada: "#10b981",
    Belgium: "#f472b6", Ireland: "#a78bfa", Switzerland: "#fbbf24",
    Taiwan: "#6ee7b7", India: "#fb923c", "Hong Kong": "#e879f9",
    Brazil: "#34d399", Singapore: "#93c5fd", France: "#c084fc",
    Korea: "#7dd3fc", "South Korea": "#7dd3fc", Norway: "#67e8f9", "Saudi Arabia": "#86efac",
    Germany: "#fca5a5", Bermuda: "#d8b4fe", Thailand: "#bef264",
    Israel: "#a5b4fc", Philippines: "#fcd34d", Kuwait: "#5eead4",
    Mexico: "#f9a8d4", Australia: "#fdba74", "United Arab Emirates": "#99f6e4",
    Colombia: "#d9f99d", Sweden: "#fde68a", Poland: "#c4b5fd",
    Netherlands: "#818cf8", Spain: "#fda4af", Italy: "#a3e635",
    Peru: "#d4d4d8", Chile: "#bae6fd", Indonesia: "#fef08a",
  };

  // Build holdings arrays for each country that has data for most display dates
  const countries = {};
  const sortedCountryNames = Object.keys(countryData)
    .filter(name => name !== "All Other")
    .sort((a, b) => {
      const aLatest = countryData[a][displayDates[displayDates.length - 1]] || 0;
      const bLatest = countryData[b][displayDates[displayDates.length - 1]] || 0;
      return bLatest - aLatest;
    })
    .slice(0, 31); // Top 31 countries

  sortedCountryNames.forEach(name => {
    countries[name] = {
      color: COUNTRY_COLORS[name] || `hsl(${(Object.keys(countries).length * 37) % 360}, 60%, 55%)`,
      holdings: displayDates.map(d => countryData[name][d] || 0),
    };
  });

  // Grand totals
  const totals = displayDates.map(d => grandTotalByDate[d] || 0);

  console.log(`TIC: parsed ${Object.keys(countryData).length} countries, ${displayDates.length} dates (${displayDates[0]} → ${displayDates[displayDates.length - 1]})`);

  return { dates: displayDates, countries, totals };
}

// ─── MASTER DATA HOOK ───────────────────────────────────────────────────────
function useDataFetcher(apiKey) {
  const [liveData, setLiveData] = useState({});
  const [loadingStatus, setLoadingStatus] = useState({});
  const [errors, setErrors] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchSource = useCallback(async (key, fn) => {
    setLoadingStatus(prev => ({ ...prev, [key]: "loading" }));
    setErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      const data = await fn();
      setLiveData(prev => ({ ...prev, [key]: data }));
      setLoadingStatus(prev => ({ ...prev, [key]: "live" }));
    } catch (e) {
      console.error(`${key} fetch failed:`, e);
      setErrors(prev => ({ ...prev, [key]: e.message }));
      setLoadingStatus(prev => ({ ...prev, [key]: "error" }));
    }
  }, []);

  useEffect(() => {
    if (!apiKey) return;
    FRED_API_KEY = apiKey;
    // Reset state for fresh fetch
    setLiveData({});
    setLoadingStatus({});
    setErrors({});
    fetchSource("fed", fetchFedData);
    fetchSource("rates", fetchRatesData);
    fetchSource("breakevens", fetchBreakevenData);
    fetchSource("debt", fetchDebtData);
    fetchSource("mts", fetchMTSData);
    fetchSource("yieldCurve", fetchYieldCurveSnapshots);
    setLastUpdated(new Date());
  }, [apiKey, fetchSource]);

  // TIC data doesn't need API key - fetch on mount
  useEffect(() => {
    fetchSource("tic", fetchTICData);
  }, [fetchSource]);

  return { liveData, loadingStatus, errors, lastUpdated };
}

// ─── REALISTIC FED BALANCE SHEET DATA (Monthly, 2020-2024) ─────────────────
const fedData = [
  { date: "2020-01", total: 4.15, treasuries: 2.33, mbs: 1.37, other: 0.45, rrp: 0.22, tga: 0.38, reserves: 1.65 },
  { date: "2020-03", total: 4.66, treasuries: 2.63, mbs: 1.46, other: 0.57, rrp: 0.15, tga: 0.35, reserves: 2.10 },
  { date: "2020-04", total: 5.81, treasuries: 3.34, mbs: 1.73, other: 0.74, rrp: 0.13, tga: 0.97, reserves: 2.86 },
  { date: "2020-06", total: 7.09, treasuries: 4.18, mbs: 1.92, other: 0.99, rrp: 0.25, tga: 1.59, reserves: 3.22 },
  { date: "2020-08", total: 6.96, treasuries: 4.28, mbs: 1.96, other: 0.72, rrp: 0.18, tga: 1.76, reserves: 2.87 },
  { date: "2020-10", total: 7.14, treasuries: 4.42, mbs: 2.01, other: 0.71, rrp: 0.15, tga: 1.61, reserves: 3.13 },
  { date: "2020-12", total: 7.36, treasuries: 4.62, mbs: 2.04, other: 0.70, rrp: 0.10, tga: 1.53, reserves: 3.28 },
  { date: "2021-02", total: 7.53, treasuries: 4.85, mbs: 2.10, other: 0.58, rrp: 0.05, tga: 1.10, reserves: 3.80 },
  { date: "2021-04", total: 7.82, treasuries: 5.06, mbs: 2.18, other: 0.58, rrp: 0.20, tga: 0.96, reserves: 3.88 },
  { date: "2021-06", total: 8.06, treasuries: 5.24, mbs: 2.30, other: 0.52, rrp: 0.76, tga: 0.72, reserves: 3.85 },
  { date: "2021-08", total: 8.27, treasuries: 5.35, mbs: 2.43, other: 0.49, rrp: 1.07, tga: 0.44, reserves: 3.92 },
  { date: "2021-10", total: 8.46, treasuries: 5.47, mbs: 2.52, other: 0.47, rrp: 1.44, tga: 0.28, reserves: 3.78 },
  { date: "2021-12", total: 8.73, treasuries: 5.63, mbs: 2.62, other: 0.48, rrp: 1.70, tga: 0.41, reserves: 3.65 },
  { date: "2022-02", total: 8.87, treasuries: 5.72, mbs: 2.68, other: 0.47, rrp: 1.65, tga: 0.63, reserves: 3.70 },
  { date: "2022-04", total: 8.94, treasuries: 5.76, mbs: 2.73, other: 0.45, rrp: 1.87, tga: 0.91, reserves: 3.31 },
  { date: "2022-06", total: 8.91, treasuries: 5.74, mbs: 2.71, other: 0.46, rrp: 2.16, tga: 0.65, reserves: 3.26 },
  { date: "2022-08", total: 8.82, treasuries: 5.68, mbs: 2.68, other: 0.46, rrp: 2.25, tga: 0.57, reserves: 3.17 },
  { date: "2022-10", total: 8.68, treasuries: 5.56, mbs: 2.67, other: 0.45, rrp: 2.38, tga: 0.67, reserves: 2.92 },
  { date: "2022-12", total: 8.55, treasuries: 5.46, mbs: 2.64, other: 0.45, rrp: 2.48, tga: 0.45, reserves: 2.87 },
  { date: "2023-02", total: 8.39, treasuries: 5.34, mbs: 2.61, other: 0.44, rrp: 2.29, tga: 0.42, reserves: 2.98 },
  { date: "2023-04", total: 8.50, treasuries: 5.36, mbs: 2.58, other: 0.56, rrp: 2.24, tga: 0.28, reserves: 3.18 },
  { date: "2023-06", total: 8.34, treasuries: 5.22, mbs: 2.55, other: 0.57, rrp: 2.01, tga: 0.33, reserves: 3.22 },
  { date: "2023-08", total: 8.12, treasuries: 5.04, mbs: 2.52, other: 0.56, rrp: 1.74, tga: 0.46, reserves: 3.20 },
  { date: "2023-10", total: 7.95, treasuries: 4.91, mbs: 2.48, other: 0.56, rrp: 1.18, tga: 0.78, reserves: 3.28 },
  { date: "2023-12", total: 7.72, treasuries: 4.77, mbs: 2.42, other: 0.53, rrp: 0.81, tga: 0.75, reserves: 3.42 },
  { date: "2024-02", total: 7.60, treasuries: 4.66, mbs: 2.39, other: 0.55, rrp: 0.55, tga: 0.76, reserves: 3.52 },
  { date: "2024-04", total: 7.44, treasuries: 4.55, mbs: 2.35, other: 0.54, rrp: 0.42, tga: 0.93, reserves: 3.36 },
  { date: "2024-06", total: 7.28, treasuries: 4.46, mbs: 2.32, other: 0.50, rrp: 0.38, tga: 0.77, reserves: 3.40 },
  { date: "2024-08", total: 7.15, treasuries: 4.38, mbs: 2.29, other: 0.48, rrp: 0.33, tga: 0.81, reserves: 3.32 },
  { date: "2024-10", total: 7.03, treasuries: 4.30, mbs: 2.26, other: 0.47, rrp: 0.24, tga: 0.82, reserves: 3.24 },
  { date: "2024-12", total: 6.89, treasuries: 4.23, mbs: 2.22, other: 0.44, rrp: 0.18, tga: 0.71, reserves: 3.30 },
];

// ─── NET LIQUIDITY COMPUTATION ──────────────────────────────────────────────
const liquidityData = fedData.map(d => ({
  ...d,
  netLiquidity: +(d.total - d.rrp - d.tga).toFixed(2),
}));

// ─── DESIGN TOKENS ──────────────────────────────────────────────────────────
const C = {
  bg: "#0a0e17",
  surface: "#111827",
  surfaceAlt: "#0d1321",
  border: "#1e293b",
  borderLight: "#334155",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  textMuted: "#64748b",
  accent: "#60a5fa",
  treasuries: "#3b82f6",
  mbs: "#8b5cf6",
  other: "#64748b",
  rrp: "#f59e0b",
  tga: "#10b981",
  reserves: "#f472b6",
  netLiq: "#22d3ee",
  red: "#ef4444",
  green: "#22c55e",
};

// ─── HELPERS ────────────────────────────────────────────────────────────────
const fmt = (v, dec = 2) => `$${v.toFixed(dec)}T`;
const fmtB = (v) => `$${(v * 1000).toFixed(0)}B`;
const fmtComma = (v) => Math.abs(v).toLocaleString();
const pctChange = (curr, prev) => {
  if (!prev) return null;
  return ((curr - prev) / prev * 100).toFixed(1);
};

const formatDateLabel = (d) => {
  const [y, m] = d.split("-");
  const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m)]} '${y.slice(2)}`;
};

// ─── NAV ITEMS ──────────────────────────────────────────────────────────────
const NAV = [
  { id: "fed", label: "Fed Balance Sheet", icon: "◈", status: "live" },
  { id: "fiscal", label: "Fiscal & Deficit", icon: "◆", status: "live" },
  { id: "sovereign", label: "Sovereign Holdings", icon: "◉", status: "live" },
  { id: "yields", label: "Yields & Rates", icon: "◇", status: "live" },
  { id: "socsec", label: "Social Security", icon: "◐", status: "live" },
  { id: "sources", label: "Sources & Data", icon: "◎", status: "live" },
];

// ─── CUSTOM TOOLTIP ─────────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label, series }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.borderLight}`,
      borderRadius: 8,
      padding: "12px 16px",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
    }}>
      <div style={{ color: C.textDim, marginBottom: 8, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
        {formatDateLabel(label)}
      </div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBottom: 3 }}>
          <span style={{ color: p.color || C.textDim }}>
            {p.name}
          </span>
          <span style={{ color: C.text, fontWeight: 600 }}>
            {fmt(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

const SingleTooltip = ({ active, payload, label, color, labelKey }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.borderLight}`,
      borderRadius: 8,
      padding: "10px 14px",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
    }}>
      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
        {formatDateLabel(label)}
      </div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontWeight: 600 }}>
          {p.name}: {fmt(p.value)}
        </div>
      ))}
    </div>
  );
};

// ─── STAT CARD ──────────────────────────────────────────────────────────────
const StatCard = ({ label, value, change, sub, color, small }) => {
  const isPositive = change && parseFloat(change) > 0;
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: small ? "14px 16px" : "18px 22px",
      flex: 1,
      minWidth: small ? 140 : 170,
    }}>
      <div style={{
        fontFamily: "'Outfit', sans-serif",
        fontSize: 11,
        color: C.textMuted,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: small ? 20 : 26,
        fontWeight: 700,
        color: color || C.text,
        letterSpacing: "-0.02em",
      }}>
        {value}
      </div>
      {change && (
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          color: isPositive ? C.green : C.red,
          marginTop: 4,
        }}>
          {isPositive ? "▲" : "▼"} {Math.abs(parseFloat(change))}%
          {sub && <span style={{ color: C.textMuted, marginLeft: 6 }}>{sub}</span>}
        </div>
      )}
      {!change && sub && (
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 11,
          color: C.textMuted,
          marginTop: 4,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
};

// ─── CHART CARD ─────────────────────────────────────────────────────────────
const ChartCard = ({ title, subtitle, children, height = 320 }) => (
  <div style={{
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: "20px 20px 12px",
    marginBottom: 20,
  }}>
    <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <div>
        <span style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 15,
          fontWeight: 600,
          color: C.text,
        }}>
          {title}
        </span>
        {subtitle && (
          <span style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: 12,
            color: C.textMuted,
            marginLeft: 10,
          }}>
            {subtitle}
          </span>
        )}
      </div>
    </div>
    <div style={{ height }}>
      {children}
    </div>
  </div>
);

// ─── COMING SOON PAGE ───────────────────────────────────────────────────────
const ComingSoon = ({ nav }) => (
  <div style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "60vh",
    textAlign: "center",
  }}>
    <div style={{
      fontSize: 48,
      marginBottom: 16,
      opacity: 0.3,
    }}>
      {nav.icon}
    </div>
    <div style={{
      fontFamily: "'Outfit', sans-serif",
      fontSize: 22,
      fontWeight: 600,
      color: C.text,
      marginBottom: 8,
    }}>
      {nav.label}
    </div>
    <div style={{
      fontFamily: "'Outfit', sans-serif",
      fontSize: 14,
      color: C.textMuted,
      maxWidth: 400,
      lineHeight: 1.6,
    }}>
      This dashboard is under construction. We're building out the data pipeline and visualizations — check back soon.
    </div>
    <div style={{
      marginTop: 24,
      padding: "8px 20px",
      background: `${C.accent}15`,
      border: `1px solid ${C.accent}30`,
      borderRadius: 20,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: C.accent,
      textTransform: "uppercase",
      letterSpacing: "0.1em",
    }}>
      Coming Soon
    </div>
  </div>
);

// ─── FED BALANCE SHEET DASHBOARD ────────────────────────────────────────────
const FedDashboard = ({ liveData }) => {
  const data = liveData || liquidityData;
  const latest = data[data.length - 1];
  const prev = data[data.length - 2];
  const peak = data.reduce((max, d) => d.total > max.total ? d : max);
  const peakRRP = data.reduce((max, d) => d.rrp > max.rrp ? d : max);
  const qeStart = data[0];

  const drawdown = ((peak.total - latest.total) / peak.total * 100).toFixed(1);
  const trough = data.reduce((min, d) => d.total < min.total ? d : min);
  const isQT = latest.total < peak.total && latest.total <= prev.total;
  const qLabel = isQT ? "QT Drawdown" : "QE Expansion";
  const qValue = isQT
    ? `−${drawdown}%`
    : `+${((latest.total - trough.total) / trough.total * 100).toFixed(1)}%`;
  const qRef = isQT
    ? `from ${formatDateLabel(peak.date)} peak`
    : `from ${formatDateLabel(trough.date)} trough`;
  const qColor = isQT ? C.red : C.green;

  return (
    <div>
      {/* Key Metrics Row */}
      <div style={{
        display: "flex",
        gap: 14,
        marginBottom: 22,
        flexWrap: "wrap",
      }}>
        <StatCard
          label="Total Assets"
          value={fmt(latest.total)}
          change={pctChange(latest.total, prev.total)}
          sub={`vs ${formatDateLabel(prev.date)} reading`}
        />
        <StatCard
          label="Net Liquidity"
          value={fmt(latest.netLiquidity)}
          change={pctChange(latest.netLiquidity, prev.netLiquidity)}
          sub="(Assets − RRP − TGA)"
          color={C.netLiq}
        />
        <StatCard
          label={qLabel}
          value={qValue}
          sub={qRef}
          color={qColor}
        />
        <StatCard
          label="Reverse Repo"
          value={fmtB(latest.rrp)}
          change={pctChange(latest.rrp, prev.rrp)}
          sub={`peak: ${fmt(peakRRP.rrp)} (${formatDateLabel(peakRRP.date)})`}
          color={C.rrp}
        />
        <StatCard
          label="Bank Reserves"
          value={fmt(latest.reserves)}
          change={pctChange(latest.reserves, prev.reserves)}
          sub="Balances at the Fed"
          color={C.reserves}
        />
      </div>

      {/* Main Balance Sheet Chart */}
      <ChartCard
        title="Federal Reserve Total Assets"
        subtitle="Composition: Treasuries, MBS, Other — Trillions USD"
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="gradTreasuries" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.treasuries} stopOpacity={0.7} />
                <stop offset="100%" stopColor={C.treasuries} stopOpacity={0.15} />
              </linearGradient>
              <linearGradient id="gradMBS" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.mbs} stopOpacity={0.7} />
                <stop offset="100%" stopColor={C.mbs} stopOpacity={0.15} />
              </linearGradient>
              <linearGradient id="gradOther" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.other} stopOpacity={0.5} />
                <stop offset="100%" stopColor={C.other} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateLabel}
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
              interval={3}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}T`}
              domain={[0, 10]}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="other" stackId="1" name="Other" fill="url(#gradOther)" stroke={C.other} strokeWidth={0} />
            <Area type="monotone" dataKey="mbs" stackId="1" name="MBS" fill="url(#gradMBS)" stroke={C.mbs} strokeWidth={1} />
            <Area type="monotone" dataKey="treasuries" stackId="1" name="Treasuries" fill="url(#gradTreasuries)" stroke={C.treasuries} strokeWidth={1} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Two-column: RRP + TGA, and Net Liquidity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Reverse Repo & TGA */}
        <ChartCard
          title="Reserves, Reverse Repo & TGA"
          subtitle="Fed liability-side balances — Trillions USD"
          height={240}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={5}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}T`}
              />
              <Tooltip content={<SingleTooltip />} />
              <Line type="monotone" dataKey="reserves" name="Bank Reserves" stroke={C.reserves} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="rrp" name="Reverse Repo" stroke={C.rrp} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="tga" name="TGA Balance" stroke={C.tga} strokeWidth={2} dot={false} />
              <Legend
                wrapperStyle={{
                  fontSize: 11,
                  fontFamily: "'Outfit', sans-serif",
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Net Liquidity */}
        <ChartCard
          title="Net Liquidity Proxy"
          subtitle="Total Assets − RRP − TGA"
          height={240}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="gradNetLiq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.netLiq} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={C.netLiq} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={5}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}T`}
                domain={["dataMin - 0.3", "dataMax + 0.3"]}
              />
              <Tooltip content={<SingleTooltip />} />
              <Area type="monotone" dataKey="netLiquidity" name="Net Liquidity" fill="url(#gradNetLiq)" stroke={C.netLiq} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Context Strip */}
      <div style={{
        marginTop: 10,
        padding: "14px 20px",
        background: `${C.accent}08`,
        border: `1px solid ${C.accent}20`,
        borderRadius: 10,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 13,
        color: C.textDim,
        lineHeight: 1.7,
      }}>
        <span style={{ color: C.accent, fontWeight: 600, marginRight: 8 }}>Context</span>
        The Fed's balance sheet peaked at {fmt(peak.total)} in {formatDateLabel(peak.date)} and has since contracted
        by {drawdown}% through quantitative tightening (QT). The reverse repo facility — once absorbing over $2.5T —
        has drained to {fmtB(latest.rrp)}, with that liquidity largely rotating into bank reserves ({fmt(latest.reserves)})
        and Treasury bills. Net liquidity (total assets minus RRP and TGA) currently sits at {fmt(latest.netLiquidity)},
        a closely-watched proxy for financial conditions that has historically correlated with risk asset performance.
      </div>
    </div>
  );
};

// ─── FISCAL / DEFICIT DATA ──────────────────────────────────────────────────

// Cumulative deficit by month within fiscal year (Oct-Sep), in $B
const fyDeficitData = [
  { month: "Oct", fy2022: -88, fy2023: -171, fy2024: -237, fy2025: -258 },
  { month: "Nov", fy2022: -237, fy2023: -382, fy2024: -382, fy2025: -485 },
  { month: "Dec", fy2022: -422, fy2023: -510, fy2024: -532, fy2025: -711 },
  { month: "Jan", fy2022: -259, fy2023: -460, fy2024: -398, fy2025: -560 },
  { month: "Feb", fy2022: -476, fy2023: -723, fy2024: -631, fy2025: -838 },
  { month: "Mar", fy2022: -668, fy2023: -1028, fy2024: -876, fy2025: -1121 },
  { month: "Apr", fy2022: -360, fy2023: -925, fy2024: -654, fy2025: null },
  { month: "May", fy2022: -426, fy2023: -1165, fy2024: -809, fy2025: null },
  { month: "Jun", fy2022: -515, fy2023: -1393, fy2024: -1067, fy2025: null },
  { month: "Jul", fy2022: -727, fy2023: -1612, fy2024: -1253, fy2025: null },
  { month: "Aug", fy2022: -946, fy2023: -1524, fy2024: -1574, fy2025: null },
  { month: "Sep", fy2022: -1375, fy2023: -1695, fy2024: -1833, fy2025: null },
];

// Monthly revenue vs spending ($B)
const monthlyFiscalData = [
  { date: "2023-10", revenue: 275, spending: 446 },
  { date: "2023-11", revenue: 281, spending: 493 },
  { date: "2023-12", revenue: 392, spending: 542 },
  { date: "2024-01", revenue: 480, spending: 614 },
  { date: "2024-02", revenue: 296, spending: 529 },
  { date: "2024-03", revenue: 332, spending: 577 },
  { date: "2024-04", revenue: 776, spending: 554 },
  { date: "2024-05", revenue: 323, spending: 478 },
  { date: "2024-06", revenue: 392, spending: 650 },
  { date: "2024-07", revenue: 330, spending: 516 },
  { date: "2024-08", revenue: 307, spending: 628 },
  { date: "2024-09", revenue: 374, spending: 633 },
  { date: "2024-10", revenue: 288, spending: 546 },
  { date: "2024-11", revenue: 302, spending: 587 },
  { date: "2024-12", revenue: 398, spending: 624 },
  { date: "2025-01", revenue: 512, spending: 661 },
  { date: "2025-02", revenue: 305, spending: 583 },
  { date: "2025-03", revenue: 340, spending: 623 },
];

// Debt outstanding over time ($T)
const debtData = [
  { date: "2020-01", total: 23.2, public: 17.2, intra: 6.0 },
  { date: "2020-06", total: 26.5, public: 20.3, intra: 6.2 },
  { date: "2020-12", total: 27.7, public: 21.6, intra: 6.1 },
  { date: "2021-03", total: 28.1, public: 21.9, intra: 6.2 },
  { date: "2021-06", total: 28.5, public: 22.3, intra: 6.2 },
  { date: "2021-09", total: 28.8, public: 22.3, intra: 6.5 },
  { date: "2021-12", total: 29.6, public: 23.0, intra: 6.6 },
  { date: "2022-03", total: 30.0, public: 23.3, intra: 6.7 },
  { date: "2022-06", total: 30.5, public: 23.7, intra: 6.8 },
  { date: "2022-09", total: 30.9, public: 24.0, intra: 6.9 },
  { date: "2022-12", total: 31.4, public: 24.4, intra: 7.0 },
  { date: "2023-03", total: 31.5, public: 24.6, intra: 6.9 },
  { date: "2023-06", total: 32.3, public: 25.3, intra: 7.0 },
  { date: "2023-09", total: 33.2, public: 26.2, intra: 7.0 },
  { date: "2023-12", total: 34.0, public: 26.9, intra: 7.1 },
  { date: "2024-03", total: 34.5, public: 27.3, intra: 7.2 },
  { date: "2024-06", total: 34.8, public: 27.6, intra: 7.2 },
  { date: "2024-09", total: 35.5, public: 28.2, intra: 7.3 },
  { date: "2024-12", total: 36.2, public: 28.9, intra: 7.3 },
];

// Debt composition for latest period (for pie-like bar)
const debtComposition = [
  { name: "T-Bills", value: 6.0, color: "#60a5fa" },
  { name: "T-Notes", value: 14.5, color: "#3b82f6" },
  { name: "T-Bonds", value: 4.7, color: "#1d4ed8" },
  { name: "TIPS", value: 2.1, color: "#8b5cf6" },
  { name: "FRN", value: 1.6, color: "#a78bfa" },
  { name: "Intragovernmental", value: 7.3, color: "#475569" },
];

const FY_COLORS = {
  fy2022: "#475569",
  fy2023: "#64748b",
  fy2024: "#8b5cf6",
  fy2025: "#ef4444",
};

// ─── FISCAL DASHBOARD ───────────────────────────────────────────────────────
const FiscalDashboard = ({ liveDebt, liveMTS }) => {
  const debtChartData = liveDebt || debtData;
  const monthlyData = liveMTS?.monthly || monthlyFiscalData;
  const fyData = liveMTS?.fyDeficit || fyDeficitData;
  const fyKeys = liveMTS?.fyKeys || ["fy2022", "fy2023", "fy2024", "fy2025"];
  const [showGuide, setShowGuide] = useState(false);
  const [monthlyStartIdx, setMonthlyStartIdx] = useState(null); // null = auto (show last 12)
  const latestDebt = debtChartData[debtChartData.length - 1];
  const prevDebt = debtChartData[debtChartData.length - 2];

  // Find latest FY and its cumulative deficit
  const currentFYKey = fyKeys[fyKeys.length - 1];
  const latestFY = fyData.filter(d => d[currentFYKey] != null);
  const latestDeficit = latestFY[latestFY.length - 1] || {};
  const priorFYKey = fyKeys.length > 1 ? fyKeys[fyKeys.length - 2] : null;
  const priorYearSameMonth = priorFYKey && latestDeficit[priorFYKey] != null ? latestDeficit[priorFYKey] : null;

  const totalRevenue = monthlyData.slice(-6).reduce((s, d) => s + (d.revenue || 0), 0);
  const totalSpending = monthlyData.slice(-6).reduce((s, d) => s + (d.spending || 0), 0);

  // Dynamic FY colors
  const FY_PALETTE = ["#475569", "#64748b", "#8b5cf6", "#ef4444", "#f59e0b", "#22c55e"];
  const dynamicFYColors = {};
  fyKeys.forEach((key, i) => {
    dynamicFYColors[key] = FY_PALETTE[i % FY_PALETTE.length];
  });

  // Interest cost estimate (annualized)
  const estInterest = 1.12; // ~$1.12T annualized

  const monthlyWithDeficit = monthlyData.map(d => ({
    ...d,
    deficit: (d.revenue || 0) - (d.spending || 0),
  }));

  // Slider: default to showing last 12 months
  const effectiveStartIdx = monthlyStartIdx != null ? monthlyStartIdx : Math.max(0, monthlyWithDeficit.length - 12);
  const monthlySliced = monthlyWithDeficit.slice(effectiveStartIdx);

  return (
    <div>
      {/* Key Metrics */}
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <StatCard
          label="Total Debt Outstanding"
          value={`$${latestDebt.total}T`}
          change={pctChange(latestDebt.total, prevDebt.total)}
          sub={`vs ${formatDateLabel(prevDebt.date)} (${formatDateLabel(latestDebt.date)} data)`}
        />
        <StatCard
          label={`${currentFYKey.replace("fy", "FY")} YTD Deficit`}
          value={latestDeficit[currentFYKey] != null ? `−$${fmtComma(Math.abs(latestDeficit[currentFYKey]))}B` : "—"}
          sub={latestDeficit.month ? `through ${latestDeficit.month}${priorYearSameMonth != null ? ` (${priorFYKey.replace("fy", "FY")}: −$${fmtComma(Math.abs(priorYearSameMonth))}B)` : ""}` : ""}
          color={C.red}
        />
        <StatCard
          label="Debt Held by Public"
          value={`$${latestDebt.public}T`}
          change={pctChange(latestDebt.public, prevDebt.public)}
          sub={`${((latestDebt.public / latestDebt.total) * 100).toFixed(0)}% of total`}
          color={C.accent}
        />
        <StatCard
          label="Est. Annual Interest"
          value={`$${estInterest}T`}
          sub="annualized net interest"
          color={C.rrp}
        />
      </div>

      {/* FY-to-Date Deficit Comparison — THE hero chart */}
      <ChartCard
        title="Cumulative Deficit by Fiscal Year"
        subtitle="FY runs Oct–Sep — Billions USD (more negative = larger deficit)"
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={fyData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="month"
              tick={{ fill: C.textMuted, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}B`}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.borderLight}`,
                    borderRadius: 8,
                    padding: "12px 16px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}>
                    <div style={{ color: C.textDim, marginBottom: 8, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                      {label}
                    </div>
                    {payload.filter(p => p.value !== null).map((p, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBottom: 3 }}>
                        <span style={{ color: p.color }}>{p.name}</span>
                        <span style={{ color: C.text, fontWeight: 600 }}>${p.value}B</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {fyKeys.map((key, i) => {
              const isLatest = i === fyKeys.length - 1;
              const isPrior = i === fyKeys.length - 2;
              return (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={key.replace("fy", "FY")}
                  stroke={dynamicFYColors[key]}
                  strokeWidth={isLatest ? 2.5 : isPrior ? 2 : 1.5}
                  dot={isLatest ? { r: 3, fill: dynamicFYColors[key] } : false}
                  strokeDasharray={isLatest ? "0" : isPrior ? "0" : "6 3"}
                  connectNulls={false}
                />
              );
            })}
            <ReferenceLine y={0} stroke={C.borderLight} strokeDasharray="2 2" />
            <Legend
              wrapperStyle={{
                fontSize: 11,
                fontFamily: "'Outfit', sans-serif",
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Two-column: Revenue vs Spending, Debt Composition */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Monthly Revenue vs Spending */}
        <ChartCard
          title="Monthly Revenue vs. Spending"
          subtitle={`Billions USD — showing ${monthlySliced.length} of ${monthlyWithDeficit.length} months`}
          height={300}
        >
          <div style={{ padding: "0 12px 8px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.textMuted, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>
              From:
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, monthlyWithDeficit.length - 3)}
              value={effectiveStartIdx}
              onChange={(e) => setMonthlyStartIdx(parseInt(e.target.value))}
              style={{ flex: 1, accentColor: C.accent, cursor: "pointer" }}
            />
            <span style={{ color: C.text, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", minWidth: 60 }}>
              {monthlySliced[0]?.date ? formatDateLabel(monthlySliced[0].date) : "—"}
            </span>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={monthlySliced} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={monthlySliced.length > 24 ? 3 : monthlySliced.length > 12 ? 2 : 0}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}B`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                        {formatDateLabel(label)}
                      </div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: ${Math.abs(p.value)}B{p.dataKey === "deficit" ? (p.value >= 0 ? " surplus" : " deficit") : ""}
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="revenue" name="Revenue" fill={C.green} opacity={0.7} radius={[2, 2, 0, 0]} />
              <Bar dataKey="spending" name="Spending" fill={C.red} opacity={0.7} radius={[2, 2, 0, 0]} />
              <Legend
                wrapperStyle={{
                  fontSize: 11,
                  fontFamily: "'Outfit', sans-serif",
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Debt Composition */}
        <ChartCard
          title="Debt by Security Type"
          subtitle={`As of ${formatDateLabel(latestDebt.date)} — Trillions USD`}
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={debtComposition} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}T`}
              />
              <YAxis
                dataKey="name"
                type="category"
                tick={{ fill: C.textDim, fontSize: 11, fontFamily: "'Outfit', sans-serif" }}
                axisLine={false}
                tickLine={false}
                width={110}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <span style={{ color: d.color, fontWeight: 600 }}>
                        {d.name}: ${d.value}T
                      </span>
                      <span style={{ color: C.textMuted, marginLeft: 8 }}>
                        ({((d.value / latestDebt.total) * 100).toFixed(1)}%)
                      </span>
                    </div>
                  );
                }}
              />
              <Bar dataKey="value" name="Outstanding" radius={[0, 4, 4, 0]}>
                {debtComposition.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Security Type Guide */}
      <div style={{
        margin: "20px 0",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}>
        <button
          onClick={() => setShowGuide(!showGuide)}
          style={{
            width: "100%",
            padding: "12px 20px",
            background: C.surface,
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontFamily: "'Outfit', sans-serif",
            fontSize: 13,
            color: C.textDim,
          }}
        >
          <span>
            <span style={{ color: C.accent, marginRight: 8 }}>ⓘ</span>
            Understanding Treasury Security Types
          </span>
          <span style={{
            transform: showGuide ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            fontSize: 12,
          }}>
            ▼
          </span>
        </button>
        {showGuide && (
          <div style={{
            padding: "0 20px 18px",
            background: C.surface,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "14px 24px",
          }}>
            {[
              {
                name: "T-Bills",
                color: "#60a5fa",
                maturity: "≤ 1 year",
                desc: "Zero-coupon, sold at discount. The closest thing to cash — heavily held by money market funds. Recent surge in issuance means more government debt rolling over frequently.",
              },
              {
                name: "T-Notes",
                color: "#3b82f6",
                maturity: "2–10 years",
                desc: "Pay semiannual coupons. The backbone of federal debt and the benchmark the broader economy prices off — mortgage rates key off the 10-year note.",
              },
              {
                name: "T-Bonds",
                color: "#1d4ed8",
                maturity: "20–30 years",
                desc: "Long-duration, semiannual coupons. Most sensitive to inflation expectations and long-term fiscal outlook. Locks in rates for decades.",
              },
              {
                name: "TIPS",
                color: "#8b5cf6",
                maturity: "5, 10, or 30 years",
                desc: "Principal adjusts with CPI. The spread between a regular note and a TIP of the same maturity gives you the market's inflation forecast (breakeven rate).",
              },
              {
                name: "FRNs",
                color: "#a78bfa",
                maturity: "2 years",
                desc: "Floating Rate Notes — interest resets weekly based on the 13-week T-Bill rate. Appeals to investors who want Treasury safety without betting on rate direction.",
              },
              {
                name: "Intragovernmental",
                color: "#475569",
                maturity: "Non-tradeable",
                desc: "Money the government owes itself — mainly Social Security and Medicare trust funds invested in special Treasury securities. A real obligation, but doesn't trade in markets.",
              },
            ].map((item, i) => (
              <div key={i} style={{ display: "flex", gap: 10 }}>
                <div style={{
                  width: 4,
                  borderRadius: 2,
                  background: item.color,
                  flexShrink: 0,
                  marginTop: 2,
                }} />
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                    <span style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: 13,
                      fontWeight: 600,
                      color: C.text,
                    }}>
                      {item.name}
                    </span>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: item.color,
                      padding: "1px 6px",
                      background: `${item.color}15`,
                      borderRadius: 3,
                    }}>
                      {item.maturity}
                    </span>
                  </div>
                  <div style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: 12,
                    color: C.textMuted,
                    lineHeight: 1.55,
                  }}>
                    {item.desc}
                  </div>
                </div>
              </div>
            ))}
            <div style={{
              gridColumn: "1 / -1",
              marginTop: 6,
              padding: "10px 14px",
              background: `${C.rrp}08`,
              border: `1px solid ${C.rrp}20`,
              borderRadius: 8,
              fontFamily: "'Outfit', sans-serif",
              fontSize: 12,
              color: C.textDim,
              lineHeight: 1.6,
            }}>
              <span style={{ color: C.rrp, fontWeight: 600, marginRight: 6 }}>Why it matters:</span>
              The mix of security types is a strategic choice by the Treasury. Heavy T-Bill issuance means lower auction risk but constant rollover at prevailing rates. 
              More long-dated Bonds lock in rates but risk flooding the long end of the curve. Since mid-2023, Treasury has leaned into Bills — 
              a bet that short-term funding costs will decline as the Fed eventually cuts.
            </div>
          </div>
        )}
      </div>

      {/* Debt Outstanding Over Time */}
      <ChartCard
        title="Total Debt Outstanding"
        subtitle="Public debt vs. intragovernmental holdings — Trillions USD"
        height={280}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={debtChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="gradPublic" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.accent} stopOpacity={0.6} />
                <stop offset="100%" stopColor={C.accent} stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="gradIntra" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.other} stopOpacity={0.5} />
                <stop offset="100%" stopColor={C.other} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateLabel}
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}T`}
              domain={[0, 40]}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="intra" stackId="1" name="Intragovernmental" fill="url(#gradIntra)" stroke={C.other} strokeWidth={0} />
            <Area type="monotone" dataKey="public" stackId="1" name="Held by Public" fill="url(#gradPublic)" stroke={C.accent} strokeWidth={1} />
            <Line type="monotone" dataKey="total" name="Total" stroke={C.text} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
            <Legend
              wrapperStyle={{
                fontSize: 11,
                fontFamily: "'Outfit', sans-serif",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Context Strip */}
      <div style={{
        marginTop: 10,
        padding: "14px 20px",
        background: `${C.red}08`,
        border: `1px solid ${C.red}20`,
        borderRadius: 10,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 13,
        color: C.textDim,
        lineHeight: 1.7,
      }}>
        <span style={{ color: C.red, fontWeight: 600, marginRight: 8 }}>Context</span>
        The FY2025 deficit is running {Math.abs(((latestDeficit.fy2025 - priorYearSameMonth) / priorYearSameMonth * 100)).toFixed(0)}% 
        wider than FY2024 through {latestDeficit.month}, driven by rising net interest costs (now ~${estInterest}T annualized) 
        and elevated spending. Total federal debt has crossed ${latestDebt.total}T, with debt held by the public at ${latestDebt.public}T 
        ({((latestDebt.public / latestDebt.total) * 100).toFixed(0)}% of total). T-Bill issuance has expanded significantly 
        since mid-2023, a deliberate shift toward short-duration funding that lowers auction risk but increases rollover frequency.
      </div>
    </div>
  );
};

// ─── SOVEREIGN HOLDINGS DATA (TIC Major Foreign Holders) ────────────────────
const sovereignDates = [
  "2022-01", "2022-04", "2022-07", "2022-10",
  "2023-01", "2023-04", "2023-07", "2023-10",
  "2024-01", "2024-04", "2024-07", "2024-10",
];

// Holdings in $B by country over time
const sovereignCountries = {
  Japan: {
    color: "#ef4444",
    holdings: [1303, 1232, 1236, 1078, 1104, 1127, 1116, 1098, 1138, 1128, 1116, 1103],
  },
  China: {
    color: "#f59e0b",
    holdings: [1060, 1003, 970, 922, 859, 846, 821, 782, 797, 770, 759, 733],
  },
  "United Kingdom": {
    color: "#3b82f6",
    holdings: [634, 615, 655, 664, 668, 700, 723, 716, 753, 728, 741, 765],
  },
  Luxembourg: {
    color: "#8b5cf6",
    holdings: [315, 309, 299, 318, 332, 345, 351, 370, 373, 386, 398, 412],
  },
  "Cayman Islands": {
    color: "#22d3ee",
    holdings: [264, 275, 284, 290, 305, 312, 325, 338, 354, 363, 372, 389],
  },
  Canada: {
    color: "#10b981",
    holdings: [223, 216, 226, 234, 254, 262, 268, 290, 310, 318, 335, 348],
  },
  Belgium: {
    color: "#f472b6",
    holdings: [265, 244, 222, 253, 269, 286, 298, 306, 312, 316, 326, 338],
  },
  Ireland: {
    color: "#a78bfa",
    holdings: [315, 286, 278, 264, 275, 282, 295, 299, 314, 322, 325, 330],
  },
  Switzerland: {
    color: "#fbbf24",
    holdings: [275, 268, 255, 262, 271, 278, 268, 261, 270, 282, 286, 290],
  },
  Taiwan: {
    color: "#6ee7b7",
    holdings: [253, 237, 225, 216, 226, 234, 241, 248, 257, 253, 266, 274],
  },
  India: {
    color: "#fb923c",
    holdings: [196, 199, 203, 213, 222, 228, 235, 246, 254, 260, 266, 272],
  },
  "Hong Kong": {
    color: "#e879f9",
    holdings: [226, 219, 210, 189, 196, 204, 210, 216, 226, 229, 233, 240],
  },
  Brazil: {
    color: "#34d399",
    holdings: [249, 237, 228, 218, 217, 222, 219, 225, 218, 223, 228, 232],
  },
  Singapore: {
    color: "#93c5fd",
    holdings: [186, 178, 171, 183, 192, 201, 205, 212, 220, 224, 230, 237],
  },
  France: {
    color: "#c084fc",
    holdings: [233, 217, 205, 195, 212, 224, 216, 207, 218, 225, 232, 238],
  },
  "South Korea": {
    color: "#7dd3fc",
    holdings: [108, 103, 99, 105, 112, 118, 123, 128, 132, 128, 125, 130],
  },
  Norway: {
    color: "#67e8f9",
    holdings: [104, 98, 88, 93, 96, 102, 108, 116, 122, 118, 125, 131],
  },
  "Saudi Arabia": {
    color: "#86efac",
    holdings: [119, 115, 110, 108, 112, 118, 125, 132, 135, 140, 142, 145],
  },
  Germany: {
    color: "#fca5a5",
    holdings: [91, 86, 79, 82, 88, 92, 96, 101, 105, 108, 112, 115],
  },
  Bermuda: {
    color: "#d8b4fe",
    holdings: [82, 79, 74, 78, 83, 88, 95, 102, 108, 112, 118, 123],
  },
  Thailand: {
    color: "#bef264",
    holdings: [95, 88, 82, 78, 81, 85, 89, 91, 93, 96, 99, 103],
  },
  Israel: {
    color: "#a5b4fc",
    holdings: [67, 63, 59, 62, 66, 70, 73, 75, 80, 83, 86, 90],
  },
  Philippines: {
    color: "#fcd34d",
    holdings: [54, 49, 45, 47, 48, 50, 52, 54, 55, 57, 59, 62],
  },
  Kuwait: {
    color: "#5eead4",
    holdings: [50, 48, 46, 48, 51, 53, 55, 57, 59, 61, 63, 66],
  },
  Mexico: {
    color: "#f9a8d4",
    holdings: [45, 42, 38, 36, 34, 36, 38, 41, 43, 47, 50, 53],
  },
  Australia: {
    color: "#fdba74",
    holdings: [62, 58, 55, 52, 55, 58, 61, 64, 67, 69, 72, 76],
  },
  UAE: {
    color: "#99f6e4",
    holdings: [55, 52, 49, 51, 54, 58, 62, 66, 70, 72, 74, 78],
  },
  Colombia: {
    color: "#d9f99d",
    holdings: [32, 30, 28, 26, 27, 28, 29, 30, 31, 33, 34, 36],
  },
  Sweden: {
    color: "#fde68a",
    holdings: [41, 38, 35, 37, 39, 42, 44, 46, 48, 50, 52, 55],
  },
  Poland: {
    color: "#c4b5fd",
    holdings: [28, 26, 24, 27, 30, 33, 36, 38, 40, 42, 44, 47],
  },
};

// Total foreign holdings of U.S. Treasuries ($B) — from TIC aggregate line
const totalForeignHoldings = [
  7195, 6878, 6738, 6596, 6748, 6960, 7062, 7148, 7398, 7438, 7568, 7716,
];

// "Other" is dynamically computed as total minus all individually tracked countries
const namedCountryNames = Object.keys(sovereignCountries);
sovereignCountries["Other"] = {
  color: "#64748b",
  holdings: sovereignDates.map((_, i) => {
    const namedSum = namedCountryNames.reduce((sum, name) => sum + sovereignCountries[name].holdings[i], 0);
    return totalForeignHoldings[i] - namedSum;
  }),
};

const countryNames = Object.keys(sovereignCountries);

// ─── SOVEREIGN HOLDINGS DASHBOARD ───────────────────────────────────────────
const SovereignDashboard = ({ liveTIC }) => {
  // Use live data if available, otherwise fall back to hardcoded
  const dates = liveTIC?.dates || sovereignDates;
  const countries = liveTIC?.countries || sovereignCountries;
  const cNames = Object.keys(countries);

  const [selectedDateIdx, setSelectedDateIdx] = useState(dates.length - 1);
  const [compDateIdx, setCompDateIdx] = useState(Math.max(0, dates.length - 13)); // ~1 year ago
  const [hoveredCountry, setHoveredCountry] = useState(null);

  // Reset indices if dates change (live data loads)
  useEffect(() => {
    setSelectedDateIdx(dates.length - 1);
    setCompDateIdx(Math.max(0, dates.length - 13));
  }, [dates.length]);

  const currentDate = dates[selectedDateIdx];
  const compDate = dates[compDateIdx];

  // Build bubble data for selected date
  const bubbleData = useMemo(() => {
    return cNames.map(name => {
      const c = countries[name];
      const current = c.holdings[selectedDateIdx] || 0;
      const comparison = c.holdings[compDateIdx] || 0;
      const change = current - comparison;
      const changePct = comparison > 0 ? ((change / comparison) * 100).toFixed(1) : "0.0";
      return {
        name,
        holdings: current,
        change,
        changePct: parseFloat(changePct),
        color: c.color,
      };
    }).sort((a, b) => b.holdings - a.holdings);
  }, [selectedDateIdx, compDateIdx, countries, cNames]);

  const totalHoldings = bubbleData.reduce((s, d) => s + d.holdings, 0);
  const totalChange = bubbleData.reduce((s, d) => s + d.change, 0);
  const biggestBuyer = bubbleData.reduce((max, d) => d.change > max.change ? d : max);
  const biggestSeller = bubbleData.reduce((min, d) => d.change < min.change ? d : min);

  // Time series for top 5 countries
  const top5 = bubbleData.slice(0, 5).map(d => d.name);
  const timeSeriesData = dates.map((date, i) => {
    const row = { date };
    top5.forEach(name => {
      row[name] = countries[name]?.holdings[i] || 0;
    });
    return row;
  });

  // Custom bubble visualization using divs (more control than recharts scatter)
  const maxHolding = Math.max(...bubbleData.map(d => d.holdings));
  const minSize = 32;
  const maxSize = 105;
  const getSize = (holdings) => {
    const ratio = Math.sqrt(holdings / maxHolding);
    return minSize + (ratio * (maxSize - minSize));
  };

  return (
    <div>
      {/* Stat Cards */}
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <StatCard
          label="Tracked Holdings"
          value={`$${(totalHoldings / 1000).toFixed(2)}T`}
          sub={`${cNames.length} countries, ${formatDateLabel(currentDate)} data`}
          color={C.accent}
        />
        <StatCard
          label="Net Change"
          value={`${totalChange >= 0 ? "+" : "−"}$${fmtComma(Math.abs(totalChange))}B`}
          sub={`vs ${formatDateLabel(compDate)}`}
          color={totalChange >= 0 ? C.green : C.red}
        />
        <StatCard
          label="Largest Buyer"
          value={biggestBuyer.name}
          sub={`+$${fmtComma(biggestBuyer.change)}B (+${biggestBuyer.changePct}%)`}
          color={C.green}
        />
        <StatCard
          label="Largest Seller"
          value={biggestSeller.name}
          sub={`−$${fmtComma(Math.abs(biggestSeller.change))}B (${biggestSeller.changePct}%)`}
          color={C.red}
        />
        <StatCard
          label="Foreign Share of Public Debt"
          value={`~${((totalHoldings / 28900) * 100).toFixed(0)}%`}
          sub={`$${(totalHoldings / 1000).toFixed(1)}T of ~$28.9T public debt`}
          color={C.textDim}
        />
      </div>

      {/* Date Controls */}
      <div style={{
        display: "flex",
        gap: 24,
        marginBottom: 20,
        padding: "14px 20px",
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        alignItems: "center",
        flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: 10,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 6,
          }}>
            Viewing Data From
          </div>
          <input
            type="range"
            min={0}
            max={dates.length - 1}
            value={selectedDateIdx}
            onChange={(e) => setSelectedDateIdx(parseInt(e.target.value))}
            style={{ width: "100%", accentColor: C.accent }}
          />
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: C.textMuted,
            marginTop: 2,
          }}>
            <span>{formatDateLabel(dates[0])}</span>
            <span style={{ color: C.accent, fontWeight: 600 }}>{formatDateLabel(currentDate)}</span>
            <span>{formatDateLabel(dates[dates.length - 1])}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: 10,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: 6,
          }}>
            Comparing Against
          </div>
          <input
            type="range"
            min={0}
            max={dates.length - 1}
            value={compDateIdx}
            onChange={(e) => setCompDateIdx(parseInt(e.target.value))}
            style={{ width: "100%", accentColor: C.textMuted }}
          />
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: C.textMuted,
            marginTop: 2,
          }}>
            <span>{formatDateLabel(dates[0])}</span>
            <span style={{ color: C.textDim, fontWeight: 600 }}>{formatDateLabel(compDate)}</span>
            <span>{formatDateLabel(dates[dates.length - 1])}</span>
          </div>
        </div>
      </div>

      {/* Bubble Chart */}
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "20px",
        marginBottom: 20,
      }}>
        <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <span style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 15,
              fontWeight: 600,
              color: C.text,
            }}>
              Sovereign Holdings
            </span>
            <span style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 12,
              color: C.textMuted,
              marginLeft: 10,
            }}>
              Bubble size = holdings — Border: green = net buyer, red = net seller vs comparison period
            </span>
          </div>
        </div>
        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          justifyContent: "center",
          alignItems: "center",
          padding: "20px 10px",
          minHeight: 300,
        }}>
          {bubbleData.map((d, i) => {
            const size = getSize(d.holdings);
            const isHovered = hoveredCountry === d.name;
            const borderColor = d.change >= 0 ? C.green : C.red;
            return (
              <div
                key={d.name}
                onMouseEnter={() => setHoveredCountry(d.name)}
                onMouseLeave={() => setHoveredCountry(null)}
                style={{
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  background: `${d.color}${isHovered ? "40" : "25"}`,
                  border: `2px solid ${isHovered ? borderColor : d.color}60`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "default",
                  transition: "all 0.2s ease",
                  transform: isHovered ? "scale(1.12)" : "scale(1)",
                  zIndex: isHovered ? 10 : 1,
                  position: "relative",
                  boxShadow: isHovered ? `0 0 20px ${d.color}30` : "none",
                }}
              >
                <div style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: size > 65 ? 11 : size > 48 ? 9 : 7,
                  fontWeight: 600,
                  color: C.text,
                  textAlign: "center",
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: size - 10,
                }}>
                  {d.name.length > 12 && size < 55 ? d.name.slice(0, 6) + "…" : d.name.length > 8 && size < 45 ? d.name.slice(0, 5) + "…" : d.name}
                </div>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: size > 65 ? 10 : size > 45 ? 8 : 7,
                  color: d.color,
                  fontWeight: 600,
                }}>
                  ${d.holdings}B
                </div>
                {size > 48 && (
                  <div style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 8,
                    color: d.change >= 0 ? C.green : C.red,
                    fontWeight: 500,
                  }}>
                    {d.change >= 0 ? "▲" : "▼"}{Math.abs(d.changePct)}%
                  </div>
                )}

                {/* Hover tooltip */}
                {isHovered && (
                  <div style={{
                    position: "absolute",
                    bottom: "calc(100% + 10px)",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: C.surfaceAlt,
                    border: `1px solid ${C.borderLight}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                    whiteSpace: "nowrap",
                    zIndex: 100,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}>
                    <div style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: 13,
                      fontWeight: 600,
                      color: C.text,
                      marginBottom: 6,
                    }}>
                      {d.name}
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, marginBottom: 3 }}>
                      <span style={{ color: C.textMuted }}>Holdings: </span>
                      <span style={{ color: d.color, fontWeight: 600 }}>${fmtComma(d.holdings)}B</span>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, marginBottom: 3 }}>
                      <span style={{ color: C.textMuted }}>Change: </span>
                      <span style={{ color: d.change >= 0 ? C.green : C.red, fontWeight: 600 }}>
                        {d.change >= 0 ? "+" : "−"}${fmtComma(Math.abs(d.change))}B ({d.change >= 0 ? "+" : ""}{d.changePct}%)
                      </span>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                      <span style={{ color: C.textMuted }}>Share: </span>
                      <span style={{ color: C.textDim }}>{((d.holdings / totalHoldings) * 100).toFixed(1)}% of tracked</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Top 5 Holdings Over Time */}
      <ChartCard
        title="Top 5 Holders — Historical Trend"
        subtitle="Billions USD"
        height={280}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={timeSeriesData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateLabel}
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}B`}
              domain={["dataMin - 50", "dataMax + 50"]}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.borderLight}`,
                    borderRadius: 8,
                    padding: "12px 16px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}>
                    <div style={{ color: C.textDim, marginBottom: 8, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                      {formatDateLabel(label)}
                    </div>
                    {payload.sort((a, b) => b.value - a.value).map((p, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBottom: 3 }}>
                        <span style={{ color: p.color }}>{p.name}</span>
                        <span style={{ color: C.text, fontWeight: 600 }}>${fmtComma(p.value)}B</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {top5.map((name) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                name={name}
                stroke={countries[name]?.color || "#888"}
                strokeWidth={2}
                dot={false}
              />
            ))}
            <Legend
              wrapperStyle={{
                fontSize: 11,
                fontFamily: "'Outfit', sans-serif",
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Net Buyer/Seller Table */}
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "20px",
        marginBottom: 20,
      }}>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 15,
          fontWeight: 600,
          color: C.text,
          marginBottom: 4,
        }}>
          Net Buyers & Sellers
        </div>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 12,
          color: C.textMuted,
          marginBottom: 14,
        }}>
          {formatDateLabel(compDate)} → {formatDateLabel(currentDate)} — ranked by absolute change
        </div>
        {/* Compact date sliders */}
        <div style={{
          display: "flex",
          gap: 20,
          marginBottom: 16,
          padding: "12px 16px",
          background: C.surfaceAlt,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 9,
              color: C.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 4,
            }}>
              From
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={0}
                max={dates.length - 1}
                value={compDateIdx}
                onChange={(e) => setCompDateIdx(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: C.textMuted }}
              />
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: C.textDim,
                fontWeight: 600,
                minWidth: 52,
              }}>
                {formatDateLabel(compDate)}
              </span>
            </div>
          </div>
          <div style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: 12,
            color: C.textMuted,
            alignSelf: "flex-end",
            paddingBottom: 4,
          }}>→</div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 9,
              color: C.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: 4,
            }}>
              To
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={0}
                max={dates.length - 1}
                value={selectedDateIdx}
                onChange={(e) => setSelectedDateIdx(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: C.accent }}
              />
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: C.accent,
                fontWeight: 600,
                minWidth: 52,
              }}>
                {formatDateLabel(currentDate)}
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Buyers */}
          <div>
            <div style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 11,
              fontWeight: 600,
              color: C.green,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 10,
            }}>
              ▲ Net Buyers
            </div>
            {bubbleData
              .filter(d => d.change > 0)
              .sort((a, b) => b.change - a.change)
              .map((d, i) => (
                <div key={i} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "7px 0",
                  borderBottom: `1px solid ${C.border}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: d.color }} />
                    <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: C.textDim }}>
                      {d.name}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.textDim }}>
                      ${fmtComma(d.holdings)}B
                    </span>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: C.green,
                      fontWeight: 600,
                      minWidth: 70,
                      textAlign: "right",
                    }}>
                      +${fmtComma(d.change)}B
                    </span>
                  </div>
                </div>
              ))}
          </div>
          {/* Sellers */}
          <div>
            <div style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: 11,
              fontWeight: 600,
              color: C.red,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 10,
            }}>
              ▼ Net Sellers
            </div>
            {bubbleData
              .filter(d => d.change < 0)
              .sort((a, b) => a.change - b.change)
              .map((d, i) => (
                <div key={i} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "7px 0",
                  borderBottom: `1px solid ${C.border}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: d.color }} />
                    <span style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: C.textDim }}>
                      {d.name}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.textDim }}>
                      ${fmtComma(d.holdings)}B
                    </span>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: C.red,
                      fontWeight: 600,
                      minWidth: 70,
                      textAlign: "right",
                    }}>
                      −${fmtComma(Math.abs(d.change))}B
                    </span>
                  </div>
                </div>
              ))}
            {bubbleData.filter(d => d.change < 0).length === 0 && (
              <div style={{
                fontFamily: "'Outfit', sans-serif",
                fontSize: 12,
                color: C.textMuted,
                padding: "10px 0",
              }}>
                No net sellers in this period
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Context Strip */}
      <div style={{
        padding: "14px 20px",
        background: `${C.rrp}08`,
        border: `1px solid ${C.rrp}20`,
        borderRadius: 10,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 13,
        color: C.textDim,
        lineHeight: 1.7,
      }}>
        <span style={{ color: C.rrp, fontWeight: 600, marginRight: 8 }}>Context</span>
        China has been a persistent net seller since 2022, reducing holdings by over $300B. Japan remains the largest 
        single holder but has also trimmed positions. The slack has been picked up by financial centers — the UK, 
        Luxembourg, Cayman Islands, and Belgium (often Euroclear proxies) — as well as emerging buyers like Canada, 
        India, Saudi Arabia, and the UAE, suggesting demand is diversifying from traditional sovereign reserve managers 
        toward a broader mix of private-sector, custodial, and commodity-exporter buyers. The "Other" category captures 
        dozens of smaller holders not individually tracked by the TIC report. Use the sliders to compare any two periods.
      </div>
    </div>
  );
};

// ─── YIELD CURVE & RATES DATA ───────────────────────────────────────────────

// Yield curve snapshots at key dates (% yield by maturity)
const yieldCurves = {
  "Current (Jan '25)": {
    color: "#60a5fa",
    strokeWidth: 2.5,
    data: { "1M": 4.34, "3M": 4.32, "6M": 4.28, "1Y": 4.18, "2Y": 4.22, "3Y": 4.26, "5Y": 4.35, "7Y": 4.45, "10Y": 4.54, "20Y": 4.82, "30Y": 4.72 },
  },
  "Pre-Hike (Jan '22)": {
    color: "#64748b",
    strokeWidth: 1.5,
    dash: "6 3",
    data: { "1M": 0.05, "3M": 0.15, "6M": 0.37, "1Y": 0.59, "2Y": 1.01, "3Y": 1.24, "5Y": 1.55, "7Y": 1.72, "10Y": 1.78, "20Y": 2.14, "30Y": 2.07 },
  },
  "Peak Inversion (Jul '23)": {
    color: "#ef4444",
    strokeWidth: 1.5,
    dash: "4 2",
    data: { "1M": 5.28, "3M": 5.42, "6M": 5.46, "1Y": 5.37, "2Y": 4.87, "3Y": 4.53, "5Y": 4.18, "7Y": 4.06, "10Y": 3.96, "20Y": 4.23, "30Y": 4.01 },
  },
  "Pre-COVID (Jan '20)": {
    color: "#22c55e",
    strokeWidth: 1.5,
    dash: "2 2",
    data: { "1M": 1.54, "3M": 1.54, "6M": 1.56, "1Y": 1.53, "2Y": 1.52, "3Y": 1.53, "5Y": 1.58, "7Y": 1.68, "10Y": 1.76, "20Y": 2.09, "30Y": 2.22 },
  },
};

const maturities = ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];

const curveChartData = maturities.map(mat => {
  const row = { maturity: mat };
  Object.entries(yieldCurves).forEach(([name, curve]) => {
    row[name] = curve.data[mat];
  });
  return row;
});

// Key rates time series (monthly)
const ratesTimeSeries = [
  { date: "2022-01", ffr: 0.08, sofr: 0.05, iorb: 0.15, y2: 1.01, y10: 1.78, y30: 2.07 },
  { date: "2022-04", ffr: 0.33, sofr: 0.30, iorb: 0.40, y2: 2.56, y10: 2.78, y30: 2.86 },
  { date: "2022-07", ffr: 1.58, sofr: 1.55, iorb: 1.65, y2: 2.97, y10: 2.88, y30: 3.07 },
  { date: "2022-10", ffr: 3.08, sofr: 3.05, iorb: 3.15, y2: 4.48, y10: 4.07, y30: 4.17 },
  { date: "2023-01", ffr: 4.33, sofr: 4.30, iorb: 4.40, y2: 4.21, y10: 3.51, y30: 3.62 },
  { date: "2023-04", ffr: 4.83, sofr: 4.80, iorb: 4.90, y2: 4.04, y10: 3.46, y30: 3.67 },
  { date: "2023-07", ffr: 5.12, sofr: 5.10, iorb: 5.15, y2: 4.87, y10: 3.96, y30: 4.01 },
  { date: "2023-10", ffr: 5.33, sofr: 5.31, iorb: 5.40, y2: 5.05, y10: 4.62, y30: 4.78 },
  { date: "2024-01", ffr: 5.33, sofr: 5.31, iorb: 5.40, y2: 4.29, y10: 3.99, y30: 4.21 },
  { date: "2024-04", ffr: 5.33, sofr: 5.31, iorb: 5.40, y2: 4.72, y10: 4.50, y30: 4.64 },
  { date: "2024-07", ffr: 5.33, sofr: 5.31, iorb: 5.40, y2: 4.39, y10: 4.20, y30: 4.41 },
  { date: "2024-10", ffr: 4.83, sofr: 4.80, iorb: 4.90, y2: 4.13, y10: 4.28, y30: 4.51 },
  { date: "2025-01", ffr: 4.33, sofr: 4.30, iorb: 4.40, y2: 4.22, y10: 4.54, y30: 4.72 },
];

// Spread data
const spreadData = ratesTimeSeries.map(d => ({
  ...d,
  spread2s10s: +(d.y10 - d.y2).toFixed(2),
  spread3m10y: +(d.y10 - d.ffr).toFixed(2),
}));

// Breakeven inflation rates
const breakevenData = [
  { date: "2022-01", be5y: 2.87, be10y: 2.41 },
  { date: "2022-04", be5y: 3.30, be10y: 2.91 },
  { date: "2022-07", be5y: 2.51, be10y: 2.33 },
  { date: "2022-10", be5y: 2.33, be10y: 2.22 },
  { date: "2023-01", be5y: 2.28, be10y: 2.21 },
  { date: "2023-04", be5y: 2.18, be10y: 2.19 },
  { date: "2023-07", be5y: 2.23, be10y: 2.27 },
  { date: "2023-10", be5y: 2.36, be10y: 2.33 },
  { date: "2024-01", be5y: 2.16, be10y: 2.21 },
  { date: "2024-04", be5y: 2.38, be10y: 2.35 },
  { date: "2024-07", be5y: 2.14, be10y: 2.22 },
  { date: "2024-10", be5y: 2.31, be10y: 2.29 },
  { date: "2025-01", be5y: 2.42, be10y: 2.36 },
];

// Real yields (nominal minus breakeven)
const realYieldData = ratesTimeSeries.map((d, i) => ({
  date: d.date,
  nominal10y: d.y10,
  real10y: +(d.y10 - (breakevenData[i]?.be10y || 2.3)).toFixed(2),
}));

// ─── YIELDS & RATES DASHBOARD ───────────────────────────────────────────────
const YieldsDashboard = ({ liveRates, liveBreakevens, liveCurve }) => {
  const ratesData = liveRates || ratesTimeSeries;
  const beData = liveBreakevens || breakevenData;

  const liveSpreadData = useMemo(() => ratesData.map(d => ({
    ...d,
    spread2s10s: d.y10 != null && d.y2 != null ? +((d.y10 - d.y2).toFixed(2)) : null,
    spread3m10y: d.y10 != null && d.ffr != null ? +((d.y10 - d.ffr).toFixed(2)) : null,
  })), [ratesData]);

  const liveRealYieldData = useMemo(() => ratesData.map((d, i) => ({
    date: d.date,
    nominal10y: d.y10,
    real10y: d.y10 != null && beData[i]?.be10y != null ? +((d.y10 - beData[i].be10y).toFixed(2)) : null,
  })).filter(d => d.real10y !== null), [ratesData, beData]);

  const liveCurveChartData = useMemo(() => {
    if (liveCurve) {
      const mats = ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];
      return mats.map(mat => {
        const row = { maturity: mat };
        Object.entries(liveCurve).forEach(([name, curve]) => {
          row[name] = curve[mat];
        });
        return row;
      });
    }
    return curveChartData;
  }, [liveCurve]);

  const curveNames = liveCurve ? Object.keys(liveCurve) : Object.keys(yieldCurves);
  const curveStyles = {
    "Current": { color: "#60a5fa", strokeWidth: 2.5, dash: "0" },
    "Pre-COVID (Jan '20)": { color: "#22c55e", strokeWidth: 1.5, dash: "2 2" },
    "Pre-Hike (Jan '22)": { color: "#64748b", strokeWidth: 1.5, dash: "6 3" },
    "Peak Inversion (Jul '23)": { color: "#ef4444", strokeWidth: 1.5, dash: "4 2" },
  };

  const latest = ratesData[ratesData.length - 1] || {};
  const prev = ratesData[ratesData.length - 2] || {};
  const latestSpread = liveSpreadData[liveSpreadData.length - 1] || {};
  const latestBE = beData[beData.length - 1] || {};
  const latestReal = liveRealYieldData[liveRealYieldData.length - 1] || {};

  return (
    <div>
      {/* Stat Cards */}
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <StatCard
          label="Fed Funds Rate"
          value={`${latest.ffr ?? "—"}%`}
          change={prev.ffr ? ((latest.ffr - prev.ffr) * 100 / prev.ffr).toFixed(1) : null}
          sub="effective rate"
          color={C.rrp}
        />
        <StatCard
          label="10Y Treasury"
          value={`${latest.y10 ?? "—"}%`}
          change={prev.y10 ? ((latest.y10 - prev.y10) * 100 / prev.y10).toFixed(1) : null}
          sub="benchmark yield"
          color={C.accent}
        />
        <StatCard
          label="2s10s Spread"
          value={`${latestSpread.spread2s10s != null ? (latestSpread.spread2s10s > 0 ? "+" : "") + latestSpread.spread2s10s : "—"}%`}
          sub={latestSpread.spread2s10s < 0 ? "INVERTED" : "positive (normal)"}
          color={latestSpread.spread2s10s < 0 ? C.red : C.green}
        />
        <StatCard
          label="10Y Breakeven"
          value={`${latestBE.be10y ?? "—"}%`}
          sub="market-implied inflation"
          color="#f472b6"
        />
        <StatCard
          label="10Y Real Yield"
          value={`${latestReal.real10y ?? "—"}%`}
          sub="(nominal − breakeven)"
          color={C.netLiq}
        />
      </div>

      {/* Interactive Yield Curve */}
      <ChartCard
        title="Treasury Yield Curve"
        subtitle="Current vs. key historical snapshots — % yield by maturity"
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={liveCurveChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="maturity"
              tick={{ fill: C.textMuted, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}%`}
              domain={[0, 6]}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.borderLight}`,
                    borderRadius: 8,
                    padding: "12px 16px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}>
                    <div style={{ color: C.textDim, marginBottom: 8, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                      {label} maturity
                    </div>
                    {payload.map((p, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBottom: 3 }}>
                        <span style={{ color: p.color }}>{p.name}</span>
                        <span style={{ color: C.text, fontWeight: 600 }}>{p.value}%</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {curveNames.map(name => {
              const style = curveStyles[name] || { color: "#94a3b8", strokeWidth: 1.5, dash: "0" };
              return (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                name={name}
                stroke={style.color}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dash || "0"}
                dot={name.includes("Current") ? { r: 3, fill: style.color } : false}
              />
              );
            })}
            <Legend
              wrapperStyle={{
                fontSize: 11,
                fontFamily: "'Outfit', sans-serif",
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Two-column: Key Rates + Spreads */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Key Rates Over Time */}
        <ChartCard
          title="Key Policy & Benchmark Rates"
          subtitle="Fed Funds, SOFR, 2Y, 10Y, 30Y"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={ratesData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={2}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 6]}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                        {formatDateLabel(label)}
                      </div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.value}%
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Line type="monotone" dataKey="ffr" name="Fed Funds" stroke={C.rrp} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="sofr" name="SOFR" stroke="#f472b6" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              <Line type="monotone" dataKey="y2" name="2Y Yield" stroke="#22d3ee" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="y10" name="10Y Yield" stroke={C.accent} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="y30" name="30Y Yield" stroke="#8b5cf6" strokeWidth={1.5} dot={false} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Yield Curve Spreads */}
        <ChartCard
          title="Yield Curve Spreads"
          subtitle="2s10s and 3m/10Y — key inversion signals"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={liveSpreadData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={2}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                        {formatDateLabel(label)}
                      </div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.value > 0 ? "+" : ""}{p.value}%
                          {p.value < 0 ? " (inverted)" : ""}
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke={C.red} strokeDasharray="3 3" strokeWidth={1.5} label={{ value: "Inversion Line", fill: C.red, fontSize: 9, fontFamily: "'Outfit', sans-serif", position: "right" }} />
              <Line type="monotone" dataKey="spread2s10s" name="2s10s Spread" stroke={C.accent} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="spread3m10y" name="3m/10Y Spread" stroke={C.rrp} strokeWidth={2} dot={false} strokeDasharray="4 2" />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Two-column: Breakevens + Real Yields */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 20 }}>
        {/* Breakeven Inflation */}
        <ChartCard
          title="Breakeven Inflation Rates"
          subtitle="Market-implied CPI expectations — TIPS spread"
          height={240}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={beData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="gradBE5" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f472b6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f472b6" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gradBE10" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fb923c" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#fb923c" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={2}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
                domain={[1.5, 3.5]}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                        {formatDateLabel(label)}
                      </div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.value}%
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={2.0} stroke={C.textMuted} strokeDasharray="3 3" label={{ value: "Fed 2% target", fill: C.textMuted, fontSize: 9, fontFamily: "'Outfit', sans-serif", position: "right" }} />
              <Area type="monotone" dataKey="be5y" name="5Y Breakeven" fill="url(#gradBE5)" stroke="#f472b6" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="be10y" name="10Y Breakeven" fill="url(#gradBE10)" stroke="#fb923c" strokeWidth={2} dot={false} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Real Yields */}
        <ChartCard
          title="10Y Real Yield"
          subtitle="Nominal 10Y minus 10Y breakeven"
          height={240}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={liveRealYieldData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="gradReal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.netLiq} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={C.netLiq} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
                interval={2}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                        {formatDateLabel(label)}
                      </div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.value}%
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke={C.red} strokeDasharray="3 3" strokeWidth={1} />
              <Area type="monotone" dataKey="real10y" name="10Y Real Yield" fill="url(#gradReal)" stroke={C.netLiq} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="nominal10y" name="10Y Nominal" stroke={C.accent} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Context Strip */}
      <div style={{
        padding: "14px 20px",
        background: `${C.accent}08`,
        border: `1px solid ${C.accent}20`,
        borderRadius: 10,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 13,
        color: C.textDim,
        lineHeight: 1.7,
      }}>
        <span style={{ color: C.accent, fontWeight: 600, marginRight: 8 }}>Context</span>
        {latest.ffr != null ? <>
        The Fed has cut rates {Math.round((5.33 - latest.ffr) * 4)} times ({Math.round((5.33 - latest.ffr) * 100)}bp) from the{" "}
        5.33% peak, bringing the effective rate to {latest.ffr}%. Despite the cuts, long-end yields have 
        risen — the 10Y at {latest.y10}% is above pre-cut levels, reflecting persistent fiscal deficits, 
        resilient growth data, and elevated term premium. The 2s10s spread has steepened back to{" "}
        {latestSpread.spread2s10s > 0 ? "+" : ""}{latestSpread.spread2s10s}% after a prolonged inversion. 
        Real yields remain firmly positive at {latestReal.real10y}%, keeping financial conditions tight even as 
        the Fed eases. Breakeven inflation at {latestBE.be10y}% suggests markets see inflation settling above the 
        Fed's 2% target.
        </> : "Loading live rate data…"}
      </div>

      {/* Reading Guide — Bullet Points */}
      <div style={{
        margin: "20px 0 0",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        background: C.surface,
        padding: "16px 20px",
      }}>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: C.text,
          marginBottom: 14,
        }}>
          <span style={{ color: C.accent, marginRight: 8 }}>ⓘ</span>
          Understanding the Charts
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            {
              title: "Treasury Yield Curve",
              color: C.accent,
              text: "A normal (upward-sloping) curve means longer maturities pay more, reflecting term premium and growth expectations. An inverted curve (short rates above long rates) has historically preceded recessions, as it signals markets expect rate cuts ahead.",
            },
            {
              title: "Key Policy & Benchmark Rates",
              color: C.rrp,
              text: "The Fed Funds rate is the Fed's primary policy tool. SOFR (Secured Overnight Financing Rate) is the benchmark for overnight borrowing backed by Treasuries — it replaced LIBOR. Treasury yields at 2Y, 10Y, and 30Y show how the market is pricing rate expectations across the curve.",
            },
            {
              title: "Yield Curve Spreads",
              color: C.accent,
              text: "The 2s10s spread (10Y minus 2Y) is the most-watched inversion signal — when it goes negative, short-term rates exceed long-term rates, historically foreshadowing recession. The 3m/10Y spread is the Fed's own preferred recession indicator and tends to lead the 2s10s.",
            },
            {
              title: "Breakeven Inflation Rates",
              color: "#f472b6",
              text: "Breakevens are the difference between nominal Treasury yields and TIPS yields of the same maturity — they represent the market's implied inflation expectation over that horizon. Persistently above the Fed's 2% target suggests the market expects the Fed to stay restrictive longer.",
            },
            {
              title: "10Y Real Yield",
              color: C.netLiq,
              text: "The real yield is the nominal yield minus breakeven inflation — it represents the true inflation-adjusted return investors demand. Positive real yields tighten financial conditions; negative real yields (common in 2020–2021) are highly stimulative and tend to boost risk assets.",
            },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 12 }}>
              <div style={{
                width: 4,
                borderRadius: 2,
                background: item.color,
                flexShrink: 0,
                marginTop: 3,
              }} />
              <div>
                <div style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.text,
                  marginBottom: 3,
                }}>
                  {item.title}
                </div>
                <div style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: 12,
                  color: C.textMuted,
                  lineHeight: 1.6,
                }}>
                  {item.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── SOCIAL SECURITY DATA ───────────────────────────────────────────────────

// OASDI Trust Fund balance ($B), revenue, outlays, and surplus/deficit — annual
const trustFundData = [
  { year: 2005, balance: 1859, revenue: 608, outlays: 530, interest: 94, surplus: 78 },
  { year: 2006, balance: 2048, revenue: 643, outlays: 555, interest: 102, surplus: 87 },
  { year: 2007, balance: 2239, revenue: 675, outlays: 595, interest: 110, surplus: 80 },
  { year: 2008, balance: 2419, revenue: 689, outlays: 625, interest: 116, surplus: 64 },
  { year: 2009, balance: 2540, revenue: 689, outlays: 686, interest: 118, surplus: 3 },
  { year: 2010, balance: 2609, revenue: 664, outlays: 713, interest: 118, surplus: -49 },
  { year: 2011, balance: 2678, revenue: 691, outlays: 736, interest: 114, surplus: -46 },
  { year: 2012, balance: 2732, revenue: 731, outlays: 786, interest: 109, surplus: -55 },
  { year: 2013, balance: 2764, revenue: 752, outlays: 823, interest: 103, surplus: -71 },
  { year: 2014, balance: 2790, revenue: 786, outlays: 859, interest: 98, surplus: -73 },
  { year: 2015, balance: 2813, revenue: 827, outlays: 897, interest: 93, surplus: -70 },
  { year: 2016, balance: 2848, revenue: 869, outlays: 922, interest: 88, surplus: -53 },
  { year: 2017, balance: 2892, revenue: 912, outlays: 953, interest: 85, surplus: -41 },
  { year: 2018, balance: 2895, revenue: 920, outlays: 1000, interest: 83, surplus: -80 },
  { year: 2019, balance: 2897, revenue: 981, outlays: 1059, interest: 81, surplus: -78 },
  { year: 2020, balance: 2908, revenue: 1042, outlays: 1107, interest: 76, surplus: -65 },
  { year: 2021, balance: 2852, revenue: 1018, outlays: 1145, interest: 70, surplus: -127 },
  { year: 2022, balance: 2830, revenue: 1155, outlays: 1244, interest: 66, surplus: -89 },
  { year: 2023, balance: 2789, revenue: 1284, outlays: 1392, interest: 67, surplus: -108 },
  { year: 2024, balance: 2722, revenue: 1349, outlays: 1485, interest: 69, surplus: -136 },
];

// Projected trust fund depletion (2025 Trustees Report, Intermediate Assumptions)
const projectedData = [
  { year: 2025, balance: 2540 },
  { year: 2026, balance: 2355 },
  { year: 2027, balance: 2141 },
  { year: 2028, balance: 1899 },
  { year: 2029, balance: 1629 },
  { year: 2030, balance: 1327 },
  { year: 2031, balance: 991 },
  { year: 2032, balance: 619 },
  { year: 2033, balance: 214 },
  { year: 2034, balance: 0 },
  { year: 2035, balance: 0 },
];

const combinedBalanceData = [
  ...trustFundData.map(d => ({ year: d.year, actual: d.balance, projected: null })),
  ...projectedData.map(d => ({ year: d.year, actual: null, projected: d.balance })),
];
// Bridge the actual→projected line
combinedBalanceData.find(d => d.year === 2025).actual = null;
const lastActual = trustFundData[trustFundData.length - 1];
combinedBalanceData.find(d => d.year === 2024).projected = lastActual.balance;

// Revenue vs outlays for chart
const revenueOutlayData = trustFundData.map(d => ({
  year: d.year,
  revenue: d.revenue,
  outlays: d.outlays,
  surplus: d.surplus,
}));

// Demographic data — annual (2025 Trustees Report)
const demographicData = [
  { year: 2005, beneficiaries: 48.4, workers: 159.1, ratio: 3.29, avgBenefit: 1002 },
  { year: 2007, beneficiaries: 49.9, workers: 163.2, ratio: 3.27, avgBenefit: 1044 },
  { year: 2009, beneficiaries: 52.5, workers: 156.5, ratio: 2.98, avgBenefit: 1094 },
  { year: 2010, beneficiaries: 54.0, workers: 156.7, ratio: 2.90, avgBenefit: 1072 },
  { year: 2011, beneficiaries: 55.4, workers: 158.6, ratio: 2.86, avgBenefit: 1082 },
  { year: 2012, beneficiaries: 56.8, workers: 161.0, ratio: 2.83, avgBenefit: 1111 },
  { year: 2013, beneficiaries: 57.9, workers: 163.0, ratio: 2.81, avgBenefit: 1134 },
  { year: 2014, beneficiaries: 59.0, workers: 165.9, ratio: 2.81, avgBenefit: 1152 },
  { year: 2015, beneficiaries: 60.0, workers: 168.5, ratio: 2.81, avgBenefit: 1177 },
  { year: 2016, beneficiaries: 61.0, workers: 170.1, ratio: 2.79, avgBenefit: 1180 },
  { year: 2017, beneficiaries: 62.0, workers: 173.5, ratio: 2.80, avgBenefit: 1232 },
  { year: 2018, beneficiaries: 63.0, workers: 176.5, ratio: 2.80, avgBenefit: 1280 },
  { year: 2019, beneficiaries: 64.1, workers: 178.2, ratio: 2.78, avgBenefit: 1328 },
  { year: 2020, beneficiaries: 65.0, workers: 169.8, ratio: 2.61, avgBenefit: 1389 },
  { year: 2021, beneficiaries: 65.9, workers: 175.1, ratio: 2.66, avgBenefit: 1437 },
  { year: 2022, beneficiaries: 66.8, workers: 179.3, ratio: 2.68, avgBenefit: 1547 },
  { year: 2023, beneficiaries: 68.0, workers: 180.5, ratio: 2.65, avgBenefit: 1705 },
  { year: 2024, beneficiaries: 69.8, workers: 183.0, ratio: 2.62, avgBenefit: 1907 },
];

// Projected ratio decline (2025 Trustees Report, Intermediate)
const projectedDemographic = [
  { year: 2025, ratio: 2.56, projected: true },
  { year: 2030, ratio: 2.31, projected: true },
  { year: 2035, ratio: 2.16, projected: true },
  { year: 2040, ratio: 2.10, projected: true },
  { year: 2050, ratio: 2.04, projected: true },
];

const ratioChartData = [
  ...demographicData.map(d => ({ year: d.year, actual: d.ratio, projected: null })),
  ...projectedDemographic.map(d => ({ year: d.year, actual: null, projected: d.ratio })),
];
ratioChartData.find(d => d.year === 2024).projected = demographicData[demographicData.length - 1].ratio;

// ─── SOCIAL SECURITY DASHBOARD ──────────────────────────────────────────────
const SocialSecurityDashboard = () => {
  const latest = trustFundData[trustFundData.length - 1];
  const prev = trustFundData[trustFundData.length - 2];
  const latestDemo = demographicData[demographicData.length - 1];
  const peakBalance = trustFundData.reduce((max, d) => d.balance > max.balance ? d : max);
  const depletionYear = 2034;
  const yearsToDepletion = depletionYear - latest.year;

  // When did outlays first exceed revenue (excl interest)?
  const firstDeficitYear = trustFundData.find(d => d.surplus < 0)?.year || 2020;

  return (
    <div>
      {/* Stat Cards */}
      <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
        <StatCard
          label="Trust Fund Balance"
          value={`$${(latest.balance / 1000).toFixed(2)}T`}
          change={pctChange(latest.balance, prev.balance)}
          sub={`peak: $${(peakBalance.balance / 1000).toFixed(2)}T (${peakBalance.year})`}
          color={C.rrp}
        />
        <StatCard
          label="Annual Shortfall"
          value={`−$${fmtComma(Math.abs(latest.surplus))}B`}
          sub={`FY${latest.year} (outlays − revenue)`}
          color={C.red}
        />
        <StatCard
          label="Projected Depletion"
          value={depletionYear.toString()}
          sub={`~${yearsToDepletion} years at current trajectory`}
          color={C.red}
        />
        <StatCard
          label="Workers per Beneficiary"
          value={latestDemo.ratio.toFixed(2)}
          sub={`${latestDemo.beneficiaries}M beneficiaries`}
          color={C.accent}
        />
        <StatCard
          label="Avg Monthly Benefit"
          value={`$${fmtComma(latestDemo.avgBenefit)}`}
          sub={`as of ${latestDemo.year}`}
          color={C.green}
        />
      </div>

      {/* Trust Fund Balance with Projected Depletion */}
      <ChartCard
        title="OASDI Trust Fund Balance"
        subtitle="Combined Old-Age & Disability — actual and projected depletion path (Billions USD)"
        height={340}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={combinedBalanceData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <defs>
              <linearGradient id="gradTrustActual" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.rrp} stopOpacity={0.5} />
                <stop offset="100%" stopColor={C.rrp} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="gradTrustProj" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.red} stopOpacity={0.3} />
                <stop offset="100%" stopColor={C.red} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis
              dataKey="year"
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={{ stroke: C.border }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: C.textMuted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v}B`}
              domain={[0, 3200]}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const val = payload.find(p => p.value !== null && p.value !== undefined);
                if (!val) return null;
                return (
                  <div style={{
                    background: C.surface,
                    border: `1px solid ${C.borderLight}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                  }}>
                    <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>
                      {label}
                    </div>
                    {payload.filter(p => p.value !== null).map((p, i) => (
                      <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                        {p.name}: ${fmtComma(p.value)}B
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Area type="monotone" dataKey="actual" name="Actual Balance" fill="url(#gradTrustActual)" stroke={C.rrp} strokeWidth={2} dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="projected" name="Projected" fill="url(#gradTrustProj)" stroke={C.red} strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls={false} />
            <ReferenceLine x={depletionYear} stroke={C.red} strokeDasharray="3 3" label={{ value: `Depletion ${depletionYear}`, fill: C.red, fontSize: 11, fontFamily: "'Outfit', sans-serif", position: "top" }} />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: "'Outfit', sans-serif" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Two-column: Revenue vs Outlays + Annual Surplus/Deficit */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Revenue vs Outlays */}
        <ChartCard
          title="Annual Revenue vs. Outlays"
          subtitle="OASDI total income vs. expenditures — Billions USD"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={revenueOutlayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="year"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}B`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>{label}</div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: ${fmtComma(p.value)}B
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Line type="monotone" dataKey="revenue" name="Revenue" stroke={C.green} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="outlays" name="Outlays" stroke={C.red} strokeWidth={2} dot={false} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Annual Surplus/Deficit */}
        <ChartCard
          title="Annual Cash Flow"
          subtitle="Revenue minus outlays — Billions USD"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={revenueOutlayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="year"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}B`}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0];
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>{label}</div>
                      <div style={{ color: d.value >= 0 ? C.green : C.red, fontWeight: 600 }}>
                        {d.value >= 0 ? "Surplus" : "Deficit"}: {d.value >= 0 ? "+" : "−"}${fmtComma(Math.abs(d.value))}B
                      </div>
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke={C.textMuted} strokeDasharray="3 3" />
              <Bar dataKey="surplus" name="Cash Flow" radius={[3, 3, 0, 0]}>
                {revenueOutlayData.map((entry, i) => (
                  <Cell key={i} fill={entry.surplus >= 0 ? C.green : C.red} opacity={0.7} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Demographic Section Header */}
      <div style={{
        marginTop: 24,
        marginBottom: 16,
        paddingBottom: 8,
        borderBottom: `1px solid ${C.border}`,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 14,
        fontWeight: 600,
        color: C.text,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ color: C.accent, fontSize: 12 }}>◐</span>
        Demographic Indicators
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: C.textMuted,
          fontWeight: 400,
          marginLeft: 4,
        }}>
          The structural forces driving the shortfall
        </span>
      </div>

      {/* Two-column: Worker Ratio + Beneficiaries */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Workers per Beneficiary */}
        <ChartCard
          title="Workers per Beneficiary"
          subtitle="Covered workers paying in per person collecting — actual + projected"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={ratioChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="year"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                domain={[1.5, 3.5]}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>{label}</div>
                      {payload.filter(p => p.value !== null).map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.value.toFixed(2)} workers/beneficiary
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={2.0} stroke={C.red} strokeDasharray="3 3" label={{ value: "Critical threshold", fill: C.red, fontSize: 9, fontFamily: "'Outfit', sans-serif", position: "right" }} />
              <Line type="monotone" dataKey="actual" name="Actual" stroke={C.accent} strokeWidth={2} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="projected" name="Projected" stroke={C.red} strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls={false} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Beneficiaries + Average Benefit */}
        <ChartCard
          title="Beneficiaries & Average Benefit"
          subtitle="Total recipients (millions) and avg monthly benefit ($)"
          height={260}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={demographicData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                dataKey="year"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={{ stroke: C.border }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}M`}
                domain={[45, 75]}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: C.textMuted, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}`}
                domain={[800, 2000]}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div style={{
                      background: C.surface,
                      border: `1px solid ${C.borderLight}`,
                      borderRadius: 8,
                      padding: "10px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                    }}>
                      <div style={{ color: C.textDim, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 13 }}>{label}</div>
                      {payload.map((p, i) => (
                        <div key={i} style={{ color: p.color, fontWeight: 600, marginBottom: 2 }}>
                          {p.name}: {p.dataKey === "beneficiaries" ? `${p.value}M` : `$${fmtComma(p.value)}/mo`}
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar yAxisId="left" dataKey="beneficiaries" name="Beneficiaries" fill={C.accent} opacity={0.35} radius={[2, 2, 0, 0]} />
              <Line yAxisId="right" type="monotone" dataKey="avgBenefit" name="Avg Benefit" stroke={C.green} strokeWidth={2} dot={false} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: "'Outfit', sans-serif" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Context Strip */}
      <div style={{
        marginTop: 20,
        padding: "14px 20px",
        background: `${C.red}08`,
        border: `1px solid ${C.red}20`,
        borderRadius: 10,
        fontFamily: "'Outfit', sans-serif",
        fontSize: 13,
        color: C.textDim,
        lineHeight: 1.7,
      }}>
        <span style={{ color: C.red, fontWeight: 600, marginRight: 8 }}>Context</span>
        Social Security first paid out more than it collected in {firstDeficitYear}, and the shortfall has widened every year since.
        The combined OASDI trust fund peaked at ${(peakBalance.balance / 1000).toFixed(2)}T in {peakBalance.year} and
        is now drawing down to cover the gap — currently at ${(latest.balance / 1000).toFixed(2)}T. At the current trajectory,
        the Trustees project depletion by {depletionYear}, at which point benefits would be automatically cut to ~{" "}
        78% of scheduled levels (payable from ongoing payroll tax revenue alone). The core driver is demographic:
        the worker-to-beneficiary ratio has fallen from 3.3 in 2005 to {latestDemo.ratio.toFixed(2)} today as baby boomers retire, and
        is projected to reach ~2.1 by 2035. Meanwhile, average monthly benefits have risen {" "}
        {((latestDemo.avgBenefit / demographicData[0].avgBenefit - 1) * 100).toFixed(0)}% since 2005 through
        COLA adjustments. When the trust fund redeems its special Treasury securities to cover shortfalls,
        the Treasury must issue additional public debt — directly connecting Social Security's solvency
        to the federal deficit trajectory tracked on the Fiscal tab.
      </div>

      {/* Reading Guide */}
      <div style={{
        margin: "20px 0 0",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        background: C.surface,
        padding: "16px 20px",
      }}>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: C.text,
          marginBottom: 14,
        }}>
          <span style={{ color: C.accent, marginRight: 8 }}>ⓘ</span>
          Key Concepts
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            {
              title: "OASDI Trust Fund",
              color: C.rrp,
              text: "The combined Old-Age and Survivors Insurance (OASI) and Disability Insurance (DI) trust funds. By law, surpluses must be invested in special non-marketable Treasury securities. The \"balance\" represents the accumulated value of these IOUs from the general fund.",
            },
            {
              title: "Revenue vs. Outlays",
              color: C.green,
              text: "Revenue comes primarily from the 12.4% payroll tax (split between employer and employee) plus taxation of benefits. Outlays are benefit payments plus administrative costs. When outlays exceed revenue, the trust fund redeems its Treasury securities to make up the difference.",
            },
            {
              title: "Workers per Beneficiary",
              color: C.accent,
              text: "The fundamental solvency metric. Social Security is a pay-as-you-go system — current workers fund current retirees. As this ratio declines (fewer workers supporting each retiree), the system requires either higher taxes, lower benefits, or trust fund drawdowns. Below 2.0 is considered critical.",
            },
            {
              title: "The Depletion Cliff",
              color: C.red,
              text: "When the trust fund hits zero, Social Security doesn't \"run out of money\" — payroll taxes still flow in. But by law, benefits would be cut to match incoming revenue, roughly a 22% reduction. This is the automatic cut Congress would need to act to prevent.",
            },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", gap: 12 }}>
              <div style={{
                width: 4,
                borderRadius: 2,
                background: item.color,
                flexShrink: 0,
                marginTop: 3,
              }} />
              <div>
                <div style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.text,
                  marginBottom: 3,
                }}>
                  {item.title}
                </div>
                <div style={{
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: 12,
                  color: C.textMuted,
                  lineHeight: 1.6,
                }}>
                  {item.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── SOURCES & DATA DASHBOARD ───────────────────────────────────────────────
const SOURCES = [
  {
    category: "Fed Balance Sheet",
    sources: [
      {
        name: "Federal Reserve H.4.1 Release",
        description: "Factors Affecting Reserve Balances — the primary weekly report of the Fed's balance sheet, including total assets, Treasury/MBS holdings, and liability-side detail.",
        series: "WALCL, TREAST, WSHOMCB, WORAL",
        frequency: "Weekly (Thursday 4:30pm ET)",
        latestReport: "January 30, 2025",
        url: "https://www.federalreserve.gov/releases/h41/current/",
        apiSource: "FRED API",
      },
      {
        name: "Reverse Repo Operations",
        description: "Daily overnight reverse repo facility usage — shows how much cash is parked at the Fed by money market funds and other counterparties.",
        series: "RRPONTSYD",
        frequency: "Daily",
        latestReport: "February 7, 2025",
        url: "https://fred.stlouisfed.org/series/RRPONTSYD",
        apiSource: "FRED API",
      },
      {
        name: "Treasury General Account",
        description: "The U.S. government's operating cash balance at the Fed. Drawdowns add liquidity to the system; rebuilds drain it.",
        series: "WTREGEN",
        frequency: "Weekly (Thursday)",
        latestReport: "January 30, 2025",
        url: "https://fred.stlouisfed.org/series/WTREGEN",
        apiSource: "FRED API",
      },
      {
        name: "Reserve Balances with Federal Reserve Banks",
        description: "Total bank reserves held at the Fed, earning IORB. The key indicator of banking system liquidity.",
        series: "WRESBAL",
        frequency: "Weekly (Thursday)",
        latestReport: "January 30, 2025",
        url: "https://fred.stlouisfed.org/series/WRESBAL",
        apiSource: "FRED API",
      },
    ],
  },
  {
    category: "Fiscal & Deficit",
    sources: [
      {
        name: "Monthly Treasury Statement (MTS)",
        description: "The official monthly report of U.S. government receipts, outlays, and the resulting surplus or deficit. The primary source for fiscal year-to-date deficit tracking.",
        series: "Revenue, Outlays, Deficit",
        frequency: "Monthly (~8th business day)",
        latestReport: "December 2024 (released Jan 13, 2025)",
        url: "https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/",
        apiSource: "Treasury FiscalData API",
      },
      {
        name: "Debt to the Penny",
        description: "Daily total public debt outstanding, broken into debt held by the public and intragovernmental holdings.",
        series: "Total Public Debt Outstanding",
        frequency: "Daily (1 business day lag)",
        latestReport: "February 6, 2025",
        url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/",
        apiSource: "Treasury FiscalData API",
      },
      {
        name: "Treasury Auction Results",
        description: "Results of every Treasury security auction — bid-to-cover ratios, high yield, percentage to direct/indirect bidders.",
        series: "Auction-level data",
        frequency: "Per auction (multiple per week)",
        latestReport: "Varies by security type",
        url: "https://www.treasurydirect.gov/auctions/auction-query/results/",
        apiSource: "TreasuryDirect API",
      },
    ],
  },
  {
    category: "Sovereign Holdings",
    sources: [
      {
        name: "TIC Major Foreign Holders of Treasury Securities",
        description: "Monthly estimates of foreign country holdings of U.S. Treasury securities. The primary source for tracking sovereign buyer/seller behavior.",
        series: "Country-level holdings",
        frequency: "Monthly (~2 month lag)",
        latestReport: "October 2024 (released Dec 18, 2024)",
        url: "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/mfh.txt",
        apiSource: "TIC CSV / Web scrape",
      },
    ],
  },
  {
    category: "Yields & Rates",
    sources: [
      {
        name: "Treasury Yield Curve Rates",
        description: "Daily par yield curve rates from 1-month through 30-year maturities. The foundation for yield curve analysis and 2s10s spread tracking.",
        series: "DGS1MO through DGS30",
        frequency: "Daily (market close)",
        latestReport: "February 7, 2025",
        url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/",
        apiSource: "FRED API",
      },
      {
        name: "SOFR (Secured Overnight Financing Rate)",
        description: "The benchmark overnight rate backed by Treasury repo transactions. Replaced LIBOR as the key reference rate for the financial system.",
        series: "SOFR",
        frequency: "Daily",
        latestReport: "February 7, 2025",
        url: "https://fred.stlouisfed.org/series/SOFR",
        apiSource: "FRED API",
      },
      {
        name: "Breakeven Inflation Rates",
        description: "Difference between nominal Treasury yields and TIPS yields of the same maturity — the market's implied inflation expectation.",
        series: "T5YIE, T10YIE",
        frequency: "Daily",
        latestReport: "February 7, 2025",
        url: "https://fred.stlouisfed.org/series/T10YIE",
        apiSource: "FRED API",
      },
    ],
  },
  {
    category: "Social Security",
    sources: [
      {
        name: "OASDI Trustees Annual Report",
        description: "The definitive annual assessment of Social Security's financial status and 75-year projections. Includes trust fund balances, income/expenditure detail, and the projected depletion date.",
        series: "Trust fund balance, cost rates, income rates",
        frequency: "Annual (typically March–June)",
        latestReport: "2024 Report (released May 6, 2024)",
        url: "https://www.ssa.gov/oact/TR/",
        apiSource: "SSA / Manual update",
      },
      {
        name: "Social Security Beneficiary Statistics",
        description: "Monthly and annual counts of OASDI beneficiaries by type (retired workers, dependents, survivors, disability), plus average benefit amounts.",
        series: "Beneficiary count, avg monthly benefit",
        frequency: "Monthly / Annual",
        latestReport: "December 2024",
        url: "https://www.ssa.gov/oact/STATS/OASDIbenies.html",
        apiSource: "SSA",
      },
      {
        name: "Covered Workers & Worker-to-Beneficiary Ratio",
        description: "Number of workers paying into Social Security relative to the number collecting benefits — the fundamental demographic solvency metric.",
        series: "Covered workers, dependency ratio",
        frequency: "Annual",
        latestReport: "2025 Trustees Report",
        url: "https://www.ssa.gov/oact/STATS/table4a3.html",
        apiSource: "SSA / FRED",
      },
    ],
  },
];

const SourcesDashboard = () => (
  <div>
    {SOURCES.map((cat, ci) => (
      <div key={ci} style={{ marginBottom: 28 }}>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 14,
          fontWeight: 600,
          color: C.text,
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: C.accent,
            display: "inline-block",
          }} />
          {cat.category}
          <span style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: C.textMuted,
            fontWeight: 400,
            marginLeft: 4,
          }}>
            {cat.sources.length} source{cat.sources.length > 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cat.sources.map((src, si) => (
            <div key={si} style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: "16px 20px",
            }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 8,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    color: C.text,
                    marginBottom: 4,
                  }}>
                    {src.name}
                  </div>
                  <div style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: 12,
                    color: C.textMuted,
                    lineHeight: 1.55,
                    maxWidth: 600,
                  }}>
                    {src.description}
                  </div>
                </div>
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: C.accent,
                    textDecoration: "none",
                    padding: "5px 12px",
                    border: `1px solid ${C.accent}40`,
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    marginLeft: 16,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.target.style.background = `${C.accent}15`; }}
                  onMouseLeave={(e) => { e.target.style.background = "transparent"; }}
                >
                  View Source →
                </a>
              </div>
              <div style={{
                display: "flex",
                gap: 20,
                flexWrap: "wrap",
                marginTop: 10,
                paddingTop: 10,
                borderTop: `1px solid ${C.border}`,
              }}>
                {[
                  { label: "Series", value: src.series },
                  { label: "Frequency", value: src.frequency },
                  { label: "Latest Report", value: src.latestReport },
                  { label: "Integration", value: src.apiSource },
                ].map((meta, mi) => (
                  <div key={mi}>
                    <div style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: 9,
                      color: C.textMuted,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      marginBottom: 2,
                    }}>
                      {meta.label}
                    </div>
                    <div style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: meta.label === "Integration" ? C.green : C.textDim,
                    }}>
                      {meta.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    ))}

    {/* Footer note */}
    <div style={{
      marginTop: 10,
      padding: "14px 20px",
      background: `${C.accent}08`,
      border: `1px solid ${C.accent}20`,
      borderRadius: 10,
      fontFamily: "'Outfit', sans-serif",
      fontSize: 12,
      color: C.textDim,
      lineHeight: 1.7,
    }}>
      <span style={{ color: C.accent, fontWeight: 600, marginRight: 8 }}>Note</span>
      All data sourced from U.S. government agencies and the Federal Reserve system. No proprietary market data 
      requiring redistribution licenses is used. FRED API data is provided by the Federal Reserve Bank of St. Louis. 
      Treasury FiscalData and TIC data are provided by the U.S. Department of the Treasury. Report dates reflect 
      the most recent publication as of the last data refresh.
    </div>
  </div>
);

// ─── MAIN APP ───────────────────────────────────────────────────────────────
// ─── SETTINGS PANEL ─────────────────────────────────────────────────────────
const SettingsPanel = ({ apiKey, onSave, onClose }) => {
  const [inputKey, setInputKey] = useState(apiKey || "");
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(4px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: C.surface,
        border: `1px solid ${C.borderLight}`,
        borderRadius: 14,
        padding: "28px 32px",
        width: 480,
        maxWidth: "90vw",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 18,
          fontWeight: 700,
          color: C.text,
          marginBottom: 6,
        }}>
          Settings
        </div>
        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 13,
          color: C.textMuted,
          marginBottom: 20,
          lineHeight: 1.5,
        }}>
          Connect to live data by entering your FRED API key. Free from{" "}
          <span style={{ color: C.accent }}>fred.stlouisfed.org/docs/api/api_key.html</span>
        </div>

        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 11,
          color: C.textMuted,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 6,
        }}>
          FRED API Key
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <input
            type="text"
            value={inputKey}
            onChange={e => setInputKey(e.target.value)}
            placeholder="e.g. abcdef1234567890abcdef1234567890"
            style={{
              flex: 1,
              padding: "10px 14px",
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              color: C.text,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>

        <div style={{
          fontFamily: "'Outfit', sans-serif",
          fontSize: 12,
          color: C.textMuted,
          marginBottom: 20,
          padding: "10px 14px",
          background: C.surfaceAlt,
          borderRadius: 8,
          lineHeight: 1.6,
        }}>
          <span style={{ color: C.green, marginRight: 6 }}>✓</span>
          Treasury FiscalData (debt data) requires no API key and will connect automatically.
          <br />
          <span style={{ color: C.accent, marginRight: 6 }}>ⓘ</span>
          For deployment, set <span style={{ fontFamily: "'JetBrains Mono', monospace", color: C.textDim }}>VITE_FRED_API_KEY</span> in your .env file instead.
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px",
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              color: C.textDim,
              fontFamily: "'Outfit', sans-serif",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => { onSave(inputKey.trim()); onClose(); }}
            style={{
              padding: "8px 18px",
              background: inputKey.trim() ? C.accent : C.border,
              border: "none",
              borderRadius: 8,
              color: inputKey.trim() ? C.bg : C.textMuted,
              fontFamily: "'Outfit', sans-serif",
              fontSize: 13,
              fontWeight: 600,
              cursor: inputKey.trim() ? "pointer" : "default",
              opacity: inputKey.trim() ? 1 : 0.5,
            }}
            disabled={!inputKey.trim()}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState("fed");
  const [fredKey, setFredKey] = useState(import.meta.env.VITE_FRED_API_KEY || "");
  const [showSettings, setShowSettings] = useState(false);
  const { liveData, loadingStatus, errors, lastUpdated } = useDataFetcher(fredKey);

  const dataStatusText = () => {
    const statuses = Object.values(loadingStatus);
    if (!fredKey) return "Illustrative data · Connect API for live data";
    if (statuses.length === 0) return "Connecting to data sources…";
    const live = statuses.filter(s => s === "live").length;
    const loading = statuses.filter(s => s === "loading").length;
    const errors = statuses.filter(s => s === "error").length;
    if (loading > 0) return `Loading data… (${live}/${statuses.length} sources)`;
    if (errors > 0 && live > 0) return `${live} live · ${errors} using fallback data`;
    if (errors > 0 && live === 0) return "Using illustrative data (API errors)";
    if (lastUpdated) return `Live data · Updated ${lastUpdated.toLocaleTimeString()}`;
    return "Live data";
  };

  const statusColor = () => {
    if (!fredKey) return C.textMuted;
    const statuses = Object.values(loadingStatus);
    const loading = statuses.filter(s => s === "loading").length;
    if (loading > 0) return C.rrp;
    const errs = statuses.filter(s => s === "error").length;
    if (errs > 0 && statuses.filter(s => s === "live").length === 0) return C.red;
    if (errs > 0) return C.rrp;
    return C.green;
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: "'Outfit', sans-serif",
    }}>
      {/* Load fonts */}
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

      {/* Top Header */}
      <header style={{
        borderBottom: `1px solid ${C.border}`,
        padding: "14px 28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: C.surfaceAlt,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 32,
            height: 32,
            background: `linear-gradient(135deg, ${C.accent}, ${C.mbs})`,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700,
            fontSize: 14,
            color: "#fff",
          }}>
            Σ
          </div>
          <div>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em", color: C.text }}>
              Sigma Terminal
            </span>
            <span style={{
              fontSize: 10,
              fontWeight: 500,
              color: C.textMuted,
              marginLeft: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              border: `1px solid ${C.border}`,
              padding: "2px 8px",
              borderRadius: 4,
            }}>
              MVP
            </span>
          </div>
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: C.textMuted,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: statusColor(),
            display: "inline-block",
            boxShadow: `0 0 6px ${statusColor()}60`,
          }} />
          {dataStatusText()}
          <button
            onClick={() => setShowSettings(true)}
            style={{
              marginLeft: 8,
              padding: "3px 10px",
              background: fredKey ? "transparent" : C.accent,
              border: `1px solid ${fredKey ? C.border : C.accent}`,
              borderRadius: 6,
              color: fredKey ? C.textMuted : C.bg,
              fontFamily: "'Outfit', sans-serif",
              fontSize: 11,
              fontWeight: fredKey ? 400 : 600,
              cursor: "pointer",
            }}
          >
            {fredKey ? "⚙ Settings" : "⚙ Connect API"}
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel
          apiKey={fredKey}
          onSave={setFredKey}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div style={{ display: "flex", minHeight: "calc(100vh - 61px)" }}>
        {/* Sidebar */}
        <nav style={{
          width: 220,
          borderRight: `1px solid ${C.border}`,
          padding: "20px 0",
          background: C.surfaceAlt,
          flexShrink: 0,
        }}>
          <div style={{
            padding: "0 16px 14px",
            fontSize: 10,
            fontWeight: 600,
            color: C.textMuted,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}>
            Dashboards
          </div>
          {NAV.map((n) => {
            const isActive = activeTab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setActiveTab(n.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "10px 16px",
                  border: "none",
                  background: isActive ? `${C.accent}15` : "transparent",
                  borderLeft: isActive ? `2px solid ${C.accent}` : "2px solid transparent",
                  cursor: "pointer",
                  fontFamily: "'Outfit', sans-serif",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? C.text : C.textDim,
                  textAlign: "left",
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.target.style.background = `${C.accent}08`;
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.target.style.background = "transparent";
                }}
              >
                <span style={{ fontSize: 14, opacity: 0.7 }}>{n.icon}</span>
                <span>{n.label}</span>
                {n.status === "coming" && (
                  <span style={{
                    marginLeft: "auto",
                    fontSize: 8,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: `${C.textMuted}20`,
                    color: C.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}>
                    Soon
                  </span>
                )}
              </button>
            );
          })}

          {/* Data Sources */}
          <div style={{
            margin: "30px 16px 0",
            padding: "14px 0 0",
            borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              color: C.textMuted,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              marginBottom: 10,
            }}>
              Data Sources
            </div>
            {[
              { name: "FRED API", keys: ["fed", "rates", "breakevens", "yieldCurve"] },
              { name: "Treasury FiscalData", keys: ["debt", "mts"] },
              { name: "TIC Reports", keys: ["tic"] },
              { name: "SSA", keys: [], alwaysLive: true },
            ].map((s, i) => {
              const status = s.alwaysLive ? "live"
                : s.keys.length > 0
                ? s.keys.some(k => loadingStatus[k] === "live") ? "live"
                  : s.keys.some(k => loadingStatus[k] === "loading") ? "loading"
                  : s.keys.some(k => loadingStatus[k] === "error") ? "error"
                  : "idle"
                : "idle";
              return (
              <div key={i} style={{
                fontSize: 11,
                color: C.textMuted,
                padding: "4px 0",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: 3,
                  background: status === "live" ? C.green : status === "loading" ? C.rrp : status === "error" ? C.red : C.textMuted,
                  opacity: status === "idle" ? 0.4 : 1,
                }} />
                {s.name}
              </div>
              );
            })}
          </div>
        </nav>

        {/* Main Content */}
        <main style={{
          flex: 1,
          padding: "24px 28px",
          overflowY: "auto",
          maxHeight: "calc(100vh - 61px)",
        }}>
          {/* Page Header */}
          <div style={{ marginBottom: 22 }}>
            <h1 style={{
              fontSize: 22,
              fontWeight: 700,
              color: C.text,
              margin: 0,
              letterSpacing: "-0.02em",
            }}>
              {NAV.find(n => n.id === activeTab)?.label}
            </h1>
            {activeTab === "fed" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Total assets, composition, reverse repo facility, TGA balance, and net liquidity proxy.
                Updated weekly on Thursdays from the Fed's H.4.1 release.
              </p>
            )}
            {activeTab === "fiscal" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Federal deficit tracking, revenue vs. spending, debt outstanding, and composition.
                Sourced from Treasury FiscalData — updated monthly and daily.
              </p>
            )}
            {activeTab === "sovereign" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Foreign sovereign holdings of U.S. Treasuries — who's buying, who's selling, and how allocations are shifting.
                Sourced from Treasury TIC data, ~2 month lag.
              </p>
            )}
            {activeTab === "yields" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Yield curve snapshots, key rates, curve spreads, breakeven inflation, and real yields.
                Sourced from FRED — updated daily.
              </p>
            )}
            {activeTab === "socsec" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Trust fund solvency, revenue vs. outlays, demographic trends, and projected depletion.
                Sourced from SSA 2025 Trustees Report and FRED. Updated annually.
              </p>
            )}
            {activeTab === "sources" && (
              <p style={{
                fontSize: 13,
                color: C.textMuted,
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}>
                Every data source, report, and API integration used across all dashboards — with direct links to the original publications.
              </p>
            )}
          </div>

          {/* Dashboard Content */}
          {fredKey && Object.keys(errors).length > 0 && (
            <div style={{
              marginBottom: 16,
              padding: "12px 16px",
              background: `${C.red}10`,
              border: `1px solid ${C.red}30`,
              borderRadius: 8,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
            }}>
              <div style={{ color: C.red, fontWeight: 600, marginBottom: 6, fontFamily: "'Outfit', sans-serif", fontSize: 12 }}>
                API Connection Errors (using fallback data)
              </div>
              {Object.entries(errors).map(([key, msg]) => (
                <div key={key} style={{ color: C.textMuted, marginBottom: 2 }}>
                  <span style={{ color: C.red }}>✗</span> {key}: {msg}
                </div>
              ))}
            </div>
          )}
          {activeTab === "fed" && <FedDashboard liveData={liveData.fed} />}
          {activeTab === "fiscal" && <FiscalDashboard liveDebt={liveData.debt} liveMTS={liveData.mts} />}
          {activeTab === "sovereign" && <SovereignDashboard liveTIC={liveData.tic} />}
          {activeTab === "yields" && <YieldsDashboard liveRates={liveData.rates} liveBreakevens={liveData.breakevens} liveCurve={liveData.yieldCurve} />}
          {activeTab === "socsec" && <SocialSecurityDashboard />}
          {activeTab === "sources" && <SourcesDashboard />}
          {!["fed","fiscal","sovereign","yields","socsec","sources"].includes(activeTab) && <ComingSoon nav={NAV.find(n => n.id === activeTab)} />}
        </main>
      </div>
    </div>
  );
}
