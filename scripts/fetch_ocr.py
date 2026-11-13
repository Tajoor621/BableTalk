"""Download the versioned Tesseract models packaged in Android builds."""

from pathlib import Path
from urllib.request import urlretrieve

destination = Path(__file__).resolve().parents[1] / "generated-assets" / "tessdata"
destination.mkdir(parents=True, exist_ok=True)
origin = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0"
for language in ("eng", "urd", "ara", "pus"):
    name = f"{language}.traineddata"
    temporary = destination / f"{name}.part"
    try:
        urlretrieve(f"{origin}/{name}", temporary)
        if temporary.stat().st_size < 100000:
            raise ValueError(f"Unexpectedly small OCR model: {name}")
        temporary.replace(destination / name)
    finally:
        temporary.unlink(missing_ok=True)
urlretrieve(f"{origin}/LICENSE", destination / "LICENSE")
