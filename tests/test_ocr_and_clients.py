import sys
from pathlib import Path

# Add project root to path
ROOT = Path(__file__).resolve().parent.parent
if (ROOT / "backend").exists():
    sys.path.insert(0, str(ROOT))
elif (ROOT / "ocr-webapp" / "backend").exists():
    sys.path.insert(0, str(ROOT / "ocr-webapp"))

from backend import database as db
from backend import ocr_engine as eng

def test_deepseek_cpu_fallback():
    db.init_db()
    # Test DeepSeek-OCR running with docling_cache in CPU fallback mode
    cache = {"markdown": "# Test Invoice\n| Item | Qty |\n| Apple | 5 |", "text": "Test Invoice Apple 5"}
    res = eng._deepseek_ocr_image("", mode="markdown", docling_cache=cache)
    assert res.get("engine") == "DeepSeek-OCR"
    assert res.get("device") in ("cuda", "cpu")
    assert "Apple" in res.get("markdown", "")
    assert not res.get("error")
    print("test_deepseek_cpu_fallback: PASSED")

def test_client_detection_national():
    db.init_db()
    doc = {
        "fused_text": "出荷可能アイテム一覧（ご注文書）\nナショナル麻布株式会社 御中\nナショナル麻布 青果部 沖津様",
        "tables": [{
            "caption": "注文明細",
            "markdown": "| 品目 | 産地 | 栽培区分 | 規格・入数 | 単価/p | 単価/cs | JANコード | 備考・今週の産地状況 |",
            "data": [{"品目": "有機青じそ", "産地": "千葉"}]
        }]
    }
    match = db.detect_client_for_result(doc, filename="20260924_order.pdf")
    assert match is not None
    assert match["code"] == "national"
    assert match["match_score"] >= 200
    print(f"test_client_detection_national: PASSED (score={match['match_score']})")

def test_client_detection_chiba_santoku():
    db.init_db()
    doc = {
        "tables": [{
            "caption": "週間発注書",
            "markdown": "| 区分 | 産地 | 品目 | 単位 | （月） | （火） | （水） | （木） | （金） | （土） |",
            "data": [{"区分": "A", "品目": "トマト"}]
        }]
    }
    match = db.detect_client_for_result(doc, filename="chiba_santoku_order.xlsx")
    assert match is not None
    assert match["code"] == "chiba santoku"
    print(f"test_client_detection_chiba_santoku: PASSED (score={match['match_score']})")

def test_client_detection_fusui_project():
    db.init_db()
    doc = {
        "fused_text": "風水プロジェクト 御中\n商品コード\t商品名\t規格\t数量\t単価（円）\t金額（円）\n1029510171\t有機青じそ\t10枚\t5\t125\t625"
    }
    match = db.detect_client_for_result(doc, filename="scan001.png")
    assert match is not None
    assert match["code"] == "fusui_project"
    print(f"test_client_detection_fusui_project: PASSED (score={match['match_score']})")

if __name__ == "__main__":
    test_deepseek_cpu_fallback()
    test_client_detection_national()
    test_client_detection_chiba_santoku()
    test_client_detection_fusui_project()
    print("ALL 4 TESTS PASSED PERFECTLY!")
