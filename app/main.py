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
from google.oauth2.service_account import Credentials

load_dotenv()

app = FastAPI(title="Cellar Ledger")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GOOGLE_SHEET_ID = os.getenv("GOOGLE_SHEET_ID")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL")
GOOGLE_PRIVATE_KEY_ID = os.getenv("GOOGLE_PRIVATE_KEY_ID")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "").replace("\\n", "\n")

openai_client = OpenAI(api_key=OPENAI_API_KEY)

sessions: dict = {}

MAX_IMAGE_PX = 1024

# Sheet column positions (0-indexed)
COL_PRODUCER     = 0
COL_VINTAGE      = 1
COL_VARIETY      = 2
COL_APPELLATION  = 3
COL_COUNTRY      = 4
COL_TASTING      = 5
COL_AROMAS       = 6
COL_PRICE        = 7
COL_AI_RATING    = 8
COL_DRUNK        = 9
COL_MY_RATING    = 10

HEADERS = [
    "Brand", "Vintage", "Variety", "Appellation", "Country",
    "Tasting Notes", "Aromas", "Price", "AI Rating", "Drunk", "My Rating"
]

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


def get_sheet():
    creds = Credentials.from_service_account_info(
        {
            "type": "service_account",
            "client_email": GOOGLE_SERVICE_ACCOUNT_EMAIL,
            "private_key_id": GOOGLE_PRIVATE_KEY_ID,
            "private_key": GOOGLE_PRIVATE_KEY,
            "token_uri": "https://oauth2.googleapis.com/token",
        },
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(GOOGLE_SHEET_ID)
    return sh.sheet1


def ensure_headers(ws) -> None:
    """Add header row if the sheet is empty."""
    if ws.row_count == 0 or not ws.row_values(1):
        ws.insert_row(HEADERS, 1)


def resize_and_encode(image_bytes: bytes) -> tuple[str, str]:
    img = Image.open(io.BytesIO(image_bytes))
    img.thumbnail((MAX_IMAGE_PX, MAX_IMAGE_PX), Image.LANCZOS)
    output = io.BytesIO()
    save_format = "JPEG" if img.mode in ("RGB", "L") else "PNG"
    if img.mode == "RGBA":
        img = img.convert("RGB")
        save_format = "JPEG"
    img.save(output, format=save_format)
    output.seek(0)
    b64 = base64.b64encode(output.read()).decode("utf-8")
    mime = "image/jpeg" if save_format == "JPEG" else "image/png"
    return b64, mime


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
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                    ],
                }
            ],
            max_tokens=300,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI label extraction failed: {exc}")

    try:
        extracted = json.loads(response.choices[0].message.content)
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

    try:
        researched = json.loads(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned malformed JSON during research.")

    try:
        ws = get_sheet()
        ensure_headers(ws)
        ws.append_row([
            fields.producer,
            fields.vintage or "",
            fields.variety or "",
            fields.appellation or "",
            fields.country or "",
            researched.get("tasting_notes", ""),
            researched.get("aromas", ""),
            researched.get("price", ""),
            researched.get("rating", ""),
            "",   # Drunk — empty until user sets it
            "",   # My Rating — empty until user sets it
        ])
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


@app.get("/api/cellar")
async def get_cellar():
    try:
        ws = get_sheet()
        all_rows = ws.get_all_values()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to read Google Sheets: {exc}")

    if not all_rows:
        return {"wines": []}

    # Skip header row if present
    data_rows = all_rows[1:] if all_rows[0][0].lower() in ("brand", "producer") else all_rows

    def cell(row, idx):
        return row[idx] if idx < len(row) else ""

    wines = []
    for sheet_row_index, row in enumerate(data_rows, start=2):  # 1-indexed, row 1 = header
        if not any(row):
            continue
        wines.append({
            "row": sheet_row_index,
            "producer":     cell(row, COL_PRODUCER),
            "vintage":      cell(row, COL_VINTAGE),
            "variety":      cell(row, COL_VARIETY),
            "appellation":  cell(row, COL_APPELLATION),
            "country":      cell(row, COL_COUNTRY),
            "tasting_notes": cell(row, COL_TASTING),
            "aromas":       cell(row, COL_AROMAS),
            "price":        cell(row, COL_PRICE),
            "rating":       cell(row, COL_AI_RATING),
            "drunk":        cell(row, COL_DRUNK),
            "my_rating":    cell(row, COL_MY_RATING),
        })

    return {"wines": wines}


class CellarUpdate(BaseModel):
    drunk: str = ""
    my_rating: str = ""


@app.patch("/api/cellar/{row}")
async def update_cellar_entry(row: int, update: CellarUpdate):
    try:
        ws = get_sheet()
        # Columns are 1-indexed in gspread
        ws.update_cell(row, COL_DRUNK + 1, update.drunk)
        ws.update_cell(row, COL_MY_RATING + 1, update.my_rating)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to update Google Sheets: {exc}")

    return {"row": row, "drunk": update.drunk, "my_rating": update.my_rating}


# Serve frontend — must be last so API routes take priority
app.mount("/", StaticFiles(directory="static", html=True), name="static")
