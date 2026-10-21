import os
import re
import cv2
import base64
import numpy as np
from datetime import datetime, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import User, VisitorPass, AccessLog, PassStatus, LogAction
from auth import get_current_user, require_role
from config import BASE_DIR, QR_CODES_DIR
from anpr_service import get_anpr_service
from routes.qr import generate_qr_code_file

router = APIRouter(prefix="/api/anpr", tags=["ANPR"])

SAMPLE_IMAGES_DIR = BASE_DIR.parent / "temp" / "Indian-Number-Plate-Recognition-master" / "inputs"

# ─── Pydantic Schemas ───
class FrameDetectRequest(BaseModel):
    image: str  # Base64 encoded JPEG/PNG frame
    auto_check_pass: bool = True

class QuickLogRequest(BaseModel):
    action: str  # "entry" or "exit"
    plate_number: str
    pass_id: Optional[int] = None
    visitor_name: Optional[str] = None
    flat_number: Optional[str] = None
    purpose: Optional[str] = "Live ANPR Camera Recognition"

def base64_to_cv2(b64_str: str) -> Optional[np.ndarray]:
    """Decodes a base64 data URI or raw base64 string to OpenCV BGR image."""
    try:
        if "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None

def normalize_plate(plate: str) -> str:
    """Removes non-alphanumeric characters for clean comparison."""
    return re.sub(r"[^A-Z0-9]", "", (plate or "").upper())

@router.get("/status")
def get_anpr_status():
    """Returns AI model loading status and hardware engine metadata."""
    svc = get_anpr_service()
    return {
        "status": "online" if svc.initialized else "degraded",
        "initialized": svc.initialized,
        "device": str(svc.device),
        "detector": "FCOS (Deep HRNet)",
        "recognizer": "LPRNet (Greedy CTC)",
        "fallback": "Contour Edge Analysis"
    }

@router.post("/detect-frame")
def detect_frame(
    payload: FrameDetectRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("guard", "admin")),
):
    """
    Receives a webcam frame, runs real-time ANPR detection,
    and searches for matching resident visitor passes in the database.
    """
    img = base64_to_cv2(payload.image)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image frame encoding")

    svc = get_anpr_service()
    detection = svc.detect_plate(img)

    matched_pass_data = None
    recommendation = "none"

    if detection["detected"]:
        raw_plate = detection["plate_number"]
        norm_plate = normalize_plate(raw_plate)

        # Search for active/recent visitor passes matching this vehicle plate
        all_recent_passes = (
            db.query(VisitorPass)
            .filter(VisitorPass.vehicle_number.isnot(None))
            .order_by(VisitorPass.created_at.desc())
            .limit(100)
            .all()
        )

        matched_pass = None
        for p in all_recent_passes:
            if normalize_plate(p.vehicle_number) == norm_plate:
                matched_pass = p
                break

        if matched_pass:
            # Check expiry
            is_expired = datetime.utcnow() > matched_pass.expires_at
            if is_expired:
                status_str = "expired"
                rec = "expired"
            else:
                status_str = matched_pass.status.value if hasattr(matched_pass.status, 'value') else str(matched_pass.status)
                if status_str in ["not_inside", "approved", "pending"]:
                    rec = "entry"
                elif status_str in ["in_campus", "used"]:
                    rec = "exit"
                elif status_str == "exited":
                    rec = "already_exited"
                else:
                    rec = "unknown"

            host_flat = matched_pass.resident.flat_number if matched_pass.resident else "—"
            host_name = matched_pass.resident.full_name if matched_pass.resident else "Host Resident"

            matched_pass_data = {
                "id": matched_pass.id,
                "visitor_name": matched_pass.visitor_name,
                "vehicle_number": matched_pass.vehicle_number,
                "purpose": matched_pass.purpose,
                "status": status_str,
                "host_flat": host_flat,
                "host_name": host_name,
                "expires_at": matched_pass.expires_at.isoformat(),
                "qr_token": matched_pass.qr_token,
            }
            recommendation = rec
        else:
            recommendation = "unregistered"

    return {
        "success": True,
        "detection": detection,
        "matched_pass": matched_pass_data,
        "recommendation": recommendation,
    }

@router.post("/quick-log")
def quick_log_access(
    data: QuickLogRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("guard", "admin")),
):
    """
    1-Click Gate Entry or Exit logging directly from ANPR detection.
    Transitions an existing visitor pass or logs a walk-in entry.
    """
    action = data.action.lower()
    if action not in ["entry", "exit"]:
        raise HTTPException(status_code=400, detail="Action must be 'entry' or 'exit'")

    visitor_pass = None
    if data.pass_id:
        visitor_pass = db.query(VisitorPass).filter(VisitorPass.id == data.pass_id).first()

    # If pass exists, transition status
    if visitor_pass:
        # Check expiry
        if datetime.utcnow() > visitor_pass.expires_at:
            visitor_pass.status = PassStatus.expired
            db.commit()
            return {
                "success": False,
                "message": f"❌ Pass Expired: Cannot log {action.upper()} for expired pass.",
                "pass_status": "expired"
            }

        # Validate lifecycle state transitions
        if action == "entry":
            if visitor_pass.status in [PassStatus.in_campus, PassStatus.used]:
                return {
                    "success": False,
                    "message": "⚠️ Entry Warning: Vehicle is ALREADY logged as inside campus.",
                    "pass_status": "in_campus"
                }
            visitor_pass.status = PassStatus.in_campus

        elif action == "exit":
            if visitor_pass.status in [PassStatus.not_inside, PassStatus.approved, PassStatus.pending]:
                return {
                    "success": False,
                    "message": "⚠️ Exit Warning: Vehicle has not entered yet.",
                    "pass_status": "not_inside"
                }
            if visitor_pass.status == PassStatus.exited:
                return {
                    "success": False,
                    "message": "⚠️ Exit Warning: Vehicle has ALREADY exited the campus.",
                    "pass_status": "exited"
                }
            visitor_pass.status = PassStatus.exited

        # Record Access Log
        log = AccessLog(
            visitor_pass_id=visitor_pass.id,
            scanned_by=current_user.id,
            action=LogAction.entry if action == "entry" else LogAction.exit,
        )
        db.add(log)
        db.commit()
        db.refresh(visitor_pass)

        return {
            "success": True,
            "message": f"✅ Vehicle {action.upper()} successfully recorded for {visitor_pass.visitor_name} ({visitor_pass.vehicle_number})",
            "pass_id": visitor_pass.id,
            "vehicle_number": visitor_pass.vehicle_number,
            "pass_status": visitor_pass.status.value,
        }

    else:
        # Walk-in vehicle: Auto-create registration
        host_user_id = current_user.id
        if data.flat_number:
            host_user = db.query(User).filter(User.flat_number == data.flat_number).first()
            if host_user:
                host_user_id = host_user.id

        new_pass = VisitorPass(
            visitor_name=data.visitor_name or f"Visitor ({data.plate_number.upper()})",
            vehicle_number=data.plate_number.upper(),
            purpose=data.purpose or "ANPR Automated Gate Access",
            resident_id=host_user_id,
            status=PassStatus.in_campus if action == "entry" else PassStatus.exited,
            expires_at=datetime.utcnow() + timedelta(hours=24),
        )
        db.add(new_pass)
        db.commit()
        db.refresh(new_pass)

        # Generate QR code
        new_pass.qr_image_path = generate_qr_code_file(new_pass.qr_token)
        db.commit()

        # Add Access Log
        log = AccessLog(
            visitor_pass_id=new_pass.id,
            scanned_by=current_user.id,
            action=LogAction.entry if action == "entry" else LogAction.exit,
        )
        db.add(log)
        db.commit()
        db.refresh(new_pass)

        return {
            "success": True,
            "message": f"✅ Walk-in Vehicle {data.plate_number.upper()} {action.upper()} logged successfully",
            "pass_id": new_pass.id,
            "vehicle_number": new_pass.vehicle_number,
            "pass_status": new_pass.status.value,
        }

@router.get("/samples")
def get_sample_images():
    """
    Returns available test vehicle images stored in the repository
    encoded as base64 so users can test ANPR detection with 1-click.
    """
    samples = []
    if SAMPLE_IMAGES_DIR.exists():
        for filename in sorted(os.listdir(SAMPLE_IMAGES_DIR)):
            if filename.lower().endswith((".jpg", ".jpeg", ".png")):
                path = SAMPLE_IMAGES_DIR / filename
                try:
                    with open(path, "rb") as f:
                        b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")
                        samples.append({
                            "name": filename,
                            "label": f"Test Vehicle {filename}",
                            "image": b64
                        })
                except Exception:
                    pass
    return {"samples": samples}
