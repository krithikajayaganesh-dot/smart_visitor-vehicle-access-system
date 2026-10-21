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

SAMPLE_IMAGES_DIR = BASE_DIR / "temp" / "Indian-Number-Plate-Recognition-master" / "inputs"

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

def _hamming(a: str, b: str) -> int:
    return sum(x != y for x, y in zip(a, b))


def match_pass_for_plate(db: Session, plate: str):
    """
    Find the visitor pass for a plate. Returns (pass_data | None, recommendation, match_type).
    match_type is "exact", or "near" when the plate differs by one character
    (a likely OCR slip), in which case the guard must verify by eye.
    """
    norm_plate = normalize_plate(plate)
    if not norm_plate:
        return None, "none", None

    recent = (
        db.query(VisitorPass)
        .filter(VisitorPass.vehicle_number.isnot(None))
        .order_by(VisitorPass.created_at.desc())
        .limit(100)
        .all()
    )

    matched, match_type = None, None
    for p in recent:
        if normalize_plate(p.vehicle_number) == norm_plate:
            matched, match_type = p, "exact"
            break
    if matched is None:
        near = [
            p for p in recent
            if len(normalize_plate(p.vehicle_number)) == len(norm_plate)
            and _hamming(normalize_plate(p.vehicle_number), norm_plate) == 1
        ]
        distinct = {normalize_plate(p.vehicle_number) for p in near}
        if len(distinct) == 1:  # only trust it when it is unambiguous
            matched, match_type = near[0], "near"

    if matched is None:
        return None, "unregistered", None

    if datetime.utcnow() > matched.expires_at:
        status_str, rec = "expired", "expired"
    else:
        status_str = matched.status.value if hasattr(matched.status, "value") else str(matched.status)
        if status_str in ["not_inside", "approved", "pending"]:
            rec = "entry"
        elif status_str in ["in_campus", "used"]:
            rec = "exit"
        elif status_str == "exited":
            rec = "already_exited"
        else:
            rec = "unknown"

    data = {
        "id": matched.id,
        "visitor_name": matched.visitor_name,
        "vehicle_number": matched.vehicle_number,
        "purpose": matched.purpose,
        "status": status_str,
        "host_flat": matched.resident.flat_number if matched.resident else "—",
        "host_name": matched.resident.full_name if matched.resident else "Host Resident",
        "expires_at": matched.expires_at.isoformat(),
        "qr_token": matched.qr_token,
        "match_type": match_type,
    }
    return data, rec, match_type


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

    detection = get_anpr_service().detect_plate(img)

    matched_pass_data, recommendation = None, "none"
    if detection["detected"]:
        matched_pass_data, recommendation, _ = match_pass_for_plate(db, detection["plate_number"])

    return {
        "success": True,
        "detection": detection,
        "matched_pass": matched_pass_data,
        "recommendation": recommendation,
    }


@router.get("/lookup")
def lookup_plate(
    plate: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("guard", "admin")),
):
    """Look up a (manually corrected) plate number against visitor passes."""
    data, rec, match_type = match_pass_for_plate(db, plate)
    return {"matched_pass": data, "recommendation": rec, "match_type": match_type}

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
