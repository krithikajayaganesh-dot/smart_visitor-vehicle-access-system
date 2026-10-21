import os
import sys
import re
import cv2
import time
import torch
import base64
import logging
import numpy as np
from pathlib import Path
from typing import Optional, Dict, Any, Tuple, List

logger = logging.getLogger("anpr_service")
logger.setLevel(logging.INFO)

# Setup paths to Indian_LPR dependencies
BASE_DIR = Path(__file__).resolve().parent.parent
INDIAN_LPR_DIR = BASE_DIR / "temp" / "Indian_LPR"

if str(INDIAN_LPR_DIR) not in sys.path:
    sys.path.append(str(INDIAN_LPR_DIR))

# Character vocabulary for LPRNet
CHARS = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
    'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
    'U', 'V', 'W', 'X', 'Y', 'Z', '-'
]

INDIAN_STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CH", "CG", "DD", "DL", "DN",
    "GA", "GJ", "HR", "HP", "JH", "JK", "KA", "KL", "LA", "LD",
    "MP", "MH", "MN", "ML", "MZ", "NL", "OD", "PB", "PY", "RJ",
    "SK", "TN", "TS", "TR", "UP", "UK", "UA", "WB", "BH"
}

def clean_plate_text(raw_text: str) -> str:
    """Cleans and standardizes raw license plate text."""
    if not raw_text:
        return ""
    # Remove hyphens, spaces, and punctuation
    cleaned = re.sub(r"[^A-Z0-9]", "", raw_text.upper())
    
    # Common OCR correction rules for Indian plates (State code first 2 letters)
    if len(cleaned) >= 2:
        prefix = list(cleaned[:2])
        # First two characters must be letters (State code)
        digit_to_char = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B'}
        for i in range(2):
            if prefix[i] in digit_to_char:
                prefix[i] = digit_to_char[prefix[i]]
        cleaned = "".join(prefix) + cleaned[2:]
        
    return cleaned

class ANPRService:
    _instance = None

    def __init__(self):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.fcos_model = None
        self.lprnet_model = None
        self.initialized = False
        self._load_models()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = ANPRService()
        return cls._instance

    def _load_models(self):
        """Loads pretrained FCOS and LPRNet weights."""
        try:
            from src.object_detection.model.fcos import FCOSDetector
            from src.object_detection.model.config import DefaultConfig
            from src.License_Plate_Recognition.model.LPRNet import build_lprnet

            od_weights = INDIAN_LPR_DIR / "weights" / "best_od.pth"
            lpr_weights = INDIAN_LPR_DIR / "weights" / "best_lprnet.pth"

            if not od_weights.exists() or not lpr_weights.exists():
                logger.warning("Model weights not found at expected location.")
                return

            # 1. Load FCOS Detector
            logger.info("Loading FCOS Detector...")
            self.fcos_model = FCOSDetector(mode="inference", config=DefaultConfig).eval().to(self.device)
            self.fcos_model.load_state_dict(
                torch.load(str(od_weights), map_location=self.device)
            )

            # 2. Load LPRNet Recognizer
            logger.info("Loading LPRNet Recognizer...")
            self.lprnet_model = build_lprnet(lpr_max_len=16, class_num=37).eval().to(self.device)
            self.lprnet_model.load_state_dict(
                torch.load(str(lpr_weights), map_location=self.device)
            )

            self.initialized = True
            logger.info(f"ANPR models successfully loaded on device: {self.device}")

        except Exception as e:
            logger.error(f"Error loading ANPR models: {e}", exc_info=True)
            self.initialized = False

    def decode_lprnet(self, imgs: torch.Tensor) -> List[Tuple[str, float]]:
        """Greedy CTC decoder for LPRNet output with confidence estimation."""
        if self.device.type == "cuda":
            imgs = imgs.cuda()

        with torch.no_grad():
            prebs = self.lprnet_model(imgs)  # [batch, classes, seq_len]
            # Softmax along class dimension for confidence scores
            probs = torch.softmax(prebs, dim=1).cpu().numpy()
            prebs = prebs.cpu().detach().numpy()

        results = []
        for i in range(prebs.shape[0]):
            preb = prebs[i, :, :]
            prob = probs[i, :, :]
            
            preb_label = [int(np.argmax(preb[:, j])) for j in range(preb.shape[1])]
            confidences = [float(prob[preb_label[j], j]) for j in range(preb.shape[1])]
            
            no_repeat_chars = []
            char_confs = []
            pre_c = preb_label[0]
            blank_idx = len(CHARS) - 1

            if pre_c != blank_idx:
                no_repeat_chars.append(pre_c)
                char_confs.append(confidences[0])

            for j in range(len(preb_label)):
                c = preb_label[j]
                if (pre_c == c) or (c == blank_idx):
                    if c == blank_idx:
                        pre_c = c
                    continue
                no_repeat_chars.append(c)
                char_confs.append(confidences[j])
                pre_c = c

            plate_str = "".join([CHARS[idx] for idx in no_repeat_chars])
            avg_conf = float(np.mean(char_confs)) if char_confs else 0.5
            results.append((clean_plate_text(plate_str), avg_conf))

        return results

    def detect_contours(self, img: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
        """Fast geometric edge & contour plate localization fallback."""
        try:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            gray = cv2.bilateralFilter(gray, 11, 17, 17)
            edges = cv2.Canny(gray, 30, 200)
            contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            contours = sorted(contours, key=cv2.contourArea, reverse=True)[:25]

            h_img, w_img = img.shape[:2]
            for contour in contours:
                peri = cv2.arcLength(contour, True)
                approx = cv2.approxPolyDP(contour, 0.018 * peri, True)
                if len(approx) == 4:
                    x, y, w, h = cv2.boundingRect(approx)
                    aspect_ratio = w / float(h)
                    if 1.8 <= aspect_ratio <= 5.8 and w > (w_img * 0.12) and h > (h_img * 0.03):
                        x1 = max(0, x - 4)
                        y1 = max(0, y - 4)
                        x2 = min(w_img, x + w + 4)
                        y2 = min(h_img, y + h + 4)
                        return (x1, y1, x2, y2)
        except Exception:
            pass
        return None

    def detect_plate(self, img: np.ndarray) -> Dict[str, Any]:
        """
        Runs the full ANPR pipeline on a BGR image frame.
        Returns detection bbox, plate number, confidence, and preview crop.
        """
        start_time = time.time()
        result = {
            "detected": False,
            "plate_number": "",
            "confidence": 0.0,
            "bbox": None,
            "crop_base64": None,
            "inference_time_ms": 0.0,
            "method": "none"
        }

        if img is None or img.size == 0:
            return result

        h_orig, w_orig = img.shape[:2]
        boxes = []

        # 1. Deep FCOS Detector
        if self.initialized and self.fcos_model is not None:
            try:
                from src.object_detection.utils.utils import preprocess_image as od_preprocess
                img_tensor = od_preprocess(img).to(self.device)
                with torch.no_grad():
                    out = self.fcos_model(img_tensor)
                    # out[2][0] contains detected bounding boxes
                    raw_boxes = out[2][0].cpu().numpy().tolist()
                    boxes = [
                        [int(b[0]), int(b[1]), int(b[2]), int(b[3])]
                        for b in raw_boxes
                    ]
            except Exception as e:
                logger.error(f"FCOS inference error: {e}")

        # 2. Geometric Contour Fallback if FCOS found nothing
        method = "FCOS"
        if not boxes:
            c_box = self.detect_contours(img)
            if c_box:
                boxes = [list(c_box)]
                method = "Contour"

        if not boxes:
            result["inference_time_ms"] = round((time.time() - start_time) * 1000, 1)
            return result

        # Select highest priority bounding box
        b = boxes[0]
        # Pad box slightly for better OCR boundary capture
        pad_w = int((b[2] - b[0]) * 0.05)
        pad_h = int((b[3] - b[1]) * 0.05)
        x1 = max(0, b[0] - pad_w)
        y1 = max(0, b[1] - pad_h)
        x2 = min(w_orig, b[2] + pad_w)
        y2 = min(h_orig, b[3] + pad_h)

        crop = img[y1:y2, x1:x2]
        if crop.size == 0 or (x2 - x1 < 20) or (y2 - y1 < 10):
            result["inference_time_ms"] = round((time.time() - start_time) * 1000, 1)
            return result

        # 3. LPRNet Character Recognition
        plate_text = ""
        confidence = 0.0

        if self.initialized and self.lprnet_model is not None:
            try:
                im_lpr = cv2.resize(crop, (94, 24)).astype("float32")
                im_lpr = (im_lpr - 127.5) * 0.0078125
                im_lpr = torch.from_numpy(im_lpr.transpose((2, 0, 1))).unsqueeze(0).to(self.device)
                decoded_plates = self.decode_lprnet(im_lpr)
                if decoded_plates:
                    plate_text, confidence = decoded_plates[0]
            except Exception as e:
                logger.error(f"LPRNet inference error: {e}")

        # If plate text is detected
        if plate_text:
            # Generate small base64 preview of cropped plate
            _, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
            crop_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode("utf-8")

            result.update({
                "detected": True,
                "plate_number": plate_text,
                "confidence": round(confidence, 3),
                "bbox": {
                    "x1": int(x1),
                    "y1": int(y1),
                    "x2": int(x2),
                    "y2": int(y2),
                    "width": int(x2 - x1),
                    "height": int(y2 - y1),
                    "img_width": int(w_orig),
                    "img_height": int(h_orig)
                },
                "crop_base64": crop_b64,
                "method": method
            })

        result["inference_time_ms"] = round((time.time() - start_time) * 1000, 1)
        return result

# Global singleton helper
def get_anpr_service() -> ANPRService:
    return ANPRService.get_instance()
