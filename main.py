from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from weather import geocode_location, reverse_geocode, get_ensemble_forecast

app = FastAPI(title="Weather Ensemble API", version="1.0.0")

# Allow any origin so future mobile apps can call this API directly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/reverse")
async def reverse(lat: float = Query(...), lon: float = Query(...)):
    return await reverse_geocode(lat, lon)


@app.get("/api/geocode")
async def geocode(q: str = Query(..., min_length=1)):
    results = await geocode_location(q)
    if not results:
        raise HTTPException(status_code=404, detail="Location not found")
    return results


@app.get("/api/weather")
async def weather(
    lat: float = Query(...),
    lon: float = Query(...),
    name: str = Query(default=""),
):
    try:
        data = await get_ensemble_forecast(lat, lon)
        data["location_name"] = name
        return data
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")


# Serve frontend — must be last so API routes take priority
app.mount("/", StaticFiles(directory="static", html=True), name="static")
