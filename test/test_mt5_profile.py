import tempfile
import unittest
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import mt5_profile


def chart(ea_name: str | None, mode: int = 33) -> str:
    expert = ""
    if ea_name:
        expert = (
            "<expert>\r\n"
            f"name={ea_name}\r\n"
            f"path=Experts\\{ea_name}.ex5\r\n"
            f"expertmode={mode}\r\n"
            "</expert>\r\n"
        )
    return f"<chart>\r\nsymbol=XAUUSDc\r\n{expert}</chart>\r\n"


class Mt5ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.install = self.root / "terminal"
        self.data = self.root / "data"
        self.install.mkdir()
        (self.data / "Config").mkdir(parents=True)
        (self.data / "Config" / "common.ini").write_text(
            "[Common]\r\nProfileLast=Trading\r\n", encoding="utf-16"
        )
        self.charts = self.data / "MQL5" / "Profiles" / "Charts" / "Trading"
        self.charts.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write_chart(self, name: str, body: str, *, encoding: str = "utf-16") -> Path:
        target = self.charts / name
        target.write_text(body, encoding=encoding)
        return target

    def test_reads_profile_last_and_recognizes_real_mode_33(self):
        expected = self.write_chart("chart01.chr", chart("GMarket_wl", 33))
        found = mt5_profile.find_ea_charts(
            str(self.install), "GMarket_wl", str(self.data)
        )
        self.assertEqual(found, [expected])
        self.assertEqual(
            mt5_profile.count_mounted_experts(str(self.install), str(self.data)), 1
        )

    def test_existing_target_always_remounts_without_startup_ini(self):
        self.write_chart("chart01.chr", chart("GMarket_wl", 33))
        plan = mt5_profile.plan_mount(
            str(self.install), "GMarket_wl.ex5", str(self.data)
        )
        self.assertEqual(plan["action"], "reloaded_existing_chart")
        self.assertFalse(plan["use_startup_ini"])

    def test_ea_match_is_exact_not_substring(self):
        self.write_chart("chart01.chr", chart("GMarket_wl_v2", 1), encoding="utf-8")
        plan = mt5_profile.plan_mount(
            str(self.install), "GMarket_wl", str(self.data)
        )
        self.assertEqual(plan["action"], "created_new_chart")
        self.assertTrue(plan["use_startup_ini"])

    def test_configured_data_dir_is_authoritative_over_stale_install_profile(self):
        stale = self.install / "MQL5" / "Profiles" / "Charts" / "Default"
        stale.mkdir(parents=True)
        (stale / "chart01.chr").write_text(chart("GMarket_wl"), encoding="utf-16")
        self.write_chart("chart01.chr", chart(None))
        self.assertFalse(mt5_profile.chart_has_ea(
            str(self.install), "GMarket_wl", str(self.data)
        ))

    def test_profile_last_is_authoritative_over_stale_default_profile(self):
        stale = self.data / "MQL5" / "Profiles" / "Charts" / "Default"
        stale.mkdir(parents=True)
        (stale / "chart01.chr").write_text(
            chart("GMarket_wl"), encoding="utf-16"
        )
        self.write_chart("chart01.chr", chart(None))
        self.assertFalse(mt5_profile.chart_has_ea(
            str(self.install), "GMarket_wl", str(self.data)
        ))

    def test_multi_ea_profile_is_restored_without_forcing_single_chart(self):
        self.write_chart("chart01.chr", chart("Alpha"))
        self.write_chart("chart02.chr", chart("Beta"))
        plan = mt5_profile.plan_mount(str(self.install), "Gamma", str(self.data))
        self.assertEqual(plan["action"], "restored_multi_ea_profile")
        self.assertFalse(plan["use_startup_ini"])

    def chart_summary(self):
        return [(c["file"], c["symbol"], c["period"], c["ea_name"])
                for c in mt5_profile.list_profile_charts(self.charts)]

    def order(self):
        return (self.charts / "order.wnd").read_text(encoding="utf-16").split()

    def test_periods_use_mt5_timeframe_encoding(self):
        # D1 is 24 hours; weeks and months are units 2 and 3.
        self.assertEqual(mt5_profile.PERIODS["D1"], (1, 24))
        self.assertEqual(mt5_profile.period_from_fields("2", "1"), "W1")
        self.assertEqual(mt5_profile.period_from_fields(3, 1), "MN1")
        self.assertEqual(mt5_profile.period_from_fields(0, 7), "0:7")
        self.assertEqual(mt5_profile.normalize_period("h4"), "H4")
        self.assertIsNone(mt5_profile.normalize_period("H5"))

    def test_chart_titles_spell_out_long_periods(self):
        self.assertEqual(mt5_profile.parse_chart_title("EURUSD,Daily"), ("EURUSD", "D1"))
        self.assertEqual(mt5_profile.parse_chart_title("XAUUSD.c,M15"), ("XAUUSD.c", "M15"))
        self.assertIsNone(mt5_profile.parse_chart_title("Navigator"))

    def test_built_chart_round_trips_through_reader(self):
        target = self.charts / "chart01.chr"
        expert = mt5_profile.expert_block_text(
            "屠龙V2", "Experts\\屠龙V2.ex5", {"InpMagicNumber": 1001, "InpLots": 0.5, "InpOn": True})
        mt5_profile.write_chart_file(
            target, mt5_profile.build_chart_text("XAUUSDm", "D1", chart_id=42, expert=expert))
        raw = target.read_bytes()
        self.assertTrue(raw.startswith(b"\xff\xfe"))
        self.assertNotIn("\n", raw[2:].decode("utf-16-le").replace("\r\n", ""))
        self.assertEqual(mt5_profile.read_chart(target), {
            "file": "chart01.chr", "path": str(target), "chart_id": "42",
            "symbol": "XAUUSDm", "period": "D1", "ea_name": "屠龙V2",
            "ea_path": "Experts\\屠龙V2.ex5",
            "ea_inputs": {"InpMagicNumber": "1001", "InpLots": "0.5", "InpOn": "true"},
        })

    def test_set_chart_expert_replaces_adds_and_removes(self):
        block = mt5_profile.expert_block_text("Alpha", "Experts\\Alpha.ex5", {"a": 1})
        # MT5 saves a chart without price data with no <window> block at all.
        bare = "<chart>\r\nid=1\r\nsymbol=EURUSD\r\nwindows_total=0\r\n</chart>\r\n"
        added = mt5_profile.set_chart_expert(bare, block)
        self.assertEqual(mt5_profile.read_expert(added),
                         {"name": "Alpha", "path": "Experts\\Alpha.ex5", "expertmode": "1",
                          "inputs": {"a": "1"}})
        self.assertLess(added.index("<expert>"), added.index("</chart>"))

        with_window = mt5_profile.build_chart_text("EURUSD", "H1", chart_id=7, expert=block)
        replaced = mt5_profile.set_chart_expert(
            with_window, mt5_profile.expert_block_text("Beta", "Experts\\Beta.ex5", {}))
        self.assertEqual(replaced.count("<expert>"), 1)
        self.assertEqual(mt5_profile.read_expert(replaced)["name"], "Beta")
        self.assertLess(replaced.index("<expert>"), replaced.index("<window>"))

        removed = mt5_profile.set_chart_expert(replaced, None)
        self.assertIsNone(mt5_profile.read_expert(removed))
        self.assertEqual(removed, mt5_profile.build_chart_text("EURUSD", "H1", chart_id=7))

    def test_add_charts_appends_and_puts_new_charts_in_front(self):
        self.write_chart("chart01.chr", chart(None))
        self.write_chart("chart03.chr", chart("Alpha"))
        (self.charts / "order.wnd").write_text("chart03.chr\r\nchart01.chr\r\n", encoding="utf-16")

        added = mt5_profile.add_charts(self.charts, [
            {"symbol": "EURUSD", "period": "M5"}, {"symbol": "BTCUSD", "period": "W1"}])
        again = mt5_profile.add_charts(self.charts, [{"symbol": "EURUSD", "period": "M5"}])

        self.assertEqual([c["file"] for c in added + again],
                         ["chart04.chr", "chart05.chr", "chart06.chr"])
        self.assertEqual(self.chart_summary()[2:], [
            ("chart04.chr", "EURUSD", "M5", None),
            ("chart05.chr", "BTCUSD", "W1", None),
            ("chart06.chr", "EURUSD", "M5", None),
        ])
        self.assertEqual(self.chart_summary()[1], ("chart03.chr", "XAUUSDc", "", "Alpha"))
        self.assertEqual(self.order(), ["chart06.chr", "chart05.chr", "chart04.chr",
                                        "chart03.chr", "chart01.chr"])
        ids = [c["chart_id"] for c in mt5_profile.list_profile_charts(self.charts)[2:]]
        self.assertEqual(len(set(ids)), 3)

    def test_remove_charts_renumbers_survivors_and_order(self):
        mt5_profile.add_charts(self.charts, [
            {"symbol": s, "period": "H1"} for s in ("AAA", "BBB", "CCC", "DDD")])
        self.assertEqual(self.order(), ["chart04.chr", "chart03.chr", "chart02.chr", "chart01.chr"])

        removed = mt5_profile.remove_charts(self.charts, ["CHART02.chr", "chart03.chr"])

        self.assertEqual([c["symbol"] for c in removed], ["BBB", "CCC"])
        self.assertEqual(self.chart_summary(), [
            ("chart01.chr", "AAA", "H1", None), ("chart02.chr", "DDD", "H1", None)])
        self.assertEqual(self.order(), ["chart02.chr", "chart01.chr"])
        self.assertEqual(sorted(p.name for p in self.charts.iterdir()),
                         ["chart01.chr", "chart02.chr", "order.wnd"])
        self.assertEqual(mt5_profile.remove_charts(self.charts, ["chart09.chr"]), [])

    def test_named_profile_lookup_and_active_profile(self):
        self.assertEqual(mt5_profile.profile_names(str(self.install), str(self.data)), ["Trading"])
        self.assertEqual(mt5_profile.named_profile_dir(str(self.install), "trading", str(self.data)),
                         self.charts)
        self.assertIsNone(mt5_profile.named_profile_dir(str(self.install), "Euro", str(self.data)))
        self.assertEqual(mt5_profile.active_profile_dir(str(self.install), str(self.data)),
                         self.charts)


if __name__ == "__main__":
    unittest.main()
