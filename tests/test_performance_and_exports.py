"""Unit tests for performance tuning, disk cleanup, export formats, and DB state sync."""

import io
import csv
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure project root is in sys.path
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import main
from backend import database as db
from backend import ocr_engine as eng

class TestPerformanceAndExports(unittest.TestCase):

    def setUp(self):
        db.init_db()

    def test_clean_job_files(self):
        job_id = "test-clean-uuid-9999"
        dummy_upload = main.UPLOAD_DIR / f"{job_id}.png"
        dummy_result = main.RESULT_DIR / f"{job_id}.json"

        dummy_upload.write_bytes(b"dummy image data")
        dummy_result.write_text('{"status": "done"}', encoding="utf-8")

        self.assertTrue(dummy_upload.exists())
        self.assertTrue(dummy_result.exists())

        main._clean_job_files(job_id)

        self.assertFalse(dummy_upload.exists())
        self.assertFalse(dummy_result.exists())

    def test_db_job_state_synchronization(self):
        job_id = "test-sync-job-8888"
        db.save_job_queued(job_id, "test_file.png", "all")

        row = db.get_job(job_id)
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "queued")

        # Test transitioning to processing
        db.save_job_processing(job_id)
        row = db.get_job(job_id)
        self.assertEqual(row["status"], "processing")

        # Test transitioning to error
        db.save_job_error(job_id, "Simulated worker timeout")
        row = db.get_job(job_id)
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error_message"], "Simulated worker timeout")

        # Cleanup
        db.delete_job(job_id)

    def test_shift_jis_csv_export(self):
        # Create a mock job result
        job_id = "test-export-job-7777"
        main.jobs[job_id] = {
            "status": "done",
            "result": {
                "filename": "注文書_test.pdf",
                "tables": [{
                    "data": [
                        {"商品名": "有機玉ねぎ", "数量": 10, "単価": 250},
                        {"商品名": "有機人参", "数量": 5, "単価": 180},
                    ]
                }]
            }
        }

        req = MagicMock()
        req.client.host = "127.0.0.1"

        # Export in Shift_JIS CSV
        resp = main.export_job_result(req, job_id=job_id, format="csv", encoding="shift_jis")
        # Since export_job_result is async, we can call it directly in asyncio or test logic
        import asyncio
        loop = asyncio.get_event_loop()
        res = loop.run_until_complete(resp)

        self.assertEqual(res.status_code, 200)
        self.assertIn("text/csv; charset=cp932", res.headers.get("content-type", ""))
        self.assertIn("attachment", res.headers.get("content-disposition", ""))

        # Verify decoded bytes with CP932 / Shift_JIS
        decoded_text = res.body.decode("cp932")
        self.assertIn("商品名", decoded_text)
        self.assertIn("有機玉ねぎ", decoded_text)

        # Cleanup
        main.jobs.pop(job_id, None)

    def test_database_connection_ping(self):
        # Verify _get_connection automatically pings without raising
        with db._get_connection() as con:
            cur = con.cursor()
            cur.execute("SELECT 1")
            val = cur.fetchone()[0]
            cur.close()
            self.assertEqual(val, 1)


if __name__ == "__main__":
    unittest.main()
