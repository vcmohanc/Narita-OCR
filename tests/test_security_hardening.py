"""Automated security hardening test suite for ocr-webapp (using standard unittest)."""

import os
import sys
import tempfile
import time
import zipfile
import re
import unittest
from pathlib import Path
from unittest.mock import MagicMock
from fastapi import HTTPException

# Ensure project root is in sys.path
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import main


class TestSecurityHardening(unittest.TestCase):

    def test_magic_bytes_pdf(self):
        with tempfile.TemporaryDirectory() as td:
            pdf = Path(td) / "test.pdf"
            pdf.write_bytes(b"%PDF-1.7\n%fake-pdf-content")
            self.assertTrue(main._verify_magic_bytes(pdf, ".pdf"))

            fake_pdf = Path(td) / "fake.pdf"
            fake_pdf.write_bytes(b"NOT_A_PDF_HEADER")
            self.assertFalse(main._verify_magic_bytes(fake_pdf, ".pdf"))

    def test_magic_bytes_ooxml_zip(self):
        with tempfile.TemporaryDirectory() as td:
            # 1. Plain text with PK header (spoofed zip)
            fake_xlsx = Path(td) / "fake.xlsx"
            fake_xlsx.write_bytes(b"PK\x03\x04spoofed content that is not a zip")
            self.assertFalse(main._verify_magic_bytes(fake_xlsx, ".xlsx"))

            # 2. Real ZIP archive but without OOXML markers (arbitrary zip)
            arbitrary_zip = Path(td) / "arbitrary.xlsx"
            with zipfile.ZipFile(arbitrary_zip, "w") as zf:
                zf.writestr("malicious.sh", "echo 'pwned'")
            self.assertFalse(main._verify_magic_bytes(arbitrary_zip, ".xlsx"))

            # 3. Legitimate OOXML zip containing [Content_Types].xml
            valid_xlsx = Path(td) / "valid.xlsx"
            with zipfile.ZipFile(valid_xlsx, "w") as zf:
                zf.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
                zf.writestr("xl/workbook.xml", '<workbook/>')
            self.assertTrue(main._verify_magic_bytes(valid_xlsx, ".xlsx"))

            # 4. Legitimate OOXML zip containing xl/ worksheet
            valid_xlsm = Path(td) / "valid.xlsm"
            with zipfile.ZipFile(valid_xlsm, "w") as zf:
                zf.writestr("xl/worksheets/sheet1.xml", '<sheetData/>')
            self.assertTrue(main._verify_magic_bytes(valid_xlsm, ".xlsm"))

    def test_trusted_proxy_client_ip(self):
        req = MagicMock()
        req.client.host = "10.0.0.1"
        req.headers = {"X-Forwarded-For": "203.0.113.195, 10.0.0.1"}

        # Untrusted: should return remote host directly, ignoring spoofed X-Forwarded-For
        main.TRUSTED_PROXIES = {"127.0.0.1", "172.18.0.1"}
        self.assertEqual(main._client_ip(req), "10.0.0.1")

        # Trusted: should read client IP from X-Forwarded-For
        main.TRUSTED_PROXIES = {"10.0.0.1"}
        self.assertEqual(main._client_ip(req), "203.0.113.195")

    def test_rate_limiting_and_memory_cleanup(self):
        main._rate_buckets.clear()
        req = MagicMock()
        req.client.host = "192.168.1.100"
        req.headers = {}
        main.TRUSTED_PROXIES = set()

        # Should permit up to 5 requests
        for _ in range(5):
            main._check_rate_limit(req, "test_bucket", max_requests=5, window_s=60)

        # 6th request must raise HTTP 429
        with self.assertRaises(HTTPException) as ctx:
            main._check_rate_limit(req, "test_bucket", max_requests=5, window_s=60)
        self.assertEqual(ctx.exception.status_code, 429)

        # Add 100 dummy stale buckets and trigger cleanup
        now = time.monotonic()
        for i in range(100):
            main._rate_buckets[f"stale_bucket_{i}"] = main.deque([now - 400])
        self.assertGreater(len(main._rate_buckets), 100)

        main._cleanup_rate_buckets(now + 70)
        # Stale keys older than 300s should have been purged
        self.assertLessEqual(len(main._rate_buckets), 1)

    def test_api_key_auth(self):
        req = MagicMock()
        req.url.path = "/api/ocr/upload"
        req.client.host = "127.0.0.1"
        req.cookies = {}
        req.headers = {}

        # Mode 1: No API key set and no session -> 401 Authentication required
        main.OCR_API_KEY = ""
        main.REQUIRE_AUTH = False
        main.ENVIRONMENT = "development"
        with self.assertRaises(HTTPException) as ctx:
            main._require_api_key(req)
        self.assertEqual(ctx.exception.status_code, 401)

        # Mode 2: API key configured -> unauthenticated without key
        main.OCR_API_KEY = "super-secret-key-12345"
        req.headers = {}

        with self.assertRaises(HTTPException) as ctx:
            main._require_api_key(req)
        self.assertEqual(ctx.exception.status_code, 401)

        # Invalid header
        req.headers = {"X-API-Key": "wrong-key"}
        with self.assertRaises(HTTPException) as ctx:
            main._require_api_key(req)
        self.assertEqual(ctx.exception.status_code, 401)

        # Valid X-API-Key
        req.headers = {"X-API-Key": "super-secret-key-12345"}
        user = main._require_api_key(req)
        self.assertEqual(user["username"], "api-key")

        # Valid Bearer token
        req.headers = {"Authorization": "Bearer super-secret-key-12345"}
        user = main._require_api_key(req)
        self.assertEqual(user["username"], "api-key")

        # Reset
        main.OCR_API_KEY = ""
        main.REQUIRE_AUTH = False

    def test_job_id_regex_validation(self):
        pattern = re.compile(main.JOB_ID_REGEX)
        self.assertIsNotNone(pattern.match("550e8400-e29b-41d4-a716-446655440000"))
        self.assertIsNotNone(pattern.match("job_12345-abc"))
        # Directory traversal attempts must not match
        self.assertIsNone(pattern.match("../../etc/passwd"))
        self.assertIsNone(pattern.match("..\\windows\\system32"))
        self.assertIsNone(pattern.match("job;DROP TABLE ocr_jobs;"))
        self.assertIsNone(pattern.match("job\x00traversal"))


if __name__ == "__main__":
    unittest.main()
