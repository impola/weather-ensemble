import asyncio
import httpx
from statistics import mean, stdev
from typing import Optional

MODELS = {
    "ECMWF": "ecmwf_ifs025",
    "GFS":   "gfs_seamless",
    "ICON":  "icon_seamless",
    "GEM":   "gem_seamless",
}

WMO_CODES = {
    0:  ("Clear Sky",                "☀️"),
    1:  ("Mainly Clear",             "🌤️"),
    2:  ("Partly Cloudy",            "⛅"),
    3:  ("Overcast",                 "☁️"),
    45: ("Foggy",                    "🌫️"),
    48: ("Icy Fog",                  "🌫️"),
    51: ("Light Drizzle",            "🌦️"),
    53: ("Drizzle",                  "🌦️"),
    55: ("Heavy Drizzle",            "🌧️"),
    61: ("Light Rain",               "🌧️"),
    63: ("Rain",                     "🌧️"),
    65: ("Heavy Rain",               "🌧️"),
    71: ("Light Snow",               "🌨️"),
    73: ("Snow",                     "❄️"),
    75: ("Heavy Snow",               "❄️"),
    77: ("Snow Grains",              "🌨️"),
    80: ("Rain Showers",             "🌦️"),
    81: ("Heavy Showers",            "🌧️"),
    82: ("Violent Showers",          "⛈️"),
    85: ("Snow Showers",             "🌨️"),
    86: ("Heavy Snow Showers",       "❄️"),
    95: ("Thunderstorm",             "⛈️"),
    96: ("Thunderstorm w/ Hail",     "⛈️"),
    99: ("Thunderstorm w/ Heavy Hail","⛈️"),
}


def describe_weather(code) -> dict:
    code = int(code) if code is not None else 0
    if code in WMO_CODES:
        desc, icon = WMO_CODES[code]
    else:
        nearest = min(WMO_CODES.keys(), key=lambda k: abs(k - code))
        desc, icon = WMO_CODES[nearest]
    return {"description": desc, "icon": icon, "code": code}


def safe_mean(values: list):
    vals = [v for v in values if v is not None]
    return round(mean(vals), 1) if vals else None


def safe_stdev(values: list):
    vals = [v for v in values if v is not None]
    return round(stdev(vals), 2) if len(vals) >= 2 else 0.0


def majority_vote(values: list):
    vals = [v for v in values if v is not None]
    return max(set(vals), key=vals.count) if vals else None


def confidence_label(spread: float) -> str:
    if spread is None or spread < 1.0:
        return "High"
    elif spread < 2.5:
        return "Medium"
    else:
        return "Low"


async def reverse_geocode(lat: float, lon: float) -> dict:
    url = "https://nominatim.openstreetmap.org/reverse"
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            params={"lat": lat, "lon": lon, "format": "json"},
            headers={"User-Agent": "WeatherEnsemble/1.0"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    addr = data.get("address", {})
    city = (addr.get("city") or addr.get("town") or addr.get("village")
            or addr.get("municipality") or addr.get("county") or "")
    country = addr.get("country_code", "").upper()
    return {"name": city, "country": country}


async def geocode_location(query: str) -> list:
    url = "https://geocoding-api.open-meteo.com/v1/search"
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            params={"name": query, "count": 6, "language": "en"},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
    return [
        {
            "name":    r.get("name", ""),
            "country": r.get("country", ""),
            "admin1":  r.get("admin1", ""),
            "lat":     r["latitude"],
            "lon":     r["longitude"],
        }
        for r in results
    ]


async def _fetch_model(
    client: httpx.AsyncClient, lat: float, lon: float, model_id: str
) -> Optional[dict]:
    params = {
        "latitude":  lat,
        "longitude": lon,
        "current":   (
            "temperature_2m,apparent_temperature,precipitation,"
            "wind_speed_10m,weather_code,relative_humidity_2m,wind_direction_10m"
        ),
        "hourly": "temperature_2m,precipitation",
        "daily": (
            "temperature_2m_max,temperature_2m_min,precipitation_sum,"
            "wind_speed_10m_max,weather_code,precipitation_probability_max"
        ),
        "models":       model_id,
        "timezone":     "auto",
        "forecast_days": 7,
    }
    try:
        resp = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params=params,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _extract_current(data: dict) -> dict:
    c = data.get("current", {})
    return {
        "temperature":   c.get("temperature_2m"),
        "feels_like":    c.get("apparent_temperature"),
        "precipitation": c.get("precipitation"),
        "wind_speed":    c.get("wind_speed_10m"),
        "wind_dir":      c.get("wind_direction_10m"),
        "humidity":      c.get("relative_humidity_2m"),
        "weather":       describe_weather(c.get("weather_code")),
    }


def _build_ensemble_current(model_data: dict) -> dict:
    by_model = {name: _extract_current(data) for name, data in model_data.items()}

    temps   = [v["temperature"]   for v in by_model.values()]
    feels   = [v["feels_like"]    for v in by_model.values()]
    winds   = [v["wind_speed"]    for v in by_model.values()]
    dirs    = [v["wind_dir"]      for v in by_model.values()]
    humids  = [v["humidity"]      for v in by_model.values()]
    precips = [v["precipitation"] for v in by_model.values()]
    codes   = [v["weather"]["code"] for v in by_model.values()]

    spread = safe_stdev(temps)
    return {
        "ensemble": {
            "temperature":        safe_mean(temps),
            "temperature_spread": spread,
            "feels_like":         safe_mean(feels),
            "wind_speed":         safe_mean(winds),
            "wind_dir":           safe_mean(dirs),
            "humidity":           safe_mean(humids),
            "precipitation":      safe_mean(precips),
            "weather":            describe_weather(majority_vote(codes)),
            "confidence":         confidence_label(spread),
        },
        "by_model": by_model,
    }


def _build_ensemble_daily(model_data: dict) -> list:
    first = next(iter(model_data.values()))
    dates  = first["daily"]["time"]
    n_days = len(dates)

    def col(data, key, i):
        arr = data["daily"].get(key)
        if arr is None or i >= len(arr):
            return None
        return arr[i]

    days = []
    for i in range(n_days):
        max_temps   = [col(d, "temperature_2m_max", i)         for d in model_data.values()]
        min_temps   = [col(d, "temperature_2m_min", i)         for d in model_data.values()]
        precip      = [col(d, "precipitation_sum", i)          for d in model_data.values()]
        wind        = [col(d, "wind_speed_10m_max", i)         for d in model_data.values()]
        w_codes     = [col(d, "weather_code", i)               for d in model_data.values()]
        precip_prob = [col(d, "precipitation_probability_max", i) for d in model_data.values()]

        spread = safe_stdev(max_temps)
        days.append({
            "date":                     dates[i],
            "temp_max":                 safe_mean(max_temps),
            "temp_min":                 safe_mean(min_temps),
            "precipitation":            safe_mean(precip),
            "precipitation_probability": safe_mean([p for p in precip_prob if p is not None]),
            "wind_speed":               safe_mean(wind),
            "weather":                  describe_weather(majority_vote(w_codes)),
            "spread":                   spread,
            "confidence":               confidence_label(spread),
            "by_model": {
                name: {
                    "temp_max": col(data, "temperature_2m_max", i),
                    "temp_min": col(data, "temperature_2m_min", i),
                    "weather":  describe_weather(col(data, "weather_code", i)),
                }
                for name, data in model_data.items()
            },
        })
    return days


def _build_ensemble_hourly(model_data: dict) -> dict:
    first = next(iter(model_data.values()))
    times = first["hourly"]["time"]
    n = len(times)

    def hcol(data, key, i):
        arr = data["hourly"].get(key)
        if arr is None or i >= len(arr):
            return None
        return arr[i]

    ensemble_temps = []
    ensemble_precip = []
    temp_max = []
    temp_min = []
    by_model = {name: [] for name in model_data}

    for i in range(n):
        temps   = [hcol(d, "temperature_2m", i) for d in model_data.values()]
        precips = [hcol(d, "precipitation",  i) for d in model_data.values()]
        valid   = [t for t in temps if t is not None]
        ensemble_temps.append(safe_mean(temps))
        ensemble_precip.append(safe_mean(precips))
        temp_max.append(round(max(valid), 1) if valid else None)
        temp_min.append(round(min(valid), 1) if valid else None)
        for name, data in model_data.items():
            by_model[name].append(hcol(data, "temperature_2m", i))

    return {
        "times":    times,
        "ensemble": ensemble_temps,
        "precip":   ensemble_precip,
        "max":      temp_max,
        "min":      temp_min,
        "by_model": by_model,
    }


async def get_ensemble_forecast(lat: float, lon: float) -> dict:
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *[_fetch_model(client, lat, lon, mid) for mid in MODELS.values()]
        )

    model_data = {
        name: result
        for name, result in zip(MODELS.keys(), results)
        if result is not None
    }

    if not model_data:
        raise RuntimeError("All weather models failed to respond")

    first = next(iter(model_data.values()))
    current = _build_ensemble_current(model_data)
    forecast = _build_ensemble_daily(model_data)
    hourly  = _build_ensemble_hourly(model_data)

    return {
        "current":      current["ensemble"],
        "by_model":     current["by_model"],
        "forecast":     forecast,
        "hourly":       hourly,
        "models_used":  list(model_data.keys()),
        "timezone":     first.get("timezone", "UTC"),
        "utc_offset_seconds": first.get("utc_offset_seconds", 0),
    }
