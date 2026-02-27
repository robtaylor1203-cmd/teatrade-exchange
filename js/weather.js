// =============================================
// GROWING REGIONS WEATHER
// Data source: Open-Meteo (free, no API key)
// =============================================

const WEATHER_REGIONS = [
    { id: 'kericho',    name: 'Kericho',    country: 'Kenya',     iso: 'ke', lat: -0.37, lon: 35.28 },
    { id: 'nandi',      name: 'Nandi',      country: 'Kenya',     iso: 'ke', lat:  0.18, lon: 35.10 },
    { id: 'darjeeling', name: 'Darjeeling', country: 'India',     iso: 'in', lat: 27.03, lon: 88.26 },
    { id: 'assam',      name: 'Assam',      country: 'India',     iso: 'in', lat: 26.14, lon: 91.74 },
    { id: 'ceylon',     name: 'Ceylon',     country: 'Sri Lanka', iso: 'lk', lat:  7.87, lon: 80.77 },
];

// Cached results for popout re-renders
let _weatherCache = [];

// WMO weather code → { icon, label, bg }
function _wmoInfo(code) {
    if (code === 0)  return { icon: '☀️',  label: 'Clear Sky',        bg: 'sunny'  };
    if (code === 1)  return { icon: '🌤️', label: 'Mainly Clear',      bg: 'sunny'  };
    if (code === 2)  return { icon: '⛅',  label: 'Partly Cloudy',     bg: 'cloudy' };
    if (code === 3)  return { icon: '☁️',  label: 'Overcast',          bg: 'cloudy' };
    if (code <= 48)  return { icon: '🌫️', label: 'Foggy',             bg: 'foggy'  };
    if (code <= 55)  return { icon: '🌦️', label: 'Drizzle',           bg: 'rain'   };
    if (code <= 57)  return { icon: '🌧️', label: 'Freezing Drizzle',  bg: 'rain'   };
    if (code <= 65)  return { icon: '🌧️', label: 'Rain',              bg: 'rain'   };
    if (code <= 67)  return { icon: '🌨️', label: 'Freezing Rain',     bg: 'snow'   };
    if (code <= 77)  return { icon: '❄️',  label: 'Snow',              bg: 'snow'   };
    if (code <= 82)  return { icon: '🌦️', label: 'Rain Showers',      bg: 'rain'   };
    if (code <= 86)  return { icon: '🌨️', label: 'Snow Showers',      bg: 'snow'   };
    if (code <= 99)  return { icon: '⛈️',  label: 'Thunderstorm',      bg: 'storm'  };
    return                  { icon: '🌡️', label: 'Unknown',            bg: 'cloudy' };
}

function _degToCompass(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

function _uvLabel(uv) {
    if (uv <= 2)  return { text: 'Low',      cls: 'uv-low'    };
    if (uv <= 5)  return { text: 'Moderate', cls: 'uv-mod'    };
    if (uv <= 7)  return { text: 'High',     cls: 'uv-high'   };
    if (uv <= 10) return { text: 'V.High',   cls: 'uv-vhigh'  };
    return               { text: 'Extreme',  cls: 'uv-extreme'};
}

function _tempLevel(t) {
    if (t < 10)  return 'cold';
    if (t < 18)  return 'mild';
    if (t < 26)  return 'warm';
    if (t < 33)  return 'hot';
    return 'vhot';
}

function _humidityBar(pct) {
    const filled = Math.round(pct / 10);
    let bar = '';
    for (let i = 0; i < 10; i++) {
        bar += `<span class="hbar-seg${i < filled ? ' hbar-filled' : ''}"></span>`;
    }
    return bar;
}

async function _fetchRegionWeather(region) {
    const currentVars = [
        'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
        'dew_point_2m', 'weather_code', 'cloud_cover', 'wind_speed_10m',
        'wind_direction_10m', 'wind_gusts_10m', 'precipitation',
        'surface_pressure', 'visibility', 'uv_index',
    ].join(',');

    const dailyVars = [
        'weather_code', 'temperature_2m_max', 'temperature_2m_min',
        'precipitation_sum', 'wind_speed_10m_max', 'uv_index_max',
        'precipitation_probability_max',
    ].join(',');

    const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${region.lat}&longitude=${region.lon}` +
        `&current=${currentVars}` +
        `&daily=${dailyVars}` +
        `&forecast_days=7&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const c = data.current;
    const d = data.daily;

    // Build 7-day array (skip index 0 = today, already shown as current)
    const forecast = (d.time || []).map((date, i) => ({
        date,
        code:      d.weather_code[i],
        tempMax:   Math.round(d.temperature_2m_max[i]),
        tempMin:   Math.round(d.temperature_2m_min[i]),
        precip:    d.precipitation_sum[i],
        precipPct: d.precipitation_probability_max[i] ?? null,
        windMax:   Math.round(d.wind_speed_10m_max[i]),
        uvMax:     d.uv_index_max[i] != null ? Math.round(d.uv_index_max[i]) : null,
    }));

    return {
        temp:        Math.round(c.temperature_2m),
        feelsLike:   Math.round(c.apparent_temperature),
        humidity:    c.relative_humidity_2m,
        dewPoint:    Math.round(c.dew_point_2m),
        code:        c.weather_code,
        cloud:       c.cloud_cover,
        windSpeed:   Math.round(c.wind_speed_10m),
        windDir:     c.wind_direction_10m,
        windGust:    Math.round(c.wind_gusts_10m),
        precip:      c.precipitation,
        pressure:    Math.round(c.surface_pressure),
        visibility:  c.visibility != null ? (c.visibility / 1000).toFixed(1) : null,
        uv:          c.uv_index != null ? Math.round(c.uv_index) : null,
        timezone:    data.timezone_abbreviation || '',
        forecast,
    };
}

// ─── Card rendering ────────────────────────────────────────────────────────

function _renderWeatherCards(results) {
    const container = document.getElementById('weather-cards');
    if (!container) return;

    container.innerHTML = results.map(({ region, weather: w, error }, idx) => {
        if (error || !w) {
            return `
            <div class="t212-weather-card weather-error" data-weather-idx="${idx}" onclick="retryWeatherCard(${idx})" title="Click to retry">
                <div class="wc-head">
                    <span class="wc-region">${region.name}</span>
                    <span class="wc-condition">Offline</span>
                </div>
                <div class="wc-temp-row"><span class="wc-temp-val">—</span></div>
                <div class="wc-indicators"><span class="wc-retry-tap">Tap to retry</span></div>
            </div>`;
        }

        const { label, bg } = _wmoInfo(w.code);
        const level = _tempLevel(w.temp);
        const windDir = _degToCompass(w.windDir);

        return `
        <div class="t212-weather-card" data-temp-level="${level}" data-weather-bg="${bg}" data-weather-idx="${idx}" onclick="openWeatherPopout(${idx}, this)">
            <div class="wc-head">
                <span class="wc-region">${region.name}</span>
                <span class="wc-condition">${label}</span>
            </div>
            <div class="wc-temp-row">
                <span class="wc-temp-val">${w.temp}°</span>
                <span class="wc-feels">Feels ${w.feelsLike}°</span>
            </div>
            <div class="wc-indicators">
                <div class="wc-ind" title="Humidity"><span class="wc-ind-icon">💧</span><span class="wc-ind-val">${w.humidity}%</span></div>
                <div class="wc-ind" title="Wind"><span class="wc-ind-icon">↗</span><span class="wc-ind-val">${w.windSpeed}<small>km/h</small></span></div>
                ${w.uv != null ? `<div class="wc-ind" title="UV Index"><span class="wc-ind-icon">◐</span><span class="wc-ind-val">${w.uv}</span></div>` : ''}
            </div>
            <div class="wc-accent-bar"></div>
        </div>`;
    }).join('');
}

// ─── 7-day forecast builder ────────────────────────────────────────────────

const _DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function _buildForecastHTML(forecast) {
    if (!forecast || forecast.length === 0) return '';

    // Determine the global temp range across all days for the bar scale
    const allMax = forecast.map(d => d.tempMax);
    const allMin = forecast.map(d => d.tempMin);
    const rangeMax = Math.max(...allMax);
    const rangeMin = Math.min(...allMin);
    const totalRange = Math.max(1, rangeMax - rangeMin);

    const rows = forecast.map((day, i) => {
        const date    = new Date(day.date + 'T12:00:00');
        const label   = i === 0 ? 'Today' : _DAY_NAMES[date.getDay()];
        const { icon } = _wmoInfo(day.code);

        // Temperature range bar: position within global scale
        const barLeft  = ((day.tempMin - rangeMin) / totalRange * 100).toFixed(1);
        const barWidth = ((day.tempMax - day.tempMin) / totalRange * 100).toFixed(1);

        const precipText = day.precipPct != null
            ? `${day.precipPct}%`
            : day.precip > 0 ? `${day.precip}mm` : '';

        return `
        <div class="wp-fc-row${i === 0 ? ' wp-fc-today' : ''}">
            <span class="wp-fc-day">${label}</span>
            <span class="wp-fc-icon">${icon}</span>
            <span class="wp-fc-lo">${day.tempMin}°</span>
            <div class="wp-fc-bar-track">
                <div class="wp-fc-bar" style="left:${barLeft}%;width:${barWidth}%"></div>
            </div>
            <span class="wp-fc-hi">${day.tempMax}°</span>
            <span class="wp-fc-rain">${precipText}</span>
        </div>`;
    }).join('');

    return `
    <div class="wp-forecast">
        <div class="wp-section-title">7-Day Forecast</div>
        ${rows}
    </div>`;
}

// ─── Popout ────────────────────────────────────────────────────────────────

function openWeatherPopout(idx, cardEl) {
    const entry = _weatherCache[idx];
    if (!entry || entry.error || !entry.weather) return;

    const { region, weather: w } = entry;
    const { icon, label, bg } = _wmoInfo(w.code);
    const level = _tempLevel(w.temp);
    const uv = _uvLabel(w.uv ?? 0);
    const compass = _degToCompass(w.windDir);

    const pop = document.getElementById('weather-popout');
    if (!pop) return;

    pop.dataset.tempLevel = level;
    pop.dataset.bg = bg;

    pop.innerHTML = `
    <div class="wp-close-btn" onclick="closeWeatherPopout()">✕</div>

    <div class="wp-header">
        <div class="wp-title-row">
            <span class="wp-flag">${flagImg(region.iso, 28)}</span>
            <div>
                <div class="wp-name">${region.name}</div>
                <div class="wp-country">${region.country}</div>
            </div>
        </div>
        <div class="wp-main-weather">
            <span class="wp-big-icon">${icon}</span>
            <div class="wp-main-temps">
                <span class="wp-main-temp">${w.temp}°C</span>
                <span class="wp-feels">${w.feelsLike}°C feels like</span>
            </div>
        </div>
        <div class="wp-condition">${label}</div>
    </div>

    <div class="wp-grid">
        <div class="wp-metric">
            <span class="wp-metric-icon">💧</span>
            <span class="wp-metric-label">Humidity</span>
            <span class="wp-metric-value">${w.humidity}%</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">🌡️</span>
            <span class="wp-metric-label">Dew Point</span>
            <span class="wp-metric-value">${w.dewPoint}°C</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">🌬️</span>
            <span class="wp-metric-label">Wind</span>
            <span class="wp-metric-value">${w.windSpeed} km/h ${compass}</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">💨</span>
            <span class="wp-metric-label">Gusts</span>
            <span class="wp-metric-value">${w.windGust} km/h</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">☁️</span>
            <span class="wp-metric-label">Cloud Cover</span>
            <span class="wp-metric-value">${w.cloud}%</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">🌧️</span>
            <span class="wp-metric-label">Precipitation</span>
            <span class="wp-metric-value">${w.precip} mm</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">🔭</span>
            <span class="wp-metric-label">Visibility</span>
            <span class="wp-metric-value">${w.visibility != null ? w.visibility + ' km' : '—'}</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">📊</span>
            <span class="wp-metric-label">Pressure</span>
            <span class="wp-metric-value">${w.pressure} hPa</span>
        </div>
        <div class="wp-metric">
            <span class="wp-metric-icon">☀️</span>
            <span class="wp-metric-label">UV Index</span>
            <span class="wp-metric-value"><span class="${uv.cls}">${w.uv ?? '—'} · ${uv.text}</span></span>
        </div>
    </div>

    <div class="wp-wind-visual">
        <div class="wp-wind-dial" style="--wind-dir: ${w.windDir}deg">
            <div class="wp-wind-needle"></div>
            <span class="wp-compass-label wp-N">N</span>
            <span class="wp-compass-label wp-E">E</span>
            <span class="wp-compass-label wp-S">S</span>
            <span class="wp-compass-label wp-W">W</span>
        </div>
        <div class="wp-wind-info">
            <div class="wp-wind-stat"><span class="wp-wind-stat-label">Direction</span><span class="wp-wind-stat-val">${compass} (${w.windDir}°)</span></div>
            <div class="wp-wind-stat"><span class="wp-wind-stat-label">Speed</span><span class="wp-wind-stat-val">${w.windSpeed} km/h</span></div>
            <div class="wp-wind-stat"><span class="wp-wind-stat-label">Gusts</span><span class="wp-wind-stat-val">${w.windGust} km/h</span></div>
        </div>
    </div>

    ${_buildForecastHTML(w.forecast)}

    <div class="wp-footer">Live data · Open-Meteo · ${w.timezone} · Updates every 30 min</div>`;

    // Position to the right of the sidebar
    const rect = cardEl.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar');
    const sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : rect.right;

    pop.style.display = 'block';
    pop.style.top = Math.max(60, rect.top - 20) + 'px';
    pop.style.left = (sidebarRight + 10) + 'px';

    // Keep popout within viewport vertically
    requestAnimationFrame(() => {
        const popH = pop.offsetHeight;
        const vh = window.innerHeight;
        const currentTop = parseFloat(pop.style.top);
        if (currentTop + popH > vh - 10) {
            pop.style.top = Math.max(60, vh - popH - 10) + 'px';
        }
    });

    // Overlay to close on outside click
    document.getElementById('weather-popout-overlay').style.display = 'block';
}

function closeWeatherPopout() {
    const pop = document.getElementById('weather-popout');
    const overlay = document.getElementById('weather-popout-overlay');
    if (pop) pop.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// ─── Load & init ────────────────────────────────────────────────────────────

async function loadWeather() {
    const results = await Promise.all(
        WEATHER_REGIONS.map(async region => {
            try {
                const weather = await _fetchRegionWeather(region);
                return { region, weather, error: false };
            } catch {
                return { region, weather: null, error: true };
            }
        })
    );
    _weatherCache = results;
    _renderWeatherCards(results);
}

async function retryWeatherCard(idx) {
    const region = WEATHER_REGIONS[idx];
    if (!region) return;

    const container = document.getElementById('weather-cards');
    const card = container?.querySelector(`[data-weather-idx="${idx}"]`);
    if (card) {
        card.style.opacity = '0.5';
        card.style.pointerEvents = 'none';
        card.querySelector('.wc-retry-icon').textContent = '…';
    }

    try {
        const weather = await _fetchRegionWeather(region);
        _weatherCache[idx] = { region, weather, error: false };
    } catch {
        _weatherCache[idx] = { region, weather: null, error: true };
    }
    _renderWeatherCards(_weatherCache);
}

function initWeather() {
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', initWeather);
