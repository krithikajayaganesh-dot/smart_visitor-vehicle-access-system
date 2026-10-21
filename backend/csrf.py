import secrets
from fastapi import Request, Response, HTTPException, APIRouter
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

class CSRFMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Only protect mutating methods
        if request.method in ["POST", "PUT", "DELETE", "PATCH"]:
            # If the request has an X-API-Key or Authorization header or is high-frequency ANPR frame detection
            if "X-API-Key" in request.headers or "Authorization" in request.headers or request.url.path.startswith("/api/anpr/detect-frame"):
                return await call_next(request)

            # Get tokens
            cookie_token = request.cookies.get("XSRF-TOKEN")
            header_token = request.headers.get("X-XSRF-TOKEN")

            if not cookie_token or not header_token or cookie_token != header_token:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "CSRF token missing or invalid"}
                )

        response = await call_next(request)
        return response

router = APIRouter()

@router.get("/api/csrf-token")
async def get_csrf_token(response: Response):
    """Provide a CSRF token for the frontend to use."""
    token = secrets.token_urlsafe(32)
    response.set_cookie(
        key="XSRF-TOKEN",
        value=token,
        httponly=False,  # Must be readable by frontend JS
        samesite="lax",
        secure=False,  # Set to True in production (HTTPS)
        max_age=3600 * 24
    )
    return {"message": "CSRF cookie set"}
