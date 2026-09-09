"""Photo invariants, including offline readiness and recoverable processing."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

from server import images


def picture(mode="RGB", size=(64, 48), color="navy", format="PNG", **kwargs):
    buffer = BytesIO()
    Image.new(mode, size, color).save(buffer, format=format, **kwargs)
    return buffer.getvalue()


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.pipeline = images.ImagePipeline(self.root / "images")
        self.pipeline.cache = self.root / "models"

    def file(self, url):
        return self.pipeline.resolve(url.rsplit("/", 1)[1])

    def test_skip_keeps_normalized_photo_without_inference(self):
        with patch.object(self.pipeline, "_extract") as extract:
            result = self.pipeline.prepare(picture(), remove_background=False)
        self.assertEqual("skipped", result["background_status"])
        self.assertEqual(result["original_url"], result["image_url"])
        extract.assert_not_called()
        with Image.open(self.file(result["image_url"])) as photo:
            self.assertEqual(("JPEG", "RGB", (64, 48)), (photo.format, photo.mode, photo.size))

    def test_default_removal_and_restore_preserve_original_bytes(self):
        with patch.object(self.pipeline, "_extract", return_value=Image.new("RGB", (64, 48), "white")):
            result = self.pipeline.prepare(picture())
            before = self.file(result["original_url"]).read_bytes()
            retry = self.pipeline.cutout(result["original_url"])
        self.assertEqual("completed", result["background_status"])
        self.assertNotEqual(result["image_url"], result["original_url"])
        self.assertNotEqual(retry["image_url"], result["image_url"])
        restored = self.pipeline.restore(result["original_url"])
        self.assertEqual(before, self.file(restored["image_url"]).read_bytes())
        self.assertTrue(self.file(result["image_url"]).exists())

    def test_inference_failure_is_nonfatal_and_recoverable(self):
        with patch.object(self.pipeline, "_extract", side_effect=RuntimeError("offline")):
            with self.assertLogs("server.images", level="WARNING"):
                result = self.pipeline.prepare(picture())
        self.assertEqual("failed", result["background_status"])
        self.assertEqual(result["original_url"], result["image_url"])
        self.assertEqual(1, len(list(self.pipeline.root.iterdir())))

    def test_cutout_save_failure_keeps_original_and_cleans_temp(self):
        result = self.pipeline.prepare(picture(), False)
        before = self.file(result["original_url"]).read_bytes()
        with patch.object(self.pipeline, "_extract", return_value=Image.new("RGB", (64, 48))):
            with patch("server.images.os.replace", side_effect=OSError("full")):
                with self.assertLogs("server.images", level="WARNING"):
                    failed = self.pipeline.cutout(result["original_url"])
        self.assertEqual("failed", failed["background_status"])
        self.assertEqual(before, self.file(result["original_url"]).read_bytes())
        self.assertFalse(list(self.pipeline.root.glob("*.tmp")))

    def test_alpha_exif_and_size_are_normalized(self):
        photo = self.pipeline._decode(picture("RGBA", color=(255, 0, 0, 0)))
        self.assertEqual((255, 255, 255), photo.getpixel((0, 0)))
        exif = Image.Exif()
        exif[274] = 6
        rotated = self.pipeline._decode(picture(format="JPEG", exif=exif))
        self.assertEqual((48, 64), rotated.size)
        large = self.pipeline._decode(picture(size=(3000, 1500)))
        self.assertEqual((2400, 1200), large.size)

    def test_unsupported_or_oversized_inputs_write_nothing(self):
        for data in (b"", b"invalid", picture(format="GIF")):
            with self.assertRaises(ValueError):
                self.pipeline.prepare(data)
        with patch("server.images.MAX_BYTES", 2), self.assertRaises(ValueError):
            self.pipeline.prepare(picture())
        with patch("server.images.MAX_PIXELS", 10), self.assertRaises(ValueError):
            self.pipeline.prepare(picture())
        self.assertEqual([], list(self.pipeline.root.iterdir()))

    def test_asset_paths_reject_traversal_absolute_names_and_wrong_original(self):
        for name in ("../x.jpg", "C:/x.jpg", "a.jpg", "a" * 32 + "-original.jpg/../secret", "..%2fx.jpg"):
            with self.assertRaises(ValueError):
                self.pipeline.resolve(name)
        result = self.pipeline.prepare(picture(), False)
        with self.assertRaises(ValueError):
            self.pipeline.restore("https://example.com" + result["original_url"])
        with self.assertRaises(ValueError):
            self.pipeline.restore(result["original_url"].replace("original", "cutout"))

    def test_readiness_requires_verified_resource_without_import_or_download(self):
        with patch("server.images.importlib.util.find_spec", return_value=object()):
            self.assertEqual(
                {"background_removal": True, "background_removal_ready": False}, self.pipeline.features()
            )
            self.pipeline.cache.mkdir()
            (self.pipeline.cache / "u2netp.onnx").write_bytes(b"corrupt")
            self.assertFalse(self.pipeline.features()["background_removal_ready"])
        with patch("server.images.importlib.util.find_spec", return_value=None):
            self.assertFalse(self.pipeline.features()["background_removal"])

    def test_inference_serialized_across_pipeline_instances(self):
        active = 0
        maximum = 0
        monitor = threading.Lock()

        def extract(photo, **_):
            nonlocal active, maximum
            with monitor:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.02)
            with monitor:
                active -= 1
            return photo.convert("RGBA")

        other = images.ImagePipeline(self.root / "other")
        with (
            patch("server.images.model_file", return_value=Path("prepared.onnx")),
            patch("server.images._local_session", return_value=object()),
            patch.dict(sys.modules, {"rembg": SimpleNamespace(remove=extract)}),
        ):
            with ThreadPoolExecutor(max_workers=4) as pool:
                jobs = [pool.submit(p.prepare, picture()) for p in (self.pipeline, other) for _ in range(2)]
                results = [job.result() for job in jobs]
        self.assertEqual(1, maximum)
        self.assertTrue(all(result["background_status"] == "completed" for result in results))

    def test_corrupt_flat_model_does_not_hide_verified_nested_model(self):
        flat = self.pipeline.cache / "u2netp.onnx"
        nested = self.pipeline.cache / "models/u2netp/u2netp.onnx"
        nested.parent.mkdir(parents=True)
        flat.write_bytes(b"corrupt")
        nested.write_bytes(b"prepared")
        with patch("server.images.verified_model", side_effect=lambda path: path == nested):
            self.assertEqual(nested, images.model_file(self.pipeline.cache))

    def test_repeated_inference_reuses_one_offline_session(self):
        constructed = []

        class Session:
            def __init__(self, *args, **kwargs):
                constructed.append(self.download_models())

        modules = {
            "onnxruntime": SimpleNamespace(SessionOptions=SimpleNamespace),
            "rembg.sessions.u2netp": SimpleNamespace(U2netpSession=Session),
        }
        path = self.root / "prepared.onnx"
        with (
            patch.dict(sys.modules, modules),
            patch.dict(images._SESSIONS, {}, clear=True),
            patch("server.images.verified_model", return_value=True),
        ):
            first = images._local_session(path)
            second = images._local_session(path)
            self.assertIs(first, second)
            self.assertEqual([str(path)], constructed)


class PrepareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "scripts/prepare_images.py"
        spec = importlib.util.spec_from_file_location("prepare_images_test", path)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_valid_cache_is_quick_and_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = root / "u2netp.onnx"
            prepared.write_bytes(b"ready")
            with (
                patch.object(self.module, "valid", side_effect=lambda path: path == prepared),
                patch.object(self.module.importlib.util, "find_spec", return_value=object()),
                patch.object(self.module, "urlopen") as download,
                patch.object(self.module.subprocess, "run") as install,
            ):
                self.assertEqual(prepared, self.module.prepare(root))
            download.assert_not_called()
            install.assert_not_called()

    def test_checksum_failure_does_not_replace_existing_file(self):
        class Response(BytesIO):
            def geturl(self):
                return "https://example.com/model"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "u2netp.onnx"
            target.write_bytes(b"existing")
            with (
                patch.object(self.module.importlib.util, "find_spec", return_value=object()),
                patch.object(self.module, "urlopen", return_value=Response(b"wrong")),
                self.assertRaises(RuntimeError),
            ):
                self.module.prepare(root)
            self.assertEqual(b"existing", target.read_bytes())
            self.assertEqual([target], list(root.iterdir()))

    def test_missing_dependency_no_install_fails_before_download(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(self.module.importlib.util, "find_spec", return_value=None),
            patch.object(self.module, "urlopen") as download,
        ):
            with self.assertRaises(RuntimeError):
                self.module.prepare(Path(directory), install=False)
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
