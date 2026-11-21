"""ワルドデリカ weekly sheet: merged dates and blank quantities stay in the OCR rows."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import database as db
from backend import ocr_engine as eng


def _box(text, x, y, w=140, h=16):
    return {
        "text": text,
        "confidence": 0.99,
        "bbox": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
    }


def _sample_output():
    """Layout matches the scanned weekly grid: date band, then product lines."""
    lines = [
        # Header labels are centered in each column. "商品名" is spaced across the wide column.
        _box("商", 250, 20, 24),
        _box("品", 330, 20, 24),
        _box("名", 410, 20, 24),
        _box("数量", 560, 20, 40),
        _box("単位", 660, 20, 40),
        _box("備考", 820, 20, 40),
        _box("10/18", 30, 60, 50),
        _box("日曜日", 30, 78, 60),
        # Product name is left-aligned, so it starts left of the centered header.
        _box("有機サニーレタス15入", 150, 100, 200),
        _box("2", 565, 100, 20),
        _box("箱", 665, 100, 30),
        _box("10月19日", 780, 100, 70),
        _box("デリカフーズ着", 870, 100, 110),
        _box("10/19", 30, 150, 50),
        _box("月曜日", 30, 168, 60),
        _box("群馬県産有機カリーノケール5入", 150, 190, 240),
        _box("20", 565, 190, 30),
        _box("箱", 665, 190, 30),
        _box("山武", 820, 190, 40),
        _box("群馬県産有機ステッキオ", 150, 220, 200),
        _box("50", 565, 220, 30),
        _box("パック", 665, 220, 50),
        _box("川崎DC", 820, 220, 70),
        _box("群馬県産有機カタローニャ", 150, 250, 200),
        _box("50", 565, 250, 30),
        _box("パック", 665, 250, 50),
        _box("川崎DC", 820, 250, 70),
        _box("箱", 665, 280, 30),
        _box("10/22", 30, 340, 50),
        _box("木曜日", 30, 358, 60),
        # "10入" sits near the quantity column but belongs to the product name.
        _box("北海道産有機玉ねぎお得用1kg", 150, 380, 250),
        _box("10入", 470, 380, 40),
        _box("箱", 665, 380, 30),
        _box("群馬県産有機カリーノケール5入", 150, 410, 240),
        _box("箱", 665, 410, 30),
    ]
    return {
        "fused_text": "商品名 数量 単位 備考 10/18 日曜日 デリカフーズ着",
        "paddle": {"lines": lines, "full_text": "商品名 デリカフーズ 日曜日"},
    }


def test_wald_keeps_blank_qty_and_merged_dates():
    output = _sample_output()
    client = {"code": "wald_delica", "name_ja": "ワルドデリカ"}
    eng._attach_wald_delica_sheet(output, client)

    sheet = output["custom_sheets"][0]
    assert sheet["rows"][0] == ["納品日", "商品名", "数量", "単位", "備考"]
    body = sheet["rows"][1:]
    by_name = {row[1]: row for row in body}

    lettuce = by_name["有機サニーレタス15入"]
    assert lettuce[0] == "10/18 日曜日"
    assert lettuce[2] == "2"
    assert lettuce[3] == "箱"
    assert "デリカフーズ着" in lettuce[4]
    assert lettuce[0] != "10/19"

    monday_kale = next(r for r in body if r[1].startswith("群馬県産有機カリーノケール") and r[2] == "20")
    assert monday_kale[0] == "10/19 月曜日"
    assert monday_kale[4] == "山武"
    assert by_name["群馬県産有機ステッキオ"][0] == "10/19 月曜日"
    assert by_name["群馬県産有機カタローニャ"][4] == "川崎DC"

    onion = by_name["北海道産有機玉ねぎお得用1kg 10入"]
    assert onion[0] == "10/22 木曜日"
    assert onion[2] == ""
    assert onion[3] == "箱"
    assert lettuce[1] == "有機サニーレタス15入"
    assert "10月19日" in lettuce[4]
    assert "10/19" not in lettuce[0]

    thursday_kale = next(r for r in body if r[1].startswith("群馬県産有機カリーノケール") and r[0].startswith("10/22"))
    assert thursday_kale[2] == ""

    # Empty template slot (単位 only) is not an order line.
    assert all(not (r[1] == "" and r[2] == "" and r[4] == "") for r in body)
    assert len(body) == 6
    print("test_wald_keeps_blank_qty_and_merged_dates: PASSED")


def test_wald_not_applied_to_other_clients():
    output = _sample_output()
    eng._attach_wald_delica_sheet(output, {"code": "national", "name_ja": "ナショナル"})
    assert "custom_sheets" not in output
    assert "wald_extracted_rows" not in output
    print("test_wald_not_applied_to_other_clients: PASSED")


def test_wald_rows_override_generic_alignment():
    output = _sample_output()
    eng._attach_wald_delica_sheet(output, {"code": "wald_delica", "name_ja": "ワルドデリカ"})
    result = {
        "wald_extracted_rows": output["wald_extracted_rows"],
        "paddle": output["paddle"],
        "tables": [{"data": [["商品名", "数量"], ["有機サニーレタス15入", "2"]]}],
        "fused_text": output["fused_text"],
    }
    client = {
        "id": 5,
        "code": "wald_delica",
        "name_ja": "ワルドデリカ",
        "name_en": "Wald Delica",
        "header_row": 1,
        "heading_columns": "納品日, 商品名, 数量, 単位, 備考",
        "skip_patterns": "デリカフーズ,山武",
        "keywords": "ワルドデリカ",
    }
    out = db.apply_client_ocr_formatting(result, client, matched_mode="manual")
    rows = out["paddle_extracted_rows"]
    names = [r["商品名"] for r in rows]
    assert "北海道産有機玉ねぎお得用1kg 10入" in names
    onion = next(r for r in rows if "玉ねぎ" in r["商品名"])
    assert onion["数量"] == ""
    assert onion["納品日"] == "10/22 木曜日"
    assert any("デリカフーズ" in r["備考"] for r in rows)
    assert any(r["備考"] == "山武" for r in rows)
    print("test_wald_rows_override_generic_alignment: PASSED")


if __name__ == "__main__":
    test_wald_keeps_blank_qty_and_merged_dates()
    test_wald_not_applied_to_other_clients()
    test_wald_rows_override_generic_alignment()
    print("ALL WALD DELICA TESTS PASSED")
