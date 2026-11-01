const ISOS = ["CAISO", "ERCOT", "MISO", "SPP", "PJM", "NYISO", "ISO-NE", "Non-RTO"];
const ISO_COLORS = {
  CAISO: "#d97706", ERCOT: "#dc2626", MISO: "#0d9488", SPP: "#65a30d",
  PJM: "#2563eb", NYISO: "#9333ea", "ISO-NE": "#db2777", "Non-RTO": "#64748b",
};
// Hand-placed so each region gets one readable label.
const ISO_LABELS = [
  ["CAISO", [-119.6, 37.2]], ["ERCOT", [-99.2, 31.2]], ["MISO", [-92.8, 45.2]], ["MISO", [-91.6, 32.4]],
  ["SPP", [-99.6, 38.6]], ["PJM", [-79.6, 39.9]], ["NYISO", [-75.6, 42.9]], ["ISO-NE", [-71.7, 44.1]],
];
// Repowering waves from the Foundry-Logic / Crux study, mapped onto EIA build years:
// the stated GW totals line up with the fleet reaching ~15-18 years old.
const WAVES = {
  "10-15": [2010, 2015],
  2030: [2001, 2015],
  2035: [2001, 2018],
  2040: [2001, 2022],
};
// NC contract cliff: estimated legacy PURPA expiries, colored soonest (red) to latest (blue).
const EXP_FROM = 2026, EXP_TO = 2040;
const EXP_RAMP = [2026, "#b91c1c", 2029, "#f59e0b", 2033, "#14b8a6", 2040, "#2563eb"];
const NC_BOUNDS = [[-84.4, 33.8], [-75.4, 36.6]];
const FONT = ["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular", "Noto Sans CJK JP Regular"];
// EIA-860 covers plants of 1 MW or more in total; the few smaller solar arrays it lists sit at
// larger industrial plants, so solar starts at 1 MW. Batteries of any size show at the lowest step.
const MW_STEPS = [1, 5, 10, 20, 50, 100, 200];
const YEAR_RAMP = [2008, "#b91c1c", 2013, "#f59e0b", 2018, "#14b8a6", 2024, "#2563eb"];
const UPLIFT_RAMP = [0.1, "#fde68a", 0.3, "#f59e0b", 0.55, "#b91c1c"];

const state = {
  ymin: 2010, ymax: 2015, mw: 5,
  isos: new Set(ISOS), rack: "all", storageOnly: false, color: "uplift",
  view: "national", expBy: 2030, operator: null, list: "gains",
};
let solar = [], storage = [];

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const radius = (k) => ["interpolate", ["linear"], ["zoom"],
  3, ["+", 1.5, ["*", 0.18 * k, ["sqrt", ["get", "mw"]]]],
  8, ["+", 3, ["*", 0.9 * k, ["sqrt", ["get", "mw"]]]]];

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [-97, 38.5],
  zoom: window.innerWidth < 720 ? 2.6 : 3.7,
  minZoom: 2,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

// ---------- filters ----------
// Map expressions and matches() below must stay in sync.
const minStorageMw = () => (state.mw === MW_STEPS[0] ? 0 : state.mw);
function commonTerms(minMw = state.mw) {
  const f = [[">=", ["get", "mw"], minMw]];
  if (state.operator) f.push(["==", ["get", "operator"], state.operator]);
  return f;
}
function nationalTerms() {
  return [
    [">=", ["get", "year"], state.ymin],
    ["<=", ["get", "year"], state.ymax],
    ["in", ["get", "iso"], ["literal", [...state.isos]]],
  ];
}
function solarFilter() {
  const f = ["all", ...commonTerms()];
  if (state.view === "nc") {
    f.push(["has", "exp"], [">=", ["get", "exp"], EXP_FROM], ["<=", ["get", "exp"], state.expBy]);
    return f;
  }
  f.push(...nationalTerms());
  if (state.rack === "fixed") f.push([">=", ["get", "fixed"], 0.5]);
  if (state.rack === "tracking") f.push(["<", ["get", "fixed"], 0.5]);
  if (state.storageOnly) f.push([">", ["get", "st_mw"], 0]);
  return f;
}
function storageFilter() {
  const f = ["all", ...commonTerms(minStorageMw())];
  if (state.view === "nc") f.push(["==", ["get", "state"], "NC"]);
  else f.push(...nationalTerms());
  return f;
}
function matches(p, solarLayer, ignoreOperator = false) {
  if (p.mw < (solarLayer ? state.mw : minStorageMw())) return false;
  if (!ignoreOperator && state.operator && p.operator !== state.operator) return false;
  if (state.view === "nc") return solarLayer ? p.exp >= EXP_FROM && p.exp <= state.expBy : p.state === "NC";
  if (p.year < state.ymin || p.year > state.ymax || !state.isos.has(p.iso)) return false;
  if (!solarLayer) return true;
  if (state.rack === "fixed" && p.fixed < 0.5) return false;
  if (state.rack === "tracking" && p.fixed >= 0.5) return false;
  if (state.storageOnly && !(p.st_mw > 0)) return false;
  return true;
}

function solarColor() {
  if (state.view === "nc") return ["interpolate", ["linear"], ["get", "exp"], ...EXP_RAMP];
  if (state.color === "year") return ["interpolate", ["linear"], ["get", "year"], ...YEAR_RAMP];
  if (state.color === "iso") return ["match", ["get", "iso"], ...ISOS.flatMap((i) => [i, ISO_COLORS[i]]), "#94a3b8"];
  return ["interpolate", ["linear"], ["get", "uplift"], ...UPLIFT_RAMP];
}

function apply() {
  if (!map.getLayer("solar")) return;
  const sf = solarFilter();
  map.setFilter("solar", sf);
  // In the NC view, context is limited to other NC plants (later expiries, non-PURPA sites).
  const ctx = ["!", sf];
  map.setFilter("solar-context", state.view === "nc" ? ["all", ["==", ["get", "state"], "NC"], ctx] : ctx);
  map.setFilter("storage", storageFilter());
  map.setPaintProperty("solar", "circle-color", solarColor());
  // Areas outside an ISO/RTO are left blank.
  const isoF = ["in", ["get", "iso"], ["literal", [...state.isos].filter((i) => i !== "Non-RTO")]];
  for (const id of ["iso-fill", "iso-line", "iso-label"]) map.setFilter(id, isoF);
  document.querySelectorAll("#f-wave button").forEach((b) => {
    const [a, z] = WAVES[b.dataset.v];
    b.classList.toggle("on", a === state.ymin && z === state.ymax);
  });
  document.body.classList.toggle("nc", state.view === "nc");
  updateStats();
  updateLegend();
  if (state.view === "nc") updateChart();
}

const sum = (xs, k) => xs.reduce((a, p) => a + (p[k] || 0), 0);

function updateStats() {
  const s = solar.filter((f) => matches(f.properties, true)).map((f) => f.properties);
  const b = storage.filter((f) => matches(f.properties, false)).map((f) => f.properties);
  const nc = state.view === "nc";
  $("s-sites").textContent = fmt(s.length);
  $("s-gw").textContent = fmt(sum(s, "mw") / 1000, nc ? 2 : 1);
  $("l-gw").innerHTML = nc ? `GW<sub>AC</sub> contracts expiring` : `GW<sub>AC</sub> interconnected`;
  if (nc) {
    $("s-twh").textContent = fmt(sum(s, "bat_mwh") / 1000, 2);
    $("l-twh").textContent = "GWh battery for renewal";
    $("stat-note").innerHTML = `Under Duke's proposal these sites need <span>${fmt(sum(s, "bat_mw"))} MW / ${fmt(sum(s, "bat_mwh"))} MWh</span> of 4-hour storage to earn a 10-year renewal. <span>${fmt(b.length)}</span> NC battery sites ${state.operator ? "run by this operator" : "operate today"}.`;
  } else {
    $("s-twh").textContent = fmt(sum(s, "add_mwh") / 1e6, 1);
    $("l-twh").textContent = "TWh/yr est. added";
    $("stat-note").innerHTML = `<span>${fmt(b.length)}</span> battery sites (<span>${fmt(sum(b, "mw") / 1000, 2)}</span> GW) in the same filter`;
  }
  $("op-chip").hidden = !state.operator;
  $("op-chip-name").textContent = state.operator || "";
  if (state.list === "operators") renderOperators();
  else renderGains(s);
}

function renderGains(s) {
  const nc = state.view === "nc";
  const top = s.sort(nc ? (a, b) => a.exp - b.exp || b.mw - a.mw : (a, b) => b.add_mwh - a.add_mwh).slice(0, 10);
  $("top-list").innerHTML = top.map((p) => `
    <li data-id="${p.id}">
      <div><div class="nm">${esc(p.name)}</div><div class="sub">${p.state} · ${fmt(p.mw)} MW · ${p.years} · ${esc(p.operator)}</div></div>
      ${nc ? `<div class="val">${p.exp}<div class="sub">expires</div></div>` : `<div class="val">+${fmt(p.add_mwh / 1000)}<div class="sub">GWh/yr</div></div>`}
    </li>`).join("") || `<li class="sub" style="cursor:default">No sites match these filters.</li>`;
}

// Portfolio roll-up by EIA operator (usually the asset manager; owners are often project LLCs).
function renderOperators() {
  const nc = state.view === "nc";
  const s = solar.filter((f) => matches(f.properties, true, true)).map((f) => f.properties);
  const by = new Map();
  for (const p of s) {
    const o = by.get(p.operator) || { name: p.operator, mw: 0, n: 0, add: 0, bat: 0, states: new Set() };
    o.mw += p.mw; o.n += 1; o.add += p.add_mwh; o.bat += p.bat_mwh || 0; o.states.add(p.state);
    by.set(p.operator, o);
  }
  const top = [...by.values()].sort((a, b) => b.mw - a.mw).slice(0, 15);
  $("top-list").innerHTML = top.map((o) => `
    <li data-op="${esc(o.name)}" class="${o.name === state.operator ? "active" : ""}">
      <div><div class="nm">${esc(o.name)}</div><div class="sub">${o.n} sites · ${nc ? `${fmt(o.bat)} MWh battery` : `${o.states.size} state${o.states.size > 1 ? "s" : ""} · +${fmt(o.add / 1000)} GWh/yr`}</div></div>
      <div class="val">${fmt(o.mw)}<div class="sub">MW</div></div>
    </li>`).join("") || `<li class="sub" style="cursor:default">No sites match these filters.</li>`;
}

function updateChart() {
  const pts = solar.map((f) => f.properties)
    .filter((p) => p.exp >= EXP_FROM && p.exp <= EXP_TO && p.mw >= state.mw && (!state.operator || p.operator === state.operator));
  const years = [];
  for (let y = EXP_FROM; y <= EXP_TO; y++) years.push(y);
  const mw = years.map((y) => sum(pts.filter((p) => p.exp === y), "mw"));
  const max = Math.max(...mw, 1);
  const color = (y) => {
    for (let i = 0; i < EXP_RAMP.length - 2; i += 2) if (y < EXP_RAMP[i + 2]) return EXP_RAMP[i + 1];
    return EXP_RAMP[EXP_RAMP.length - 1];
  };
  $("nc-chart").innerHTML = years.map((y, i) => `
    <button class="bar ${y <= state.expBy ? "on" : ""}" data-y="${y}" title="${y}: ${fmt(mw[i])} MW expiring">
      <i style="height:${Math.max((mw[i] / max) * 100, 1.5)}%;background:${color(y)}"></i>
      <span>${y % 2 === 0 ? `'${String(y).slice(2)}` : ""}</span>
    </button>`).join("");
}

function updateLegend() {
  const el = $("legend");
  if (state.view === "nc") return;
  if (state.color === "iso") {
    el.innerHTML = `<div class="cats">${ISOS.map((i) => `<span><i style="background:${ISO_COLORS[i]}"></i>${i}</span>`).join("")}</div>`;
    return;
  }
  const ramp = state.color === "year" ? YEAR_RAMP : UPLIFT_RAMP;
  const stops = [];
  for (let i = 0; i < ramp.length; i += 2) stops.push(ramp[i + 1]);
  const [lo, hi] = state.color === "year" ? ["≤2008", "2024+"] : ["≤10% uplift", "55%+"];
  el.innerHTML = `<div class="ramp" style="background:linear-gradient(90deg,${stops.join(",")})"></div><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
}

// ---------- popups ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function market(p) {
  return p.iso === "Non-RTO" ? `No RTO${p.ba ? ` (${p.ba})` : ""}` : p.iso;
}
function row(k, v) { return v == null || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`; }

function solarPopup(p) {
  const rack = p.fixed >= 0.99 ? "Fixed tilt (static)" : p.fixed <= 0.01 ? "Single-axis tracking" : `${Math.round(p.fixed * 100)}% fixed tilt, rest tracking`;
  const tech = p.thin >= 0.5 ? "Thin-film" : "Crystalline Si";
  return `<div class="pop">
    <h3>${esc(p.name)}</h3>
    <div class="where">${esc(p.county)} County, ${p.state} · ${market(p)}</div>
    <dl>
      ${row("Capacity", `${fmt(p.mw, 1)} MW<sub>AC</sub>${p.dc ? ` / ${fmt(p.dc, 1)} MW<sub>DC</sub>` : ""}`)}
      ${row("Commissioned", p.years)}
      ${row("Racking", rack)}
      ${row("Modules", tech)}
      ${row("Grid voltage", p.kv ? `${p.kv} kV` : null)}
      ${row("Battery on site", p.st_mw ? `${fmt(p.st_mw, 1)} MW / ${fmt(p.st_mwh, 1)} MWh` : null)}
      ${row("Operator", esc(p.operator))}
      ${row("PURPA QF", p.exp ? `Yes · contract ${p.exp < EXP_FROM ? `ended ~${p.exp} (may have renewed)` : `ends ~${p.exp}`} (est.)` : p.qf ? "Yes" : null)}
      ${row("Battery for 10-yr renewal", p.exp ? `${fmt(p.bat_mw, 1)} MW / ${fmt(p.bat_mwh, 1)} MWh` : null)}
    </dl>
    <div class="hl">Est. repowering uplift <strong>+${Math.round(p.uplift * 100)}%</strong> ≈ +${fmt(p.add_mwh / 1000, 1)} GWh/yr within the same interconnection</div>
    <div class="own">Owners: ${esc(p.owners)}</div>
  </div>`;
}
function storagePopup(p) {
  return `<div class="pop">
    <h3>${esc(p.name)}</h3>
    <div class="where">${esc(p.county)} County, ${p.state} · ${market(p)}</div>
    <dl>
      ${row("Power", `${fmt(p.mw, 1)} MW`)}
      ${row("Energy", p.mwh ? `${fmt(p.mwh, 1)} MWh (${fmt(p.mwh / p.mw, 1)} h)` : null)}
      ${row("Commissioned", p.year)}
      ${row("Chemistry", p.chem)}
      ${row("Grid voltage", p.kv ? `${p.kv} kV` : null)}
      ${row("Operator", esc(p.operator))}
    </dl>
    <div class="hl st">Battery storage · ${2025 - p.year} years old</div>
    <div class="own">Owners: ${esc(p.owners)}</div>
  </div>`;
}

const popup = new maplibregl.Popup({ maxWidth: "340px", offset: 8 });
function showPopup(feature) {
  const p = feature.properties;
  const html = feature.layer.id === "storage" ? storagePopup(p) : solarPopup(p);
  popup.setLngLat(feature.geometry.coordinates).setHTML(html).addTo(map);
}

// ---------- map layers ----------
map.on("load", async () => {
  const [s, b, isos, meta] = await Promise.all(["data/solar.geojson", "data/storage.geojson", "data/isos.geojson", "data/meta.json"].map((u) => fetch(u).then((r) => r.json())));
  solar = s.features; storage = b.features;
  $("data-src").textContent = meta.source;

  map.addSource("solar", { type: "geojson", data: s });
  map.addSource("storage", { type: "geojson", data: b });
  map.addSource("isos", { type: "geojson", data: isos });
  map.addSource("iso-labels", {
    type: "geojson",
    data: { type: "FeatureCollection", features: ISO_LABELS.map(([t, c, iso]) => ({ type: "Feature", properties: { t, iso: iso || t }, geometry: { type: "Point", coordinates: c } })) },
  });

  // Region shading sits under the basemap labels; plants and region names sit on top.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const isoColor = ["match", ["get", "iso"], ...ISOS.flatMap((i) => [i, ISO_COLORS[i]]), "#64748b"];
  map.addLayer({
    id: "iso-fill", type: "fill", source: "isos",
    paint: { "fill-color": isoColor, "fill-opacity": 0.16 },
  }, firstSymbol);
  map.addLayer({
    id: "iso-line", type: "line", source: "isos",
    paint: {
      "line-color": isoColor, "line-opacity": 0.9,
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 8, 2.2],
    },
  }, firstSymbol);

  map.addLayer({
    id: "solar-context", type: "circle", source: "solar", layout: { visibility: "none" },
    paint: { "circle-radius": radius(0.7), "circle-color": "#60a5fa", "circle-opacity": 0.4 },
  });
  map.addLayer({
    id: "solar", type: "circle", source: "solar",
    paint: {
      "circle-radius": radius(1), "circle-color": solarColor(), "circle-opacity": 0.85,
    },
  });
  map.addLayer({
    id: "storage", type: "circle", source: "storage",
    paint: {
      "circle-radius": radius(1.1), "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#84cc16", "circle-stroke-width": 1.6,
    },
  });
  map.addLayer({
    id: "iso-label", type: "symbol", source: "iso-labels", maxzoom: 6.5,
    layout: { "text-field": ["get", "t"], "text-font": FONT, "text-size": 12, "text-letter-spacing": 0.12, "text-allow-overlap": true },
    paint: { "text-color": isoColor, "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.6 },
  });

  for (const id of ["solar", "storage", "solar-context"]) {
    map.on("click", id, (e) => showPopup(e.features[0]));
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  apply();
});

// ---------- controls ----------
function initControls() {
  const ymin = $("f-ymin"), ymax = $("f-ymax"), mw = $("f-mw");
  mw.max = MW_STEPS.length - 1;
  mw.value = MW_STEPS.indexOf(state.mw);
  const syncYears = (changed) => {
    let a = +ymin.value, b = +ymax.value;
    if (a > b) { if (changed === ymin) b = a; else a = b; ymin.value = a; ymax.value = b; }
    state.ymin = a; state.ymax = b;
    $("o-years").textContent = a === b ? `${a}` : `${a} – ${b}  (${2025 - b}–${2025 - a} yrs old)`;
  };
  ymin.oninput = () => { syncYears(ymin); apply(); };
  ymax.oninput = () => { syncYears(ymax); apply(); };
  syncYears();
  const syncMw = () => { state.mw = MW_STEPS[+mw.value]; $("o-mw").textContent = `≥ ${state.mw} MW`; };
  mw.oninput = () => { syncMw(); apply(); };
  let prevMw = mw.value;
  syncMw();

  $("f-iso").innerHTML = ISOS.map((i) => `<button class="on" data-v="${i}" style="color:${ISO_COLORS[i]}"><i style="background:${ISO_COLORS[i]}"></i><span style="color:var(--text)">${i}</span></button>`).join("");
  $("f-iso").onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const v = btn.dataset.v;
    // Clicking a chip while all are on isolates it; otherwise toggle.
    if (state.isos.size === ISOS.length) state.isos = new Set([v]);
    else if (state.isos.has(v)) state.isos.delete(v);
    else state.isos.add(v);
    if (state.isos.size === 0) state.isos = new Set(ISOS);
    $("f-iso").querySelectorAll("button").forEach((b) => b.classList.toggle("on", state.isos.has(b.dataset.v)));
    apply();
  };

  for (const [id, key] of [["f-rack", "rack"], ["f-color", "color"]]) {
    $(id).onclick = (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state[key] = btn.dataset.v;
      $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
      apply();
    };
  }
  $("f-storage").onchange = (e) => { state.storageOnly = e.target.checked; apply(); };

  const layerToggles = { "l-solar": ["solar"], "l-storage": ["storage"], "l-context": ["solar-context"], "l-iso": ["iso-fill", "iso-line", "iso-label"] };
  for (const [box, layers] of Object.entries(layerToggles)) {
    $(box).onchange = (e) => layers.forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none"));
  }

  $("f-wave").onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    [ymin.value, ymax.value] = WAVES[btn.dataset.v];
    syncYears();
    apply();
  };

  $("f-view").onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.dataset.v === state.view) return;
    state.view = btn.dataset.v;
    state.operator = null;
    // NC legacy QFs are mostly ≤5 MW, so the cliff view starts at the smallest size; national restores the old cutoff.
    if (state.view === "nc") { prevMw = mw.value; mw.value = 0; } else mw.value = prevMw;
    syncMw();
    $("f-view").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    if (state.view === "nc") map.fitBounds(NC_BOUNDS, { padding: { top: 40, bottom: 40, right: 40, left: window.innerWidth < 720 ? 20 : 400 } });
    else map.flyTo({ center: [-97, 38.5], zoom: window.innerWidth < 720 ? 2.6 : 3.7 });
    apply();
  };
  const setExpBy = (y) => {
    state.expBy = y;
    $("f-exp").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === y));
    $("o-exp").textContent = `${EXP_FROM} – ${y}`;
    apply();
  };
  $("f-exp").onclick = (e) => { const b = e.target.closest("button"); if (b) setExpBy(+b.dataset.v); };
  $("nc-chart").onclick = (e) => { const b = e.target.closest("button"); if (b) setExpBy(+b.dataset.y); };
  $("o-exp").textContent = `${EXP_FROM} – ${state.expBy}`;

  $("f-list").onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.list = btn.dataset.v;
    $("f-list").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    updateStats();
  };
  $("op-chip-x").onclick = () => { state.operator = null; apply(); };

  $("top-list").onclick = (e) => {
    const op = e.target.closest("li[data-op]");
    if (op) {
      state.operator = state.operator === op.dataset.op ? null : op.dataset.op;
      apply();
      return;
    }
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const f = solar.find((x) => x.properties.id === +li.dataset.id);
    map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 8), speed: 1.6 });
    showPopup({ ...f, layer: { id: "solar" } });
    if (window.innerWidth < 720) $("panel").classList.add("collapsed");
  };

  $("open-about").onclick = () => $("about").showModal();
  $("about").onclick = (e) => { if (e.target === $("about")) $("about").close(); };
  $("toggle-panel").onclick = () => {
    const c = $("panel").classList.toggle("collapsed");
    $("toggle-panel").textContent = c ? "+" : "–";
  };
}
initControls();
