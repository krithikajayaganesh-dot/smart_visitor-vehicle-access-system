from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from database import engine, Base, SessionLocal
from models import User, UserRole
from auth import hash_password
from config import BASE_DIR, CORS_ORIGINS, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, QR_CODES_DIR
from routes.auth import router as auth_router
from routes.admin import router as admin_router
from routes.qr import router as qr_router
from routes.api_keys import router as api_keys_router
from routes.anpr import router as anpr_router
from csrf import CSRFMiddleware, router as csrf_router

# ─── Create App ───
app = FastAPI(
    title="Visitor Vehicle Access System",
    description="Backend API for smart visitor vehicle access with QR codes and ANPR",
    version="2.1.0",
)


# ─── Security Middleware ───
app.add_middleware(CSRFMiddleware)

# ─── CORS Middleware ───
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Static Files (QR code images & Test Suite Dashboard) ───
app.mount("/qr_codes", StaticFiles(directory=str(QR_CODES_DIR)), name="qr_codes")
app.mount("/tests", StaticFiles(directory=str(BASE_DIR.parent / "tests"), html=True), name="tests")

# ─── Register Routers ───
app.include_router(csrf_router)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(qr_router)
app.include_router(api_keys_router)
app.include_router(anpr_router)


# ─── Startup Event ───
@app.on_event("startup")
def on_startup():
    """Create all tables and seed the default admin user."""
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        existing_admin = db.query(User).filter(User.username == DEFAULT_ADMIN_USERNAME).first()
        if not existing_admin:
            admin = User(
                username=DEFAULT_ADMIN_USERNAME,
                email="admin@vvas.local",
                hashed_password=hash_password(DEFAULT_ADMIN_PASSWORD),
                full_name="System Administrator",
                role=UserRole.admin,
            )
            db.add(admin)
            db.commit()
            print(f"✅ Default admin created: {DEFAULT_ADMIN_USERNAME} / {DEFAULT_ADMIN_PASSWORD}")
        else:
            print("ℹ️  Admin user already exists, skipping seed.")
    finally:
        db.close()


# ─── Health Check ───
@app.get("/")
def health_check():
    return {"status": "ok", "app": "Visitor Vehicle Access System"}
