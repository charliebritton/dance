FROM python:3.13-slim
ENV TZ=Europe/London PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY frontend frontend
RUN useradd -u 1000 -m dance && mkdir -p /app/data && chown -R dance /app/data
USER dance
WORKDIR /app/backend
EXPOSE 8031
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8031", "--proxy-headers", "--forwarded-allow-ips", "*"]
