import asyncio
import json
import os
import re
import httpx
import anthropic
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean, stdev
from typing import Optional

MODELS = {
    "ECMWF": "ecmwf_ifs025",
    "GFS":   "gfs_seamless",
    "ICON":  "icon_seamless",
    "GEM":   "gem_seamless",
}

WMO_CODES = {
    0:  ("Klart",                       "☀️"),
    1:  ("Mestadels klart",             "🌤️"),
    2:  ("Delvis molnigt",              "⛅"),
    3:  ("Mulet",                       "☁️"),
    45: ("Dimma",                       "🌫️"),
    48: ("Ishalka",                     "🌫️"),
    51: ("Lätt duggregn",               "🌦️"),
    53: ("Duggregn",                    "🌦️"),
    55: ("Kraftigt duggregn",           "🌧️"),
    61: ("Lätt regn",                   "🌧️"),
    63: ("Regn",                        "🌧️"),
    65: ("Kraftigt regn",               "🌧️"),
    71: ("Lätt snöfall",                "🌨️"),
    73: ("Snöfall",                     "❄️"),
    75: ("Kraftigt snöfall",            "❄️"),
    77: ("Snöflingor",                  "🌨️"),
    80: ("Regnskurar",                  "🌦️"),
    81: ("Kraftiga regnskurar",         "🌧️"),
    82: ("Häftiga regnskurar",          "⛈️"),
    85: ("Snöbyar",                     "🌨️"),
    86: ("Kraftiga snöbyar",            "❄️"),
    95: ("Åskväder",                    "⛈️"),
    96: ("Åskväder med hagel",          "⛈️"),
    99: ("Åskväder med kraftigt hagel", "⛈️"),
}

SMHI_WSYMB2_TO_WMO = {
    1:  0,   # Clear sky
    2:  1,   # Nearly clear sky
    3:  2,   # Variable cloudiness
    4:  2,   # Halfclear sky
    5:  3,   # Cloudy sky
    6:  3,   # Overcast
    7:  45,  # Fog
    8:  80,  # Light rain showers
    9:  80,  # Moderate rain showers
    10: 81,  # Heavy rain showers
    11: 95,  # Thunderstorm
    12: 80,  # Light sleet showers
    13: 80,  # Moderate sleet showers
    14: 81,  # Heavy sleet showers
    15: 85,  # Light snow showers
    16: 85,  # Moderate snow showers
    17: 86,  # Heavy snow showers
    18: 61,  # Light rain
    19: 63,  # Moderate rain
    20: 65,  # Heavy rain
    21: 95,  # Thunder
    22: 61,  # Light sleet
    23: 63,  # Moderate sleet
    24: 65,  # Heavy sleet
    25: 71,  # Light snowfall
    26: 73,  # Moderate snowfall
    27: 75,  # Heavy snowfall
}

YR_SYMBOL_TO_WMO = {
    "clearsky":              0,
    "fair":                  1,
    "partlycloudy":          2,
    "cloudy":                3,
    "fog":                   45,
    "lightrain":             61,
    "rain":                  63,
    "heavyrain":             65,
    "lightsleet":            61,
    "sleet":                 63,
    "heavysleet":            65,
    "lightsnow":             71,
    "snow":                  73,
    "heavysnow":             75,
    "lightrainshowers":      80,
    "rainshowers":           80,
    "heavyrainshowers":      81,
    "lightsnowshowers":      85,
    "snowshowers":           85,
    "heavysnowshowers":      86,
    "lightsleetshowers":     80,
    "sleetshowers":          80,
    "heavysleetshowers":     81,
    "thunder":               95,
    "lightrainandthunder":   95,
    "rainandthunder":        95,
    "heavyrainandthunder":   95,
    "lightsnowandthunder":   95,
    "snowandthunder":        95,
    "lightsleetandthunder":  95,
    "sleetandthunder":       95,
}


def _yr_symbol_to_wmo(symbol_code: str) -> int:
    base = symbol_code.split("_")[0] if symbol_code else ""
    return YR_SYMBOL_TO_WMO.get(base, 2)


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
        "hourly": "temperature_2m,precipitation,weather_code",
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


async def _fetch_yr(client: httpx.AsyncClient, lat: float, lon: float) -> Optional[dict]:
    try:
        resp = await client.get(
            "https://api.met.no/weatherapi/locationforecast/2.0/compact",
            params={"lat": round(lat, 4), "lon": round(lon, 4)},
            headers={"User-Agent": "WeatherEnsemble/1.0 https://weatherensemble.app"},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _normalize_yr(yr_data: dict, utc_offset_seconds: int) -> Optional[dict]:
    """Convert YR GeoJSON response into an Open-Meteo-compatible dict."""
    try:
        timeseries = yr_data["properties"]["timeseries"]
        tz_delta = timedelta(seconds=utc_offset_seconds)

        hourly_times:  list = []
        hourly_temps:  list = []
        hourly_precip: list = []
        hourly_codes:  list = []

        daily: dict = defaultdict(lambda: {
            "temps": [], "precips": [], "winds": [], "codes": []
        })

        for entry in timeseries:
            utc_dt   = datetime.fromisoformat(entry["time"].replace("Z", "+00:00"))
            local_dt = utc_dt + tz_delta
            time_str = local_dt.strftime("%Y-%m-%dT%H:%M")
            date_str = local_dt.strftime("%Y-%m-%d")

            details = entry["data"]["instant"]["details"]
            temp    = details.get("air_temperature")
            wind_ms = details.get("wind_speed", 0.0)

            next1 = entry["data"].get("next_1_hours")
            next6 = entry["data"].get("next_6_hours")
            precip = None
            symbol = ""
            if next1:
                precip = next1.get("details", {}).get("precipitation_amount")
                symbol = next1.get("summary", {}).get("symbol_code", "")
            elif next6:
                precip = next6.get("details", {}).get("precipitation_amount")
                symbol = next6.get("summary", {}).get("symbol_code", "")

            hourly_times.append(time_str)
            hourly_temps.append(temp)
            hourly_precip.append(precip if precip is not None else 0.0)
            hourly_codes.append(_yr_symbol_to_wmo(symbol))

            if temp is not None:
                daily[date_str]["temps"].append(temp)
            daily[date_str]["winds"].append(wind_ms * 3.6)
            if precip is not None:
                daily[date_str]["precips"].append(precip)
            daily[date_str]["codes"].append(_yr_symbol_to_wmo(symbol))

        # Current: first entry
        first   = timeseries[0]
        fd      = first["data"]["instant"]["details"]
        fn1     = first["data"].get("next_1_hours") or first["data"].get("next_6_hours") or {}
        fsymbol = fn1.get("summary", {}).get("symbol_code", "")
        current = {
            "temperature_2m":      fd.get("air_temperature"),
            "apparent_temperature": fd.get("air_temperature"),  # YR has no feels-like
            "wind_speed_10m":      round(fd.get("wind_speed", 0.0) * 3.6, 1),
            "wind_direction_10m":  fd.get("wind_from_direction"),
            "relative_humidity_2m": fd.get("relative_humidity"),
            "precipitation":       fn1.get("details", {}).get("precipitation_amount", 0.0),
            "weather_code":        _yr_symbol_to_wmo(fsymbol),
        }

        dates = sorted(daily.keys())[:7]
        return {
            "current": current,
            "hourly": {
                "time":           hourly_times,
                "temperature_2m": hourly_temps,
                "precipitation":  hourly_precip,
                "weather_code":   hourly_codes,
            },
            "daily": {
                "time":                          dates,
                "temperature_2m_max":            [round(max(daily[d]["temps"]), 1) if daily[d]["temps"] else None for d in dates],
                "temperature_2m_min":            [round(min(daily[d]["temps"]), 1) if daily[d]["temps"] else None for d in dates],
                "precipitation_sum":             [round(sum(daily[d]["precips"]), 1) for d in dates],
                "wind_speed_10m_max":            [round(max(daily[d]["winds"]), 1) if daily[d]["winds"] else None for d in dates],
                "weather_code":                  [majority_vote(daily[d]["codes"]) or 0 for d in dates],
                "precipitation_probability_max": [None] * len(dates),
            },
            "timezone":           "local",
            "utc_offset_seconds": utc_offset_seconds,
        }
    except Exception:
        return None


async def _fetch_smhi(client: httpx.AsyncClient, lat: float, lon: float) -> Optional[dict]:
    try:
        resp = await client.get(
            f"https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2"
            f"/geotype/point/lon/{round(lon, 4)}/lat/{round(lat, 4)}/data.json",
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _smhi_params(parameters: list) -> dict:
    """Convert SMHI parameters list to a name→value dict."""
    return {p["name"]: p["values"][0] for p in parameters if p.get("values")}


def _normalize_smhi(smhi_data: dict, utc_offset_seconds: int) -> Optional[dict]:
    """Convert SMHI response into an Open-Meteo-compatible dict."""
    try:
        timeseries = smhi_data["timeSeries"]
        tz_delta   = timedelta(seconds=utc_offset_seconds)

        hourly_times:  list = []
        hourly_temps:  list = []
        hourly_precip: list = []
        hourly_codes:  list = []

        daily: dict = defaultdict(lambda: {
            "temps": [], "precips": [], "winds": [], "codes": []
        })

        for entry in timeseries:
            utc_dt   = datetime.fromisoformat(entry["validTime"].replace("Z", "+00:00"))
            local_dt = utc_dt + tz_delta
            time_str = local_dt.strftime("%Y-%m-%dT%H:%M")
            date_str = local_dt.strftime("%Y-%m-%d")

            p       = _smhi_params(entry["parameters"])
            temp    = p.get("t")
            wind_ms = p.get("ws", 0.0)
            precip  = p.get("pmean", 0.0)
            wsymb   = int(p["Wsymb2"]) if "Wsymb2" in p else None
            wmo     = SMHI_WSYMB2_TO_WMO.get(wsymb, 2) if wsymb else 2

            hourly_times.append(time_str)
            hourly_temps.append(temp)
            hourly_precip.append(precip if precip is not None else 0.0)
            hourly_codes.append(wmo)

            if temp is not None:
                daily[date_str]["temps"].append(temp)
            daily[date_str]["winds"].append(wind_ms * 3.6)
            daily[date_str]["precips"].append(precip or 0.0)
            daily[date_str]["codes"].append(wmo)

        first_p = _smhi_params(timeseries[0]["parameters"])
        fsymb   = int(first_p["Wsymb2"]) if "Wsymb2" in first_p else None
        current = {
            "temperature_2m":       first_p.get("t"),
            "apparent_temperature": first_p.get("t"),  # SMHI has no feels-like
            "wind_speed_10m":       round(first_p.get("ws", 0.0) * 3.6, 1),
            "wind_direction_10m":   first_p.get("wd"),
            "relative_humidity_2m": first_p.get("r"),
            "precipitation":        first_p.get("pmean", 0.0),
            "weather_code":         SMHI_WSYMB2_TO_WMO.get(fsymb, 2) if fsymb else 2,
        }

        dates = sorted(daily.keys())[:7]
        return {
            "current": current,
            "hourly": {
                "time":           hourly_times,
                "temperature_2m": hourly_temps,
                "precipitation":  hourly_precip,
                "weather_code":   hourly_codes,
            },
            "daily": {
                "time":                          dates,
                "temperature_2m_max":            [round(max(daily[d]["temps"]), 1) if daily[d]["temps"] else None for d in dates],
                "temperature_2m_min":            [round(min(daily[d]["temps"]), 1) if daily[d]["temps"] else None for d in dates],
                "precipitation_sum":             [round(sum(daily[d]["precips"]), 1) for d in dates],
                "wind_speed_10m_max":            [round(max(daily[d]["winds"]), 1) if daily[d]["winds"] else None for d in dates],
                "weather_code":                  [majority_vote(daily[d]["codes"]) or 0 for d in dates],
                "precipitation_probability_max": [None] * len(dates),
            },
            "timezone":           "local",
            "utc_offset_seconds": utc_offset_seconds,
        }
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
    ensemble_codes = []
    temp_max = []
    temp_min = []
    by_model        = {name: [] for name in model_data}
    by_model_precip = {name: [] for name in model_data}

    for i in range(n):
        temps   = [hcol(d, "temperature_2m", i) for d in model_data.values()]
        precips = [hcol(d, "precipitation",  i) for d in model_data.values()]
        codes   = [hcol(d, "weather_code",   i) for d in model_data.values()]
        valid   = [t for t in temps if t is not None]
        ensemble_temps.append(safe_mean(temps))
        ensemble_precip.append(safe_mean(precips))
        ensemble_codes.append(majority_vote(codes))
        temp_max.append(round(max(valid), 1) if valid else None)
        temp_min.append(round(min(valid), 1) if valid else None)
        for name, data in model_data.items():
            by_model[name].append(hcol(data, "temperature_2m", i))
            by_model_precip[name].append(hcol(data, "precipitation", i))

    return {
        "times":          times,
        "ensemble":       ensemble_temps,
        "precip":         ensemble_precip,
        "codes":          ensemble_codes,
        "max":            temp_max,
        "min":            temp_min,
        "by_model":       by_model,
        "by_model_precip": by_model_precip,
    }


async def _get_ai_analysis(
    model_data: dict,
    ensemble_current: dict,
    forecast: list,
    location_name: str,
) -> dict:
    """Call Claude Opus to intelligently interpret the multi-model ensemble."""
    fallback = {
        "sammanfattning": None, "basta_modell": None,
        "avvikande_modeller": [], "justerad_konfidens": None,
        "motivering": None, "trend": None,
    }
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return fallback

    try:
        # Compact per-model snapshot
        model_lines = []
        for name, data in model_data.items():
            c = data.get("current", {})
            h = data.get("hourly", {})
            p24 = round(sum(v for v in (h.get("precipitation") or [])[:24] if v is not None), 1)
            model_lines.append(
                f"  {name}: {c.get('temperature_2m')}°C, "
                f"vind {c.get('wind_speed_10m')} km/h, "
                f"24h-nedbör {p24} mm, kod {c.get('weather_code')}"
            )

        day_lines = []
        for d in forecast[:3]:
            day_lines.append(
                f"  {d['date']}: max {d['temp_max']}°C min {d['temp_min']}°C "
                f"nedbör {d['precipitation']} mm"
            )

        prompt = (
            f"Du är meteorolog. Analysera ensemble-prognosen för {location_name or 'okänd plats'}.\n\n"
            "Modelldata just nu:\n" + "\n".join(model_lines) + "\n\n"
            f"Ensemble-medel: {ensemble_current.get('temperature')}°C, "
            f"modellspridning: {ensemble_current.get('temperature_spread')}°C\n\n"
            "3-dagsprognos (ensemble):\n" + "\n".join(day_lines) + "\n\n"
            "Returnera ENBART ett JSON-objekt utan förklaring:\n"
            '{"sammanfattning":"<en mening på svenska, max 20 ord>",'
            '"basta_modell":"<ECMWF|GFS|ICON|GEM|YR|SMHI>",'
            '"avvikande_modeller":["<modell om relevant, annars tom lista>"],'
            '"justerad_konfidens":"<Hög|Medel|Låg>",'
            '"motivering":"<en mening på svenska, max 15 ord>",'
            '"trend":"<stigande|sjunkande|stabilt>"}'
        )

        client = anthropic.AsyncAnthropic(api_key=api_key)
        response = await asyncio.wait_for(
            client.messages.create(
                model="claude-opus-4-6",
                max_tokens=400,
                thinking={"type": "adaptive"},
                messages=[{"role": "user", "content": prompt}],
            ),
            timeout=12.0,
        )

        # Skip thinking blocks, extract text
        text = next((b.text for b in response.content if b.type == "text"), "")
        match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
        if match:
            result = json.loads(match.group())
            if "sammanfattning" in result:
                return result

    except Exception:
        pass

    return fallback


async def get_ensemble_forecast(lat: float, lon: float, location_name: str = "") -> dict:
    async with httpx.AsyncClient() as client:
        *om_results, yr_raw, smhi_raw = await asyncio.gather(
            *[_fetch_model(client, lat, lon, mid) for mid in MODELS.values()],
            _fetch_yr(client, lat, lon),
            _fetch_smhi(client, lat, lon),
        )

    model_data = {
        name: result
        for name, result in zip(MODELS.keys(), om_results)
        if result is not None
    }

    if not model_data:
        raise RuntimeError("All weather models failed to respond")

    first = next(iter(model_data.values()))
    utc_offset = first.get("utc_offset_seconds", 0)

    if yr_raw:
        yr_normalized = _normalize_yr(yr_raw, utc_offset)
        if yr_normalized:
            model_data["YR"] = yr_normalized

    if smhi_raw:
        smhi_normalized = _normalize_smhi(smhi_raw, utc_offset)
        if smhi_normalized:
            model_data["SMHI"] = smhi_normalized

    current  = _build_ensemble_current(model_data)
    forecast = _build_ensemble_daily(model_data)
    hourly   = _build_ensemble_hourly(model_data)

    ai_analysis = await _get_ai_analysis(
        model_data, current["ensemble"], forecast, location_name
    )

    return {
        "current":            current["ensemble"],
        "by_model":           current["by_model"],
        "forecast":           forecast,
        "hourly":             hourly,
        "models_used":        list(model_data.keys()),
        "timezone":           first.get("timezone", "UTC"),
        "utc_offset_seconds": utc_offset,
        "ai_analysis":        ai_analysis,
    }
