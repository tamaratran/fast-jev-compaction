#!/usr/bin/env python3
"""
Laya Local HTTP API Server
Emulates the TypeSafe Jev systemone API endpoint (`POST /v1/systemone`)
using the local open-source `laya` decision engine (NandhaKishorM/laya).
"""

import argparse
import json
import logging
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("laya_server")

# Global router instance
router = None

class LayaRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.info("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), format % args))

    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/health", "/v1/health"):
            self._send_json(200, {"status": "ok", "engine": "laya"})
        else:
            self._send_json(404, {"error": "Not Found"})

    def do_POST(self):
        if self.path in ("/v1/systemone", "/v1/systemone/", "/predict"):
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._send_json(400, {"error": "Empty request body"})
                return

            req_body = self.rfile.read(content_length)
            try:
                payload = json.loads(req_body.decode("utf-8"))
            except Exception as e:
                self._send_json(400, {"error": f"Invalid JSON: {str(e)}"})
                return

            state = payload.get("state")
            questions = payload.get("questions")
            model_override = payload.get("model")

            if state is None or questions is None:
                self._send_json(400, {"error": "Missing 'state' or 'questions' in request payload"})
                return

            try:
                # Predict using laya router or mock if fallback
                if router is not None:
                    kwargs = {}
                    if model_override and model_override not in ("jev-latest", "laya-latest", "default"):
                        kwargs["model"] = model_override
                    
                    res = router.predict(state, questions, **kwargs)
                    answers = res.get("answers", {})
                    routing = res.get("routing", {})
                    
                    response_payload = {
                        "model": res.get("model", "laya-router"),
                        "answers": answers,
                        "routing": routing
                    }
                else:
                    # Fallback / mock mode when laya package is not installed (for dev/test)
                    response_payload = mock_predict(state, questions)

                self._send_json(200, response_payload)
            except Exception as e:
                logger.error("Error during prediction: %s", str(e), exc_info=True)
                self._send_json(500, {"error": f"Prediction failed: {str(e)}"})
        else:
            self._send_json(404, {"error": "Endpoint not found"})


def mock_predict(state, questions):
    """Mock prediction for environment without torch/laya installed (for quick API contract tests)."""
    answers = {}
    for q_name, q_def in questions.items():
        q_type = q_def.get("type", "noul")
        if q_type == "noul":
            # Default mock noul probability
            answers[q_name] = {"type": "noul", "noul": 0.75}
        elif q_type == "choice":
            criteria = q_def.get("criteria", {})
            keys = list(criteria.keys())
            first_key = keys[0] if keys else "default"
            answers[q_name] = {
                "type": "choice",
                "choice": first_key,
                "confidence": 0.90,
                "probabilities": {k: (0.90 if k == first_key else 0.10 / max(1, len(keys)-1)) for k in keys}
            }
        elif q_type == "score":
            answers[q_name] = {
                "type": "score",
                "score": 1.0,
                "confidence": 0.85,
                "probabilities": {"0": 0.15, "1": 0.85}
            }
    return {
        "model": "laya-mock",
        "answers": answers,
        "routing": {"model": "mock", "reason": "Laya package not loaded"}
    }


def init_laya(preload=True, device=None, mock=False):
    global router
    if mock:
        logger.info("Running in mock mode (laya model disabled).")
        return

    try:
        import laya
        from laya import Router
        logger.info("Initializing Laya Router (preload=%s, device=%s)...", preload, device)
        router_kwargs = {"preload": preload}
        if device:
            router_kwargs["device"] = device
        router = Router(**router_kwargs)
        logger.info("Laya Router successfully initialized.")
    except ImportError as e:
        logger.warning("Could not import laya (%s). Falling back to mock prediction mode.", e)
        router = None


def main():
    parser = argparse.ArgumentParser(description="Laya Local HTTP API Server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LAYA_SERVER_PORT", "8000")), help="Port to listen on (default: 8000)")
    parser.add_argument("--host", type=str, default=os.environ.get("LAYA_SERVER_HOST", "0.0.0.0"), help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--no-preload", action="store_true", help="Disable preloading of laya checkpoints")
    parser.add_argument("--device", type=str, default=None, help="Device to use (e.g. cpu, cuda, mps)")
    parser.add_argument("--mock", action="store_true", help="Run with mock predictor without loading PyTorch weights")

    args = parser.parse_args()

    init_laya(preload=not args.no_preload, device=args.device, mock=args.mock)

    server_address = (args.host, args.port)
    httpd = HTTPServer(server_address, LayaRequestHandler)
    logger.info("Starting Laya Local Server on http://%s:%d/v1/systemone", args.host, args.port)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    main()
