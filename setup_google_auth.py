"""
Run this once on your local machine to get a refresh token for Google Sheets.

Usage:
    pip install google-auth-oauthlib
    python setup_google_auth.py

You will be asked for your Client ID and Client Secret from Google Cloud Console,
then a browser window will open for you to authorise access.
The script prints the three values to add to your .env file.
"""

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

client_id     = input("Paste your Google OAuth Client ID:     ").strip()
client_secret = input("Paste your Google OAuth Client Secret: ").strip()

client_config = {
    "installed": {
        "client_id": client_id,
        "client_secret": client_secret,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"],
    }
}

flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
creds = flow.run_local_server(port=0)

print("\n✅  Add these three lines to your .env file on the NAS:\n")
print(f"GOOGLE_CLIENT_ID={client_id}")
print(f"GOOGLE_CLIENT_SECRET={client_secret}")
print(f"GOOGLE_REFRESH_TOKEN={creds.refresh_token}")
