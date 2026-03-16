/* ── State ──────────────────────────────────────────────── */
let unit = 'C';   // 'C' or 'F'
let weatherData    = null;
let tempChart      = null;
let modelChart     = null;
let activeModel    = null;
let chartRange     = '24h';
let forecastView   = 'tabell';
const dayCharts    = {};
let expandedDay    = null;

const LS_KEY = 'weather_last_location';

const CONF_SV = { High: 'Hög', Medium: 'Medel', Low: 'Låg' };
const confLabel = c => CONF_SV[c] || c;

const MODEL_COLORS = {
  ECMWF: '#4f8ef7',
  GFS:   '#34d08b',
  ICON:  '#f5a623',
  GEM:   '#c47af5',
  YR:    '#e74c3c',
  SMHI:  '#00a8e0',
};

/* ── Helpers ────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function tempStr(c) {
  if (c === null || c === undefined) return '—';
  const val = unit === 'C' ? c : Math.round(c * 9 / 5 + 32);
  return `${val}°${unit}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('sv-SE', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatHour(isoStr) {
  const d = new Date(isoStr);
  const h = d.getHours();
  if (h === 0) return d.toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' });
  return `${h}:00`;
}

function toUnit(c) {
  if (c === null || c === undefined) return null;
  return unit === 'C' ? Math.round(c * 10) / 10 : Math.round(c * 9 / 5 + 32);
}

function windDir(deg) {
  if (deg === null || deg === undefined) return '';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

/* ── Search & Autocomplete ──────────────────────────────── */
const searchInput   = $('search-input');
const suggestionsEl = $('suggestions');
let debounceTimer;

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { suggestionsEl.innerHTML = ''; return; }
  debounceTimer = setTimeout(() => fetchSuggestions(q), 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const active = suggestionsEl.querySelector('.active');
    if (active) active.click();
    else {
      suggestionsEl.innerHTML = '';
      triggerSearch(searchInput.value.trim());
    }
  }
  if (e.key === 'ArrowDown') focusSuggestion(1);
  if (e.key === 'ArrowUp')   focusSuggestion(-1);
  if (e.key === 'Escape')    suggestionsEl.innerHTML = '';
});

function focusSuggestion(dir) {
  const items = [...suggestionsEl.querySelectorAll('.suggestion-item')];
  if (!items.length) return;
  const idx = items.findIndex(el => el.classList.contains('active'));
  items.forEach(el => el.classList.remove('active'));
  const next = (idx + dir + items.length) % items.length;
  items[next].classList.add('active');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrapper')) suggestionsEl.innerHTML = '';
});

$('search-btn').addEventListener('click', () => {
  suggestionsEl.innerHTML = '';
  triggerSearch(searchInput.value.trim());
});

async function fetchSuggestions(q) {
  try {
    const res  = await fetch(`https://weather-ensemble-production.up.railway.app/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) { suggestionsEl.innerHTML = ''; return; }
    const list = await res.json();
    renderSuggestions(list);
  } catch { suggestionsEl.innerHTML = ''; }
}

function renderSuggestions(list) {
  suggestionsEl.innerHTML = '';
  list.forEach(loc => {
    const li = document.createElement('li');
    li.className = 'suggestion-item';
    li.setAttribute('role', 'option');
    li.innerHTML = `
      <span>📍</span>
      <span class="place">${loc.name}</span>
      <span class="region">${[loc.admin1, loc.country].filter(Boolean).join(', ')}</span>
    `;
    li.addEventListener('click', () => {
      searchInput.value = loc.name;
      suggestionsEl.innerHTML = '';
      loadWeather(loc.lat, loc.lon, `${loc.name}${loc.country ? ', ' + loc.country : ''}`);
    });
    suggestionsEl.appendChild(li);
  });
}

async function triggerSearch(q) {
  if (!q) return;
  try {
    const res  = await fetch(`https://weather-ensemble-production.up.railway.app/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) { showError('Platsen hittades inte.'); return; }
    const list = await res.json();
    if (!list.length) { showError('Platsen hittades inte.'); return; }
    const loc = list[0];
    loadWeather(loc.lat, loc.lon, `${loc.name}${loc.country ? ', ' + loc.country : ''}`);
  } catch (err) {
    showError('Kunde inte nå servern.');
  }
}

/* ── Weather loading ────────────────────────────────────── */
async function loadWeather(lat, lon, name) {
  saveLocation(lat, lon, name);
  showLoading(true);
  hideError();
  $('weather-content').hidden = true;

  let data;
  try {
    const url = `https://weather-ensemble-production.up.railway.app/api/weather?lat=${lat}&lon=${lon}&name=${encodeURIComponent(name)}`;
    const res  = await fetch(url);
    if (!res.ok) { const e = await res.json(); showError(e.detail || 'Kunde inte ladda väderdata.'); return; }
    data = await res.json();
  } catch {
    showError('Nätverksfel — kontrollera din anslutning.');
    return;
  } finally {
    showLoading(false);
  }

  weatherData = data;
  activeModel = null;
  if (modelChart) { modelChart.destroy(); modelChart = null; }
  initWindyMaps(lat, lon);
  try {
    renderWeather(weatherData);
  } catch (err) {
    showError(`Render error: ${err.message}`);
    console.error(err);
  }
}

/* ── Render ─────────────────────────────────────────────── */
function renderWeather(data) {
  const cur = data.current;

  // Location & time
  $('location-name').textContent = data.location_name || 'Okänd plats';
  $('location-time').textContent = new Date().toLocaleString('sv-SE', {
    weekday: 'long', hour: '2-digit', minute: '2-digit',
    timeZone: data.timezone || undefined,
  });

  // Current conditions
  $('current-icon').textContent = cur.weather.icon;
  $('current-temp').textContent = tempStr(cur.temperature);
  $('current-desc').textContent = cur.weather.description;
  $('feels-like').textContent   = tempStr(cur.feels_like);
  const arrowRot = cur.wind_dir != null ? cur.wind_dir : 0;
  const windVal  = cur.wind_speed != null ? `${cur.wind_speed} km/h` : '—';
  $('wind-speed').innerHTML = `<span class="wind-arrow" style="transform:rotate(${arrowRot}deg)">↑</span>${windVal}`;
  $('humidity').textContent     = cur.humidity != null ? `${cur.humidity}%` : '—';
  $('precipitation').textContent = cur.precipitation != null ? `${cur.precipitation} mm` : '—';
  $('models-used').textContent  = data.models_used.join(', ');

  const badge = $('confidence');
  badge.textContent  = confLabel(cur.confidence);
  badge.className    = `confidence-badge confidence-${cur.confidence}`;

  // Model breakdown
  renderModels(data.by_model);

  // Hourly strip
  renderHourlyStrip(data);

  // Forecast table (yr.no style)
  renderForecastTable(data);

  // Reveal content first, then defer chart if graf is active
  $('weather-content').hidden = false;
  if (forecastView === 'graf') {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { renderChart(data); }
      catch (err) { console.error('Chart error:', err); }
    }));
  }
}

function renderModels(byModel) {
  const grid = $('model-grid');
  grid.innerHTML = '';
  for (const [name, m] of Object.entries(byModel)) {
    const card = document.createElement('div');
    card.className = 'model-card' + (name === activeModel ? ' active' : '');

    // Per-model 24h precipitation from hourly data
    const start = weatherData ? currentHourIndex(weatherData) : 0;
    const arr   = (weatherData?.hourly?.by_model_precip?.[name] || []).slice(start, start + 24);
    const valid = arr.filter(v => v != null);
    const total = valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    const avg   = total !== null ? total / valid.length : null;

    const nowMm  = m.precipitation != null ? `${m.precipitation} mm` : '—';
    const totStr = total !== null ? `${total.toFixed(1)} mm` : '—';
    const avgStr = avg   !== null ? `${avg.toFixed(2)} mm/h` : '—';

    card.innerHTML = `
      <span class="model-name">${name}</span>
      <span class="model-icon">${m.weather.icon}</span>
      <span class="model-temp">${tempStr(m.temperature)}</span>
      <span class="model-desc">${m.weather.description}</span>
      <span class="model-extra">💨 ${m.wind_speed != null ? m.wind_speed + ' km/h' : '—'}</span>
      <span class="model-extra">🌧 Nu: ${nowMm}</span>
      <span class="model-extra">24h: ${totStr} · Ø ${avgStr}</span>
    `;
    card.addEventListener('click', () => toggleModelChart(name));
    grid.appendChild(card);
  }
}

function toggleModelChart(name) {
  const detail = $('model-detail');
  if (activeModel === name) {
    activeModel = null;
    detail.hidden = true;
    if (modelChart) { modelChart.destroy(); modelChart = null; }
  } else {
    activeModel = name;
    detail.hidden = false;
    renderModelChart(name);
  }
  // update active state on cards
  document.querySelectorAll('.model-card').forEach(c => {
    c.classList.toggle('active', c.querySelector('.model-name').textContent === activeModel);
  });
}

function renderModelChart(name) {
  if (!weatherData?.hourly) return;
  if (modelChart) { modelChart.destroy(); modelChart = null; }

  const hours  = 48;
  const start  = currentHourIndex(weatherData);
  const color  = MODEL_COLORS[name] || '#888';
  const times  = weatherData.hourly.times.slice(start, start + hours);
  const gridColor = 'rgba(46,51,80,0.8)';
  const tickColor = '#8890aa';
  const unitLabel = `°${unit}`;

  const modelPrecip = (weatherData.hourly.by_model_precip?.[name] || weatherData.hourly.precip || []).slice(start, start + hours);

  const datasets = [
    { label: 'Nederbörd (mm)', data: modelPrecip,
      borderColor: 'rgba(79,142,247,0.6)', backgroundColor: 'rgba(79,142,247,0.15)',
      borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true, yAxisID: 'y1', order: 1 },
    { label: '_band_upper', data: (weatherData.hourly.max || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(255,255,255,0.07)', tension: 0.4, yAxisID: 'y' },
    { label: '_band_lower', data: (weatherData.hourly.min || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4, yAxisID: 'y' },
    { label: 'Ensemble', data: weatherData.hourly.ensemble.slice(start, start + hours).map(toUnit),
      borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, yAxisID: 'y' },
    { label: name, data: (weatherData.hourly.by_model[name] || []).slice(start, start + hours).map(toUnit),
      borderColor: color, borderWidth: 2.5, pointRadius: 0, tension: 0.4, yAxisID: 'y' },
  ];

  modelChart = new Chart($('model-chart').getContext('2d'), {
    type: 'line',
    data: { labels: times.map(formatHour), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: tickColor, boxWidth: 12, padding: 12, font: { size: 10 },
                    filter: item => !item.text.startsWith('_') },
        },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2e3350', borderWidth: 1,
          titleColor: '#e8eaf0', bodyColor: '#8890aa',
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (ctx.dataset.label === 'Nederbörd (mm)') return ` Nederbörd: ${v != null ? v + ' mm' : '—'}`;
              return ` ${ctx.dataset.label}: ${v != null ? v + unitLabel : '—'}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: gridColor } },
        y: { type: 'linear', position: 'left', ticks: { color: tickColor, callback: v => v + unitLabel, font: { size: 10 } }, grid: { color: gridColor } },
        y1: { type: 'linear', position: 'right', beginAtZero: true,
              ticks: { color: 'rgba(79,142,247,0.7)', callback: v => v + ' mm', font: { size: 10 } },
              grid: { drawOnChartArea: false } },
      },
    },
  });
}

/* ── Hourly strip ───────────────────────────────────────── */
function renderHourlyStrip(data) {
  const strip = $('hourly-strip');
  if (!strip || !data.hourly) return;
  strip.innerHTML = '';

  const hours  = 24;
  const start  = currentHourIndex(data);
  const times  = data.hourly.times.slice(start, start + hours);
  const temps  = data.hourly.ensemble.slice(start, start + hours);
  const precips = (data.hourly.precip  || []).slice(start, start + hours);
  const codes  = (data.hourly.codes   || []).slice(start, start + hours);

  const maxPrecip = Math.max(...precips.filter(v => v != null && v > 0), 0.01);

  times.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'hourly-item' + (i === 0 ? ' now' : '');

    const p          = precips[i] || 0;
    const barHeight  = Math.round((p / maxPrecip) * 100);
    const icon       = codes[i] != null ? describe_icon(codes[i]) : '';
    const label      = i === 0 ? 'Nu' : formatHour(t);

    item.innerHTML = `
      <span class="h-time">${label}</span>
      <span class="h-icon">${icon}</span>
      <span class="h-temp">${temps[i] != null ? tempStr(temps[i]) : '—'}</span>
      <div class="h-bar"><div class="h-bar-fill" style="height:${barHeight}%"></div></div>
      <span class="h-precip">${p > 0.1 ? p.toFixed(1) : ''}</span>
    `;
    strip.appendChild(item);
  });
}

function describe_icon(code) {
  const c = parseInt(code);
  if (c === 0) return '☀️';
  if (c === 1) return '🌤️';
  if (c === 2) return '⛅';
  if (c === 3) return '☁️';
  if (c <= 48) return '🌫️';
  if (c <= 55) return '🌦️';
  if (c <= 67) return '🌧️';
  if (c <= 77) return '❄️';
  if (c <= 82) return '🌦️';
  if (c <= 86) return '❄️';
  return '⛈️';
}

/* ── Day slices helper ──────────────────────────────────── */
function buildDaySlices(data) {
  const slices = {};
  const times   = data.hourly.times;
  const codes   = data.hourly.codes   || [];
  const precips = data.hourly.precip  || [];

  times.forEach((t, i) => {
    const dateStr = t.slice(0, 10);
    const hour    = parseInt(t.slice(11, 13));
    if (!slices[dateStr]) slices[dateStr] = { natt: [], morgen: [], dag: [], kvall: [] };
    const entry = { code: codes[i], precip: precips[i] ?? 0 };
    if (hour < 6)        slices[dateStr].natt.push(entry);
    else if (hour < 12)  slices[dateStr].morgen.push(entry);
    else if (hour < 18)  slices[dateStr].dag.push(entry);
    else                 slices[dateStr].kvall.push(entry);
  });
  return slices;
}

function jsMajority(arr) {
  const valid = arr.filter(v => v != null);
  if (!valid.length) return null;
  const counts = {};
  valid.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/* ── yr.no-style forecast table ─────────────────────────── */
function renderForecastTable(data) {
  const wrap = $('forecast-tabell');
  if (!wrap) return;

  // Destroy any open day charts from previous render
  Object.values(dayCharts).forEach(c => c.destroy());
  Object.keys(dayCharts).forEach(k => delete dayCharts[k]);
  expandedDay = null;

  wrap.innerHTML = '';

  const slices  = buildDaySlices(data);
  const curIdx  = currentHourIndex(data);
  const nowDate = data.hourly.times[curIdx]?.slice(0, 10) || '';
  const nowHour = parseInt(data.hourly.times[curIdx]?.slice(11, 13) ?? '23');

  const table = document.createElement('table');
  table.className = 'yr-table';
  table.innerHTML = `<thead><tr>
    <th class="yt-day"></th>
    <th class="yt-period">Natt<br><small>0–6</small></th>
    <th class="yt-period">Morgon<br><small>6–12</small></th>
    <th class="yt-period">Dag<br><small>12–18</small></th>
    <th class="yt-period">Kväll<br><small>18–24</small></th>
    <th class="yt-hl">Temp H / L</th>
    <th class="yt-pr">Nedb</th>
    <th class="yt-wi">Vind</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  data.forecast.forEach((day, i) => {
    const s = slices[day.date] || { natt: [], morgen: [], dag: [], kvall: [] };
    const isToday  = day.date === nowDate;
    const dayLabel = i === 0 ? 'Idag' : formatDate(day.date);

    const pastNatt   = isToday && nowHour >= 6;
    const pastMorgen = isToday && nowHour >= 12;
    const pastDag    = isToday && nowHour >= 18;

    const cell = (entries, past) => {
      if (past || !entries.length) return '<td class="yt-period yt-past">—</td>';
      const code   = parseInt(jsMajority(entries.map(e => e.code).filter(c => c != null)));
      const precip = entries.reduce((s, e) => s + (e.precip || 0), 0);
      const icon   = isNaN(code) ? '—' : describe_icon(code);
      const pStr   = precip > 0.1 ? `<br><small class="yt-pmm">${precip.toFixed(1)}</small>` : '';
      return `<td class="yt-period">${icon}${pStr}</td>`;
    };

    const wind  = day.wind_speed  != null ? Math.round(day.wind_speed)  + ' km/h' : '—';
    const precT = day.precipitation > 0   ? `<span class="yt-blue">${day.precipitation} mm</span>` : '—';

    const tr = document.createElement('tr');
    tr.className = 'yt-row' + (isToday ? ' yt-today' : '');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td class="yt-day-cell">
        <strong>${dayLabel}</strong>
        ${i > 0 ? `<br><small class="yt-sub">${day.date.slice(5).replace('-','/')}</small>` : ''}
        <span class="yt-chevron">›</span>
      </td>
      ${cell(s.natt,   pastNatt)}
      ${cell(s.morgen, pastMorgen)}
      ${cell(s.dag,    pastDag)}
      ${cell(s.kvall,  false)}
      <td class="yt-hl-cell">
        <span class="yt-hi">${tempStr(day.temp_max)}</span>
        <span class="yt-sep"> / </span>
        <span class="yt-lo">${tempStr(day.temp_min)}</span>
      </td>
      <td class="yt-pr-cell">${precT}</td>
      <td class="yt-wi-cell">${wind}</td>
    `;

    // Detail row with chart
    const detailTr = document.createElement('tr');
    detailTr.id        = `yt-detail-${day.date}`;
    detailTr.className = 'yt-detail-row';
    detailTr.hidden    = true;
    detailTr.innerHTML = `<td colspan="8">
      <div class="yt-detail-wrap">
        <canvas id="day-canvas-${day.date}"></canvas>
      </div>
    </td>`;

    tr.addEventListener('click', () => toggleDayDetail(day.date, data));

    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ── Day detail expand/collapse ─────────────────────────── */
function toggleDayDetail(dateStr, data) {
  const detailRow = document.getElementById(`yt-detail-${dateStr}`);
  if (!detailRow) return;

  // Collapse previously open row
  if (expandedDay && expandedDay !== dateStr) {
    const prev = document.getElementById(`yt-detail-${expandedDay}`);
    if (prev) prev.hidden = true;
    const prevRow = prev?.previousElementSibling;
    if (prevRow) prevRow.classList.remove('yt-expanded');
    if (dayCharts[expandedDay]) { dayCharts[expandedDay].destroy(); delete dayCharts[expandedDay]; }
  }

  const isOpen = !detailRow.hidden;
  const dayRow = detailRow.previousElementSibling;

  detailRow.hidden = isOpen;
  if (dayRow) dayRow.classList.toggle('yt-expanded', !isOpen);

  if (!isOpen) {
    expandedDay = dateStr;
    // Give the row time to become visible before drawing
    requestAnimationFrame(() => renderDayChart(dateStr, data));
  } else {
    expandedDay = null;
    if (dayCharts[dateStr]) { dayCharts[dateStr].destroy(); delete dayCharts[dateStr]; }
  }
}

function renderDayChart(dateStr, data) {
  const canvas = document.getElementById(`day-canvas-${dateStr}`);
  if (!canvas) return;

  const times  = data.hourly.times;
  const idx    = times.reduce((acc, t, i) => { if (t.startsWith(dateStr)) acc.push(i); return acc; }, []);
  if (!idx.length) return;

  const labels  = idx.map(i => `${parseInt(times[i].slice(11,13))}:00`);
  const temps   = idx.map(i => toUnit(data.hourly.ensemble[i]));
  const precips = idx.map(i => (data.hourly.precip || [])[i] ?? 0);

  const gridColor = 'rgba(46,51,80,0.8)';
  const tickColor = '#8890aa';
  const unitLabel = `°${unit}`;

  if (dayCharts[dateStr]) dayCharts[dateStr].destroy();

  dayCharts[dateStr] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Nederbörd (mm)', data: precips,
          backgroundColor: 'rgba(79,142,247,0.55)', borderWidth: 0,
          yAxisID: 'y1', order: 1, barPercentage: 0.9, categoryPercentage: 1.0 },
        { label: 'Temperatur', data: temps,
          borderColor: '#4f8ef7', borderWidth: 2.5, pointRadius: 2,
          tension: 0.4, fill: false, yAxisID: 'y', order: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27', borderColor: '#2e3350', borderWidth: 1,
          titleColor: '#e8eaf0', bodyColor: '#8890aa',
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (ctx.dataset.label === 'Nederbörd (mm)') return ` Nederbörd: ${v} mm`;
              return ` Temp: ${v}${unitLabel}`;
            },
          },
        },
      },
      scales: {
        x:  { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor } },
        y:  { type: 'linear', position: 'left',
              ticks: { color: tickColor, callback: v => v + unitLabel, font: { size: 10 } },
              grid: { color: gridColor } },
        y1: { type: 'linear', position: 'right', beginAtZero: true,
              ticks: { color: 'rgba(79,142,247,0.7)', callback: v => v + ' mm', font: { size: 10 } },
              grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderForecast(forecast) {
  const list = $('forecast-list');
  list.innerHTML = '';

  forecast.forEach((day, i) => {
    const row = document.createElement('div');
    row.className = 'forecast-row';

    const label = i === 0 ? 'Idag' : formatDate(day.date);
    const pp    = day.precipitation_probability ?? 0;

    row.innerHTML = `
      <span class="fc-day">${label}</span>
      <span class="fc-icon">${day.weather.icon}</span>
      <span class="fc-desc">
        ${day.weather.description}
        <div class="precip-bar" title="${pp}% rain chance">
          <div class="precip-track"><div class="precip-fill" style="width:${pp}%"></div></div>
          <span>${Math.round(pp)}%</span>
        </div>
      </span>
      <span class="fc-max">${tempStr(day.temp_max)}</span>
      <span class="fc-min">${tempStr(day.temp_min)}</span>
      <span class="fc-badge">
        <span class="confidence-badge confidence-${day.confidence}" title="Modelöverensstämmelse">${confLabel(day.confidence)}</span>
      </span>
    `;
    list.appendChild(row);
  });
}

/* ── Find current hour index in hourly data ─────────────── */
function currentHourIndex(data) {
  // Add location UTC offset to UTC timestamp, then read with getUTC* to get local time string
  const localMs = Date.now() + (data.utc_offset_seconds || 0) * 1000;
  const d = new Date(localMs);
  const pad = n => String(n).padStart(2, '0');
  const nowStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`;
  const idx = data.hourly.times.findIndex(t => t >= nowStr);
  return idx >= 0 ? idx : 0;
}

/* ── Temperature chart ──────────────────────────────────── */
function buildChartData(data, range) {
  const gridColor  = 'rgba(46,51,80,0.8)';
  const tickColor  = '#8890aa';

  if (range === '7day') {
    const labels = data.forecast.map((d, i) => i === 0 ? 'Idag' : formatDate(d.date));

    const bandUpper = data.forecast.map(d => {
      const vals = Object.values(d.by_model).map(m => m.temp_max).filter(v => v != null);
      return vals.length ? toUnit(Math.max(...vals)) : null;
    });
    const bandLower = data.forecast.map(d => {
      const vals = Object.values(d.by_model).map(m => m.temp_min).filter(v => v != null);
      return vals.length ? toUnit(Math.min(...vals)) : null;
    });

    const datasets = [
      // Spread band
      { label: '_band_upper', data: bandUpper, borderWidth: 0, pointRadius: 0, fill: '+1',
        backgroundColor: 'rgba(255,255,255,0.1)', tension: 0.35 },
      { label: '_band_lower', data: bandLower, borderWidth: 0, pointRadius: 0, fill: false,
        tension: 0.35 },
      // Ensemble max
      {
        label:           'Max',
        data:            data.forecast.map(d => toUnit(d.temp_max)),
        borderColor:     '#ffffff',
        borderWidth:     2.5,
        pointRadius:     4,
        pointBackgroundColor: '#ffffff',
        tension:         0.35,
        order:           -1,
      },
      // Ensemble min (dashed)
      {
        label:           'Min',
        data:            data.forecast.map(d => toUnit(d.temp_min)),
        borderColor:     'rgba(255,255,255,0.5)',
        borderWidth:     1.5,
        borderDash:      [5, 4],
        pointRadius:     3,
        tension:         0.35,
      },
    ];
    return { labels, datasets, gridColor, tickColor, showPrecip: false };
  }

  // Hourly view (12h, 24h or 48h) — start from current hour
  const hours  = range === '12h' ? 12 : range === '24h' ? 24 : 48;
  const start  = currentHourIndex(data);
  const times  = data.hourly.times.slice(start, start + hours);
  const labels = times.map(formatHour);

  const datasets = [
    // Precipitation bars (secondary axis)
    {
      type:            'bar',
      label:           'Nederbörd (mm)',
      data:            (data.hourly.precip || []).slice(start, start + hours),
      backgroundColor: 'rgba(79,142,247,0.55)',
      borderColor:     'rgba(79,142,247,0.8)',
      borderWidth:     0,
      yAxisID:         'y1',
      order:           1,
      barPercentage:   0.9,
      categoryPercentage: 1.0,
    },
    // Spread band
    { label: '_band_upper', data: (data.hourly.max || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: '+1',
      backgroundColor: 'rgba(255,255,255,0.1)', tension: 0.4, yAxisID: 'y' },
    { label: '_band_lower', data: (data.hourly.min || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4, yAxisID: 'y' },
    // Ensemble (bold white)
    {
      label:           'Temperatur',
      data:            data.hourly.ensemble.slice(start, start + hours).map(toUnit),
      borderColor:     '#ffffff',
      borderWidth:     2.5,
      pointRadius:     0,
      tension:         0.4,
      order:           -1,
      yAxisID:         'y',
    },
  ];
  return { labels, datasets, gridColor, tickColor, showPrecip: true };
}

function renderChart(data) {
  if (!data.hourly) { console.warn('renderChart: no hourly data in response'); return; }

  const canvas = $('temp-chart');
  const ctx    = canvas.getContext('2d');

  if (tempChart) { tempChart.destroy(); tempChart = null; }

  const { labels, datasets, gridColor, tickColor, showPrecip } = buildChartData(data, chartRange);
  const unitLabel = `°${unit}`;

  const scales = {
    x: {
      ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } },
      grid:  { color: gridColor },
    },
    y: {
      type:     'linear',
      position: 'left',
      ticks:    { color: tickColor, callback: v => v + unitLabel, font: { size: 11 } },
      grid:     { color: gridColor },
    },
  };

  if (showPrecip) {
    scales.y1 = {
      type:        'linear',
      position:    'right',
      beginAtZero: true,
      ticks:       { color: 'rgba(79,142,247,0.7)', callback: v => v + ' mm', font: { size: 10 } },
      grid:        { drawOnChartArea: false },
    };
  }

  const daySepPlugin = {
    id: 'daySep',
    beforeDraw(chart) {
      const { ctx: c, scales: { x, y } } = chart;
      if (!x || !y) return;
      chart.data.labels.forEach((lbl, i) => {
        if (i > 0 && lbl && !String(lbl).includes(':')) {
          const xPos = x.getPixelForValue(i);
          c.save();
          c.strokeStyle = 'rgba(255,255,255,0.18)';
          c.lineWidth = 1;
          c.setLineDash([3, 3]);
          c.beginPath();
          c.moveTo(xPos, y.top);
          c.lineTo(xPos, y.bottom + 20);
          c.stroke();
          c.restore();
        }
      });
    }
  };

  tempChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    plugins: [daySepPlugin],
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels:   { color: tickColor, boxWidth: 12, padding: 16, font: { size: 11 },
                      filter: item => !item.text.startsWith('_') },
        },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor:     '#2e3350',
          borderWidth:     1,
          titleColor:      '#e8eaf0',
          bodyColor:       '#8890aa',
          filter:          item => !item.dataset.label.startsWith('_'),
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (ctx.dataset.label === 'Nederbörd (mm)') return ` Nederbörd: ${v != null ? v + ' mm' : '—'}`;
              return ` ${ctx.dataset.label}: ${v !== null ? v + unitLabel : '—'}`;
            },
            afterBody: items => {
              if (!items.length) return [];
              const i  = items[0].dataIndex;
              const ds = items[0].chart.data.datasets;
              const hi = ds.find(d => d.label === '_band_upper')?.data[i];
              const lo = ds.find(d => d.label === '_band_lower')?.data[i];
              const lines = [];
              if (hi != null) lines.push(` Max: ${hi}${unitLabel}`);
              if (lo != null) lines.push(` Min: ${lo}${unitLabel}`);
              return lines;
            },
          },
        },
      },
      scales,
    },
  });
}

/* ── Temperature table ──────────────────────────────────── */
function renderTempTable(data, range) {
  const wrap = $('temp-table-wrap');
  wrap.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'temp-table';

  if (range === '7day') {
    table.innerHTML = `<thead><tr>
      <th>Dag</th><th>Ikon</th><th>Väder</th>
      <th>Max</th><th>Min</th><th>Nederbörd</th><th>Regn %</th><th>Tillförlitlighet</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    data.forecast.forEach((d, i) => {
      const tr = document.createElement('tr');
      const pp = d.precipitation_probability ?? 0;
      tr.innerHTML = `
        <td class="td-time">${i === 0 ? 'Idag' : formatDate(d.date)}</td>
        <td>${d.weather.icon}</td>
        <td>${d.weather.description}</td>
        <td class="td-temp">${tempStr(d.temp_max)}</td>
        <td class="td-spread">${tempStr(d.temp_min)}</td>
        <td class="td-precip">${d.precipitation != null ? d.precipitation + ' mm' : '—'}</td>
        <td class="td-precip">${Math.round(pp)}%</td>
        <td><span class="confidence-badge confidence-${d.confidence}">${confLabel(d.confidence)}</span></td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  } else {
    const hours = range === '12h' ? 12 : range === '24h' ? 24 : 48;
    const step  = range === '12h' ?  1 : range === '24h' ?  2 :  4;
    const start = currentHourIndex(data);
    table.innerHTML = `<thead><tr>
      <th>Tid</th><th>Temp</th><th>Max</th><th>Min</th><th>Nederbörd</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    const times  = data.hourly.times.slice(start, start + hours);
    const temps  = data.hourly.ensemble.slice(start, start + hours);
    const maxes  = (data.hourly.max  || []).slice(start, start + hours);
    const mins   = (data.hourly.min  || []).slice(start, start + hours);
    const precip = (data.hourly.precip || []).slice(start, start + hours);
    times.filter((_, i) => i % step === 0).forEach((t, j) => { const i = j * step;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-time">${formatHour(t)}</td>
        <td class="td-temp">${temps[i] != null ? tempStr(temps[i]) : '—'}</td>
        <td class="td-spread">${maxes[i] != null ? tempStr(maxes[i]) : '—'}</td>
        <td class="td-spread">${mins[i]  != null ? tempStr(mins[i])  : '—'}</td>
        <td class="td-precip">${precip[i] != null ? precip[i] + ' mm' : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  wrap.appendChild(table);
}

// Range toggle buttons
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartRange = btn.dataset.range;
    if (weatherData) renderChart(weatherData);
  });
});

/* ── Forecast Tabell/Graf toggle ────────────────────────── */
document.querySelectorAll('.ftoggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ftoggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    forecastView = btn.dataset.view;
    $('forecast-tabell').hidden = forecastView !== 'tabell';
    $('forecast-graf').hidden   = forecastView !== 'graf';
    if (forecastView === 'graf' && weatherData) {
      requestAnimationFrame(() => requestAnimationFrame(() => renderChart(weatherData)));
    }
  });
});

/* ── Unit toggle ────────────────────────────────────────── */
$('unit-c').addEventListener('click', () => switchUnit('C'));
$('unit-f').addEventListener('click', () => switchUnit('F'));

function switchUnit(u) {
  if (u === unit) return;
  unit = u;
  $('unit-c').classList.toggle('active', u === 'C');
  $('unit-f').classList.toggle('active', u === 'F');
  if (weatherData) { renderWeather(weatherData); }
}

/* ── Geolocation ────────────────────────────────────────── */
async function handlePosition(lat, lon) {
  try {
    const res  = await fetch(`https://weather-ensemble-production.up.railway.app/api/reverse?lat=${lat}&lon=${lon}`);
    const loc  = res.ok ? await res.json() : {};
    const name = loc.name ? `${loc.name}, ${loc.country}` : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    searchInput.value = name;
    loadWeather(lat, lon, name);
  } catch {
    searchInput.value = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    loadWeather(lat, lon, searchInput.value);
  }
}

$('locate-btn').addEventListener('click', async () => {
  const btn = $('locate-btn');
  btn.classList.add('locating');

  if (!navigator.geolocation) { btn.classList.remove('locating'); showError('Platsinformation stöds inte av din webbläsare.'); return; }
  navigator.geolocation.getCurrentPosition(
    async pos => {
      btn.classList.remove('locating');
      await handlePosition(pos.coords.latitude, pos.coords.longitude);
    },
    err => {
      btn.classList.remove('locating');
      showError(err.code === 1 ? 'Platsåtkomst nekad.' : 'Kunde inte fastställa din plats.');
    },
    { timeout: 30000, enableHighAccuracy: true }
  );
});

/* ── UI helpers ─────────────────────────────────────────── */
function showLoading(visible) { $('loading-msg').hidden = !visible; }
function showError(msg)    { const el = $('error-msg'); el.textContent = msg; el.hidden = false; }
function hideError()       { $('error-msg').hidden = true; }

/* ── Persist last location ──────────────────────────────── */
function saveLocation(lat, lon, name) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ lat, lon, name })); } catch {}
}

function restoreLastLocation() {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return;
    const { lat, lon, name } = JSON.parse(saved);
    searchInput.value = name;
    loadWeather(lat, lon, name);
  } catch {}
}

/* ── Live map (Windy.com embeds) ────────────────────────── */
function initWindyMaps(lat, lon) {
  const zoom = 7;
  const base = `https://embed.windy.com/embed2.html?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&zoom=${zoom}&level=surface&menu=&message=true&marker=true&metricWind=km%2Fh&metricTemp=%C2%B0C`;
  $('precip-frame').src = `${base}&overlay=radar`;
  $('wind-frame').src   = `${base}&overlay=wind&product=ecmwf`;
  $('radar-placeholder').style.display = 'none';
  // Show whichever tab is currently active
  const activeLayer = document.querySelector('.radar-tab.active')?.dataset.layer || 'precip';
  document.querySelectorAll('.windy-frame').forEach(f => f.classList.remove('active'));
  $(`${activeLayer}-frame`).classList.add('active');
}

document.querySelectorAll('.radar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.radar-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.windy-frame').forEach(f => f.classList.remove('active'));
    $(`${btn.dataset.layer}-frame`).classList.add('active');
  });
});

/* ── Radar map (archived — replaced by Windy embeds) ────────
 *
 * Steps to activate:
 * 1. Uncomment the Leaflet CSS/JS links in index.html
 * 2. Add <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script> to index.html
 * 3. Replace the radar-placeholder div with <div id="radar-map"></div>
 * 4. Call initRadar(lat, lon) after loadWeather() succeeds
 *
async function initRadar(lat, lon) {
  const map = L.map('radar-map').setView([lat, lon], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  // RainViewer animated radar overlay
  const rv = await fetch('https://api.rainviewer.com/public/weather-maps.json').then(r => r.json());
  const frames = [...rv.radar.past, ...(rv.radar.nowcast || [])];
  let current = frames.length - 1;

  const layers = frames.map(f =>
    L.tileLayer(`https://tilecache.rainviewer.com${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.6, tileSize: 256
    })
  );

  layers[current].addTo(map);

  // Animate through frames
  setInterval(() => {
    layers[current].remove();
    current = (current + 1) % layers.length;
    layers[current].addTo(map);
  }, 500);
}
 * ─────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', restoreLastLocation);
