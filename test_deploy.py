"""Upload skip decision for deploy.py. No network."""

import io
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

from deploy import build_zip, should_skip_upload


class ShouldSkipUploadTests(unittest.TestCase):
    def test_entry_files_are_not_skipped_when_sizes_match(self):
        remote = {
            "index.html": 2429,
            "assets/utf16-boot.js": 4641,
            ".htaccess": 812,
            "assets/index-B0KNsOdR.js": 120034,
            "assets/finishing-DfNR4ipM.js": 8000,
            "assets/index-Pg1qg2yp.css": 44000,
            "wasm/media_engine.wasm": 90000,
        }
        self.assertFalse(should_skip_upload("assets/utf16-boot.js", 4641, remote))
        self.assertFalse(should_skip_upload("index.html", 2429, remote))
        self.assertFalse(should_skip_upload(".htaccess", 812, remote))
        self.assertTrue(should_skip_upload("assets/index-B0KNsOdR.js", 120034, remote))
        self.assertTrue(should_skip_upload("assets/finishing-DfNR4ipM.js", 8000, remote))
        self.assertTrue(should_skip_upload("assets/index-Pg1qg2yp.css", 44000, remote))
        self.assertTrue(should_skip_upload("wasm/media_engine.wasm", 90000, remote))

    def test_hashed_asset_uploads_when_size_differs_or_is_absent(self):
        remote = {"assets/index-B0KNsOdR.js": 120034}
        self.assertFalse(should_skip_upload("assets/index-B0KNsOdR.js", 120035, remote))
        self.assertFalse(should_skip_upload("assets/index-NEWHASH1.js", 120034, {}))
        self.assertFalse(should_skip_upload("demo/demo-clip-a.mp4", 150000, remote))

    def test_build_zip_packs_forced_files_and_skips_matching_hashed_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            index = root / "index.html"
            boot = root / "assets" / "utf16-boot.js"
            htaccess = root / ".htaccess"
            hashed = root / "assets" / "index-B0KNsOdR.js"
            changed = root / "assets" / "finishing-DfNR4ipM.js"
            index.write_text("<html>index</html>", encoding="utf-8")
            boot.write_text("const ENTRY_UTF8 = \"./index-B0KNsOdR.js\";\n", encoding="utf-8")
            htaccess.write_text("AddCharset UTF-8 .css\n", encoding="utf-8")
            hashed.write_text("hashed-body", encoding="utf-8")
            changed.write_text("finishing", encoding="utf-8")
            remote = {
                "index.html": index.stat().st_size,
                "assets/utf16-boot.js": boot.stat().st_size,
                ".htaccess": htaccess.stat().st_size,
                "assets/index-B0KNsOdR.js": hashed.stat().st_size,
                "assets/finishing-DfNR4ipM.js": changed.stat().st_size + 9,
            }
            log = io.StringIO()
            with redirect_stdout(log):
                blob = build_zip(root, remote)
            names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
            self.assertIn("index.html", names)
            self.assertIn("assets/utf16-boot.js", names)
            self.assertIn(".htaccess", names)
            self.assertIn("assets/finishing-DfNR4ipM.js", names)
            self.assertNotIn("assets/index-B0KNsOdR.js", names)
            text = log.getvalue()
            self.assertIn(f"! index.html ({index.stat().st_size} bytes, always upload)", text)
            self.assertIn(
                f"! assets/utf16-boot.js ({boot.stat().st_size} bytes, always upload)",
                text,
            )
            self.assertIn(
                f"= assets/index-B0KNsOdR.js ({hashed.stat().st_size} bytes, unchanged)",
                text,
            )
            self.assertIn("+ assets/finishing-DfNR4ipM.js", text)


if __name__ == "__main__":
    unittest.main()
