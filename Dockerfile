FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ .

# Expose the app port
EXPOSE 9006

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9006"]
