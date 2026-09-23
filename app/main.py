from fastapi import FastAPI

app = FastAPI(
    title="Smart Attendance API",
    description="Backend API for Smart Attendance System",
    version="1.0.0"
)


@app.get("/")
def root():
    return {
        "message": "Smart Attendance API is running"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }