import { PRODUCT_NAME } from "../config.ts";

export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${PRODUCT_NAME} · System Status</title>
<meta name="description" content="Live operational status for ${PRODUCT_NAME}." />
<style>
  :root {
    --bg:#0b0b0e; --panel:#161619; --panel-2:#1c1c20; --border:#27272c; --hair:#1f1f24;
    --text:#ededf0; --muted:#9b9ba4; --faint:#6c6c75;
    --ok:#34d399; --degraded:#fbbf24; --partial:#fb923c; --major:#f87171; --nodata:#2d2d33;
    --radius:14px; --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.5);
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f7f8; --panel:#fff; --panel-2:#fafafb; --border:#e7e7ea; --hair:#eeeef0;
      --text:#16161a; --muted:#6a6a73; --faint:#9a9aa2; --nodata:#e6e6ea;
      --shadow:0 1px 2px rgba(0,0,0,.04), 0 8px 24px -16px rgba(0,0,0,.18); }
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 72px; }

  header { display:flex; align-items:baseline; gap:10px; margin-bottom:28px; }
  header .logo { font-weight:700; font-size:19px; letter-spacing:-.02em; }
  header .sub { color:var(--muted); font-size:13px; font-weight:500; }

  /* overall banner */
  .banner { border:1px solid var(--border); border-radius:var(--radius);
    background:var(--panel); box-shadow:var(--shadow); padding:22px; margin-bottom:34px;
    display:flex; align-items:center; gap:14px; }
  .banner .dot { width:13px; height:13px; border-radius:50%; flex:none; box-shadow:0 0 0 4px transparent; }
  .banner .btext { font-weight:650; font-size:17px; letter-spacing:-.01em; }
  .banner .when { margin-left:auto; color:var(--faint); font-size:12px; white-space:nowrap; }
  .banner.operational .dot{background:var(--ok); box-shadow:0 0 0 4px rgba(52,211,153,.16);}
  .banner.degraded .dot{background:var(--degraded); box-shadow:0 0 0 4px rgba(251,191,36,.16);}
  .banner.partial_outage .dot{background:var(--partial); box-shadow:0 0 0 4px rgba(251,146,60,.16);}
  .banner.major_outage .dot{background:var(--major); box-shadow:0 0 0 4px rgba(248,113,113,.16);}
  .banner.unknown .dot{background:var(--muted);} .banner.unknown .btext{ color:var(--muted); }

  .section-head { display:flex; align-items:center; justify-content:space-between; margin:0 2px 12px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:0; font-weight:650; }
  .legend { display:flex; gap:14px; color:var(--faint); font-size:11px; }
  .legend span { display:inline-flex; align-items:center; gap:5px; }
  .legend i { width:9px; height:9px; border-radius:2px; display:inline-block; }

  .panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden; }
  .comp { padding:18px 20px; }
  .comp + .comp { border-top:1px solid var(--hair); }
  .comp-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .comp-name { font-weight:600; font-size:14.5px; letter-spacing:-.01em; }
  .comp-desc { color:var(--muted); font-size:12.5px; margin-top:2px; }
  .comp-right { display:flex; align-items:center; gap:12px; flex:none; }
  .lat { color:var(--faint); font-size:12px; font-variant-numeric:tabular-nums; }
  .pill { font-size:11.5px; font-weight:650; padding:4px 11px; border-radius:999px; white-space:nowrap; letter-spacing:.01em; }
  .pill.operational { color:var(--ok); background:color-mix(in srgb, var(--ok) 15%, transparent); }
  .pill.degraded { color:var(--degraded); background:color-mix(in srgb, var(--degraded) 18%, transparent); }
  .pill.partial_outage { color:var(--partial); background:color-mix(in srgb, var(--partial) 18%, transparent); }
  .pill.major_outage { color:var(--major); background:color-mix(in srgb, var(--major) 18%, transparent); }

  .bars { display:flex; gap:3px; margin-top:16px; height:34px; align-items:stretch; }
  .bar { flex:1 1 0; min-width:0; border-radius:3px; background:var(--nodata); transition:transform .08s ease, filter .08s ease; }
  .bar:hover { transform:scaleY(1.06); filter:brightness(1.15); }
  .bar.ok{background:var(--ok);} .bar.warn{background:var(--degraded);} .bar.part{background:var(--partial);} .bar.bad{background:var(--major);}
  .bars-meta { display:flex; align-items:center; justify-content:space-between; color:var(--faint); font-size:11.5px; margin-top:9px; }
  .bars-meta .mid { color:var(--muted); font-variant-numeric:tabular-nums; }
  .uptimes { display:flex; gap:16px; margin-top:2px; }
  .uptimes b { font-variant-numeric:tabular-nums; color:var(--text); font-weight:600; }
  .uptimes span { color:var(--faint); font-size:12px; }

  .incident { padding:16px 20px; }
  .incident + .incident { border-top:1px solid var(--hair); }
  .incident .row1 { display:flex; align-items:center; gap:10px; }
  .incident strong { font-weight:600; }
  .incident .when { color:var(--faint); font-size:12px; margin-top:4px; }
  .empty { padding:22px 20px; color:var(--muted); display:flex; align-items:center; gap:9px; }
  .empty .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); }

  footer { margin-top:40px; color:var(--faint); font-size:12px; text-align:center; line-height:1.7; }
  @media (max-width:520px){ .wrap{padding:32px 14px 56px;} .legend{display:none;} .comp-desc{display:none;} }
</style>
</head>
<body>
<div class="wrap">
  <header><span class="logo">${PRODUCT_NAME}</span><span class="sub">System Status</span></header>

  <div id="banner" class="banner unknown"><span class="dot"></span><span id="banner-text" class="btext">Loading…</span><span id="when" class="when"></span></div>

  <div class="section-head">
    <h2>Components</h2>
    <div class="legend">
      <span><i style="background:var(--ok)"></i>Operational</span>
      <span><i style="background:var(--degraded)"></i>Degraded</span>
      <span><i style="background:var(--major)"></i>Outage</span>
      <span><i style="background:var(--nodata)"></i>No data</span>
    </div>
  </div>
  <div id="components" class="panel"><div class="empty">Loading…</div></div>

  <div class="section-head" style="margin-top:34px"><h2>Past incidents</h2></div>
  <div id="incidents" class="panel"><div class="empty">Loading…</div></div>

  <footer>
    <div id="updated"></div>
    <div>Auto-refreshes every 30s · powered by ${PRODUCT_NAME}</div>
  </footer>
</div>
<script>
const STATUS_TEXT = {
  operational:"All Systems Operational", degraded:"Degraded Performance",
  partial_outage:"Partial System Outage", major_outage:"Major System Outage", unknown:"Status Unavailable",
};
const PILL = { operational:"Operational", degraded:"Degraded", partial_outage:"Partial Outage", major_outage:"Major Outage" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = (v) => v == null ? "—" : (v >= 1000 ? (v/1000).toFixed(2)+"s" : Math.round(v)+"ms");
const up = (v) => v == null ? "—" : (v >= 99.995 ? "100%" : v.toFixed(2)+"%");
function barClass(u){ if(u==null) return ""; if(u>=99.5) return "ok"; if(u>=97) return "warn"; if(u>=90) return "part"; return "bad"; }

async function load() {
  try {
    const [summary, incidents] = await Promise.all([
      fetch("/api/status/summary").then(r => r.json()),
      fetch("/api/status/incidents").then(r => r.json()),
    ]);
    renderBanner(summary.overall);
    renderComponents(summary.components || []);
    renderIncidents(incidents || []);
    document.getElementById("updated").textContent =
      "Last updated " + new Date(summary.updatedAt).toLocaleString();
    document.getElementById("when").textContent = new Date(summary.updatedAt).toLocaleTimeString();
  } catch (e) {
    renderBanner("unknown");
    document.getElementById("banner-text").textContent = "Status temporarily unavailable";
  }
}

function renderBanner(overall) {
  const b = document.getElementById("banner");
  b.className = "banner " + (overall || "unknown");
  document.getElementById("banner-text").textContent = STATUS_TEXT[overall] || "Unknown";
}

function renderComponents(components) {
  if (!components.length) { document.getElementById("components").innerHTML = '<div class="empty">No components reported.</div>'; return; }
  document.getElementById("components").innerHTML = components.map((c) => {
    const bars = c.bars.map((b) =>
      '<div class="bar ' + barClass(b.uptime) + '" title="' + esc(b.day) + ' · ' +
      (b.uptime == null ? "no data" : up(b.uptime) + " uptime") + '"></div>').join("");
    // Model API latency is an internal metric (see Grafana) — never surface it publicly.
    const lat = (c.key !== "api" && c.latencyMs != null) ? '<span class="lat">' + ms(c.latencyMs) + '</span>' : '';
    return '<div class="comp"><div class="comp-head"><div><div class="comp-name">' + esc(c.label) + '</div>' +
      '<div class="comp-desc">' + esc(c.description) + '</div></div>' +
      '<div class="comp-right">' + lat + '<span class="pill ' + esc(c.status) + '">' + (PILL[c.status] || esc(c.status)) + '</span></div></div>' +
      '<div class="bars">' + bars + '</div>' +
      '<div class="bars-meta"><span>90 days ago</span>' +
        '<span class="mid">' + up(c.uptime.d90) + ' uptime</span>' +
        '<span>Today</span></div>' +
      '<div class="uptimes">' +
        '<span>24h <b>' + up(c.uptime.d1) + '</b></span>' +
        '<span>7d <b>' + up(c.uptime.d7) + '</b></span>' +
        '<span>90d <b>' + up(c.uptime.d90) + '</b></span>' +
      '</div></div>';
  }).join("");
}

function renderIncidents(incidents) {
  if (!incidents.length) {
    document.getElementById("incidents").innerHTML =
      '<div class="empty"><span class="dot"></span>No incidents reported in the last 90 days.</div>';
    return;
  }
  document.getElementById("incidents").innerHTML = incidents.map((i) => {
    const start = new Date(i.startedAt).toLocaleString();
    const resolved = i.resolvedAt;
    const status = resolved ? 'Resolved · ' + Math.round((resolved - i.startedAt)/60000) + 'm' : 'Ongoing';
    return '<div class="incident"><div class="row1"><strong>' + esc(i.summary) + '</strong>' +
      '<span class="pill ' + (resolved ? "operational" : "partial_outage") + '">' + status + '</span></div>' +
      '<div class="when">' + start + ' · ' + esc(i.component) + '</div></div>';
  }).join("");
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
