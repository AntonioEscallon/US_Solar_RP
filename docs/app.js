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
const FONT = ["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular", "Noto Sans CJK JP Regular"];
const MW_STEPS = [0, 1, 5, 10, 20, 50, 100, 200];
const YEAR_RAMP = [2008, "#b91c1c", 2013, "#f59e0b", 2018, "#14b8a6", 2024, "#2563eb"];
const UPLIFT_RAMP = [0.1, "#fde68a", 0.3, "#f59e0b", 0.55, "#b91c1c"];

const state = {
  ymin: 2010, ymax: 2015, mw: 5,
  isos: new Set(ISOS), rack: "all", storageOnly: false, color: "uplift",
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
function baseFilter() {
  return ["all",
    [">=", ["get", "year"], state.ymin],
    ["<=", ["get", "year"], state.ymax],
    [">=", ["get", "mw"], state.mw],
    ["in", ["get", "iso"], ["literal", [...state.isos]]],
  ];
}
function solarFilter() {
  const f = baseFilter();
  if (state.rack === "fixed") f.push([">=", ["get", "fixed"], 0.5]);
  if (state.rack === "tracking") f.push(["<", ["get", "fixed"], 0.5]);
  if (state.storageOnly) f.push([">", ["get", "st_mw"], 0]);
  return f;
}
function matches(p, solarLayer) {
  if (p.year < state.ymin || p.year > state.ymax || p.mw < state.mw || !state.isos.has(p.iso)) return false;
  if (!solarLayer) return true;
  if (state.rack === "fixed" && p.fixed < 0.5) return false;
  if (state.rack === "tracking" && p.fixed >= 0.5) return false;
  if (state.storageOnly && !(p.st_mw > 0)) return false;
  return true;
}

function solarColor() {
  if (state.color === "year") return ["interpolate", ["linear"], ["get", "year"], ...YEAR_RAMP];
  if (state.color === "iso") return ["match", ["get", "iso"], ...ISOS.flatMap((i) => [i, ISO_COLORS[i]]), "#94a3b8"];
  return ["interpolate", ["linear"], ["get", "uplift"], ...UPLIFT_RAMP];
}

function apply() {
  if (!map.getLayer("solar")) return;
  const sf = solarFilter();
  map.setFilter("solar", sf);
  map.setFilter("solar-context", ["!", sf]);
  map.setFilter("storage", baseFilter());
  map.setPaintProperty("solar", "circle-color", solarColor());
  // Areas outside an ISO/RTO are left blank.
  const isoF = ["in", ["get", "iso"], ["literal", [...state.isos].filter((i) => i !== "Non-RTO")]];
  for (const id of ["iso-fill", "iso-line", "iso-label"]) map.setFilter(id, isoF);
  document.querySelectorAll("#f-wave button").forEach((b) => {
    const [a, z] = WAVES[b.dataset.v];
    b.classList.toggle("on", a === state.ymin && z === state.ymax);
  });
  updateStats();
  updateLegend();
}

function updateStats() {
  const s = solar.filter((f) => matches(f.properties, true)).map((f) => f.properties);
  const b = storage.filter((f) => matches(f.properties, false)).map((f) => f.properties);
  $("s-sites").textContent = fmt(s.length);
  $("s-gw").textContent = fmt(s.reduce((a, p) => a + p.mw, 0) / 1000, 1);
  $("s-twh").textContent = fmt(s.reduce((a, p) => a + p.add_mwh, 0) / 1e6, 1);
  $("s-storage").textContent = fmt(b.length);
  $("s-storage-gw").textContent = fmt(b.reduce((a, p) => a + p.mw, 0) / 1000, 2);

  const top = s.sort((a, b) => b.add_mwh - a.add_mwh).slice(0, 10);
  $("top-list").innerHTML = top.map((p) => `
    <li data-id="${p.id}">
      <div><div class="nm">${esc(p.name)}</div><div class="sub">${p.state} · ${fmt(p.mw)} MW · ${p.years} · ${p.iso}</div></div>
      <div class="val">+${fmt(p.add_mwh / 1000)}<div class="sub">GWh/yr</div></div>
    </li>`).join("") || `<li class="sub" style="cursor:default">No sites match these filters.</li>`;
}

function updateLegend() {
  const el = $("legend");
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
  const syncMw = () => { state.mw = MW_STEPS[+mw.value]; $("o-mw").textContent = state.mw ? `≥ ${state.mw} MW` : "Any"; };
  mw.oninput = () => { syncMw(); apply(); };
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

  $("top-list").onclick = (e) => {
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
