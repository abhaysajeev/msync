FROM python:3.12-slim-bookworm

# ffmpeg for probing and packaging (no live transcoding ever happens)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

ENV DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8000
# one worker: the authoritative room state lives in this process
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
