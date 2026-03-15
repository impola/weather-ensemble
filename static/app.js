/* ── State ──────────────────────────────────────────────── */
let unit = 'C';   // 'C' or 'F'
let weatherData    = null;
let tempChart      = null;
let modelChart     = null;
let activeModel    = null;
let chartRange     = '12h';

const LS_KEY = 'weather_last_location';

const CONF_SV = { High: 'Hög', Medium: 'Medel', Low: 'Låg' };
const confLabel = c => CONF_SV[c] || c;

const MODEL_COLORS = {
  ECMWF: '#4f8ef7',
  GFS:   '#34d08b',
  ICON:  '#f5a623',
  GEM:   '#c47af5',
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
    const res  = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
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
    const res  = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
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
    const url = `/api/weather?lat=${lat}&lon=${lon}&name=${encodeURIComponent(name)}`;
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
  $('location-name').textContent = data.location_name || 'Unknown';
  $('location-time').textContent = new Date().toLocaleString('sv-SE', {
    weekday: 'long', hour: '2-digit', minute: '2-digit',
    timeZone: data.timezone || undefined,
  });

  // Current conditions
  $('current-icon').textContent = cur.weather.icon;
  $('current-temp').textContent = tempStr(cur.temperature);
  $('current-desc').textContent = cur.weather.description;
  $('feels-like').textContent   = tempStr(cur.feels_like);
  const dir = windDir(cur.wind_dir);
  $('wind-speed').textContent   = cur.wind_speed != null ? `${cur.wind_speed} km/h${dir ? ' ' + dir : ''}` : '—';
  $('humidity').textContent     = cur.humidity != null ? `${cur.humidity}%` : '—';
  $('precipitation').textContent = cur.precipitation != null ? `${cur.precipitation} mm` : '—';
  $('models-used').textContent  = data.models_used.join(', ');

  const badge = $('confidence');
  badge.textContent  = confLabel(cur.confidence);
  badge.className    = `confidence-badge confidence-${cur.confidence}`;

  // Model breakdown
  renderModels(data.by_model);

  // Forecast
  renderForecast(data.forecast);

  // Reveal content first, then defer chart two frames so layout is calculated
  $('weather-content').hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { renderChart(data); renderTempTable(data, chartRange); }
    catch (err) { console.error('Chart error:', err); showError(`Chart error: ${err.message}`); }
  }));
}

function renderModels(byModel) {
  const grid = $('model-grid');
  grid.innerHTML = '';
  for (const [name, m] of Object.entries(byModel)) {
    const card = document.createElement('div');
    card.className = 'model-card' + (name === activeModel ? ' active' : '');
    card.innerHTML = `
      <span class="model-name">${name}</span>
      <span class="model-icon">${m.weather.icon}</span>
      <span class="model-temp">${tempStr(m.temperature)}</span>
      <span class="model-desc">${m.weather.description}</span>
      <span class="model-extra">💨 ${m.wind_speed != null ? m.wind_speed + ' km/h' : '—'}</span>
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
  const color  = MODEL_COLORS[name] || '#888';
  const times  = weatherData.hourly.times.slice(0, hours);
  const gridColor = 'rgba(46,51,80,0.8)';
  const tickColor = '#8890aa';
  const unitLabel = `°${unit}`;

  const datasets = [
    { label: 'Precip (mm)', data: (weatherData.hourly.precip || []).slice(0, hours),
      borderColor: 'rgba(79,142,247,0.6)', backgroundColor: 'rgba(79,142,247,0.15)',
      borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true, yAxisID: 'y1', order: 1 },
    { label: '_band_upper', data: (weatherData.hourly.max || []).slice(0, hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(255,255,255,0.07)', tension: 0.4, yAxisID: 'y' },
    { label: '_band_lower', data: (weatherData.hourly.min || []).slice(0, hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4, yAxisID: 'y' },
    { label: 'Ensemble', data: weatherData.hourly.ensemble.slice(0, hours).map(toUnit),
      borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, yAxisID: 'y' },
    { label: name, data: (weatherData.hourly.by_model[name] || []).slice(0, hours).map(toUnit),
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
              if (ctx.dataset.label === 'Precip (mm)') return ` Precip: ${v != null ? v + ' mm' : '—'}`;
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

function renderForecast(forecast) {
  const list = $('forecast-list');
  list.innerHTML = '';

  forecast.forEach((day, i) => {
    const row = document.createElement('div');
    row.className = 'forecast-row';

    const label = i === 0 ? 'Today' : formatDate(day.date);
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
  const offsetMs = (data.utc_offset_seconds || 0) * 1000;
  const localNow = new Date(Date.now() + offsetMs + new Date().getTimezoneOffset() * 60000);
  const pad = n => String(n).padStart(2, '0');
  const nowStr = `${localNow.getFullYear()}-${pad(localNow.getMonth()+1)}-${pad(localNow.getDate())}T${pad(localNow.getHours())}:00`;
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
        label:           'High',
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
        label:           'Low',
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
    // Precipitation line (secondary axis)
    {
      label:           'Precip (mm)',
      data:            (data.hourly.precip || []).slice(start, start + hours),
      borderColor:     'rgba(79,142,247,0.6)',
      backgroundColor: 'rgba(79,142,247,0.15)',
      borderWidth:     1.5,
      pointRadius:     0,
      tension:         0.4,
      fill:            true,
      yAxisID:         'y1',
      order:           1,
    },
    // Spread band
    { label: '_band_upper', data: (data.hourly.max || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: '+1',
      backgroundColor: 'rgba(255,255,255,0.1)', tension: 0.4, yAxisID: 'y' },
    { label: '_band_lower', data: (data.hourly.min || []).slice(start, start + hours).map(toUnit),
      borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4, yAxisID: 'y' },
    // Ensemble (bold white)
    {
      label:           'Temperature',
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

  tempChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
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
              if (ctx.dataset.label === 'Precip (mm)') return ` Precip: ${v != null ? v + ' mm' : '—'}`;
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
      <th>Day</th><th>Icon</th><th>Condition</th>
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
    if (weatherData) { renderChart(weatherData); renderTempTable(weatherData, chartRange); }
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
  if (weatherData) { renderWeather(weatherData); renderChart(weatherData); renderTempTable(weatherData, chartRange); }
}

/* ── Geolocation ────────────────────────────────────────── */
async function handlePosition(lat, lon) {
  try {
    const res  = await fetch(`/api/reverse?lat=${lat}&lon=${lon}`);
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

  // On iOS (Capacitor), use the native Geolocation plugin directly
  const CapGeo = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
  if (CapGeo) {
    try {
      await CapGeo.requestPermissions();
      const pos = await CapGeo.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
      btn.classList.remove('locating');
      await handlePosition(pos.coords.latitude, pos.coords.longitude);
    } catch (err) {
      btn.classList.remove('locating');
      showError(err.message && err.message.includes('denied') ? 'Platsåtkomst nekad.' : 'Kunde inte fastställa din plats.');
    }
    return;
  }

  // Web fallback
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
    { timeout: 10000 }
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

document.addEventListener('DOMContentLoaded', restoreLastLocation);
