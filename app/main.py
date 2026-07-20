import os
import uuid
import json
import base64
import io
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image
import gspread
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

load_dotenv()

app = FastAPI(title="Cellar Ledger")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REFRESH_TOKEN = os.getenv("GOOGLE_REFRESH_TOKEN")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")

openai_client = OpenAI(api_key=OPENAI_API_KEY)

# In-memory session store (session_id -> state dict)
sessions: dict = {}

MAX_IMAGE_PX = 1024

EXTRACTION_PROMPT = """You are reading a wine bottle label photograph. Extract ONLY what is explicitly printed on the label — do not infer, guess, research, or fill in anything not clearly visible.

Return a JSON object with exactly these keys:
{
  "producer": "<brand or producer name as printed, or null>",
  "vintage": "<4-digit year as printed, or null if not visible>",
  "variety": "<grape variety as printed, or null if not visible>",
  "appellation": "<appellation of origin as printed, or null if not visible>",
  "country": "<country as printed on the label, or null>"
}

Return ONLY valid JSON. No explanation, no markdown."""

RESEARCH_PROMPT_TEMPLATE = """You are a professional wine critic and sommelier. Using only the validated wine details below, write tasting notes, list the primary aromas and flavors, give an estimated USD retail price, and assign an expert rating.

Wine: {producer} {vintage} {variety}, {appellation}, {country}

Return a JSON object with exactly these keys:
{{
  "tasting_notes": "<2-3 sentence professional tasting description>",
  "aromas": "<comma-separated list of 4-6 primary aromas and flavors>",
  "price": "<estimated USD retail price, e.g. '$45'>",
  "rating": "<score out of 100, e.g. '91/100'>"
}}

Return ONLY valid JSON. No explanation, no markdown."""


def resize_and_encode(image_bytes: bytes) -> tuple[str, str]:
    """Resize image to max MAX_IMAGE_PX and return (base64_string, mime_type)."""
    img = Image.open(io.BytesIO(image_bytes))
    img.thumbnail((MAX_IMAGE_PX, MAX_IMAGE_PX), Image.LANCZOS)

    output = io.BytesIO()
    save_format = "JPEG" if img.mode in ("RGB", "L") else "PNG"
    if img.mode == "RGBA" and save_format == "JPEG":
        img = img.convert("RGB")
    img.save(output, format=save_format)
    output.seek(0)

    b64 = base64.b64encode(output.read()).decode("utf-8")
    mime = "image/jpeg" if save_format == "JPEG" else "image/png"
    return b64, mime


def append_to_sheet(fields: dict, researched: dict) -> None:
    creds = Credentials(
        token=None,
        refresh_token=GOOGLE_REFRESH_TOKEN,
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    creds.refresh(Request())
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(GOOGLE_SHEET_ID)
    ws = sh.sheet1
    ws.append_row([
        fields.get("producer", ""),
        fields.get("vintage", ""),
        fields.get("variety", ""),
        fields.get("appellation", ""),
        fields.get("country", ""),
        researched.get("tasting_notes", ""),
        researched.get("aromas", ""),
        researched.get("price", ""),
        researched.get("rating", ""),
    ])


# ── API routes ─────────────────────────────────────────────────────────────────

@app.post("/api/scan")
async def scan_label(file: UploadFile = File(...)):
    if file.content_type not in ("image/jpeg", "image/jpg", "image/png"):
        raise HTTPException(status_code=400, detail="Only JPG/PNG images are supported.")

    image_bytes = await file.read()
    file_size_kb = round(len(image_bytes) / 1024, 1)

    try:
        b64, mime = resize_and_encode(image_bytes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not process image: {exc}")

    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EXTRACTION_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{b64}"},
                        },
                    ],
                }
            ],
            max_tokens=300,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI label extraction failed: {exc}")

    raw = response.choices[0].message.content
    try:
        extracted = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned malformed JSON during extraction.")

    session_id = str(uuid.uuid4())
    sessions[session_id] = {"extracted": extracted, "file_size_kb": file_size_kb}

    return {"session_id": session_id, "extracted": extracted, "file_size_kb": file_size_kb}


class ConfirmedFields(BaseModel):
    producer: str = ""
    vintage: Optional[str] = ""
    variety: Optional[str] = ""
    appellation: Optional[str] = ""
    country: Optional[str] = ""


@app.post("/api/confirm/{session_id}")
async def confirm_and_research(session_id: str, fields: ConfirmedFields):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found. Please start a new scan.")

    prompt = RESEARCH_PROMPT_TEMPLATE.format(
        producer=fields.producer or "Unknown",
        vintage=fields.vintage or "NV",
        variety=fields.variety or "Unknown",
        appellation=fields.appellation or "Unknown",
        country=fields.country or "Unknown",
    )

    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=600,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI wine research failed: {exc}")

    raw = response.choices[0].message.content
    try:
        researched = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned malformed JSON during research.")

    try:
        append_to_sheet(fields.model_dump(), researched)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to write to Google Sheets: {exc}")

    del sessions[session_id]

    return {
        "producer": fields.producer,
        "vintage": fields.vintage,
        "variety": fields.variety,
        "appellation": fields.appellation,
        "country": fields.country,
        "tasting_notes": researched.get("tasting_notes", ""),
        "aromas": researched.get("aromas", ""),
        "price": researched.get("price", ""),
        "rating": researched.get("rating", ""),
    }


# Serve frontend — must be last so API routes take priority
app.mount("/", StaticFiles(directory="static", html=True), name="static")
