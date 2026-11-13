"""Download and verify the Tesseract models packaged in native builds."""

from hashlib import sha1
from pathlib import Path
from urllib.request import urlopen

FILES = {
    "eng.traineddata": "bbef4675053b5b468cdb477053e28b1c698ba08e",
    "urd.traineddata": "715a159d4abea25294c82971be28be215b3d1c4a",
    "ara.traineddata": "c8d129c67821c1592cac46836686b057ecc203dc",
    "pus.traineddata": "220cdf92efdc76a227439c0b8734196af9743b98",
    "chi_sim.traineddata": "388bac276d033d06e5ed5ba7a7ad14ae58f97dab",
    "chi_tra.traineddata": "1955cd8b8d076b898616e9c2c1ace65b43105356",
    "LICENSE": "d645695673349e3947e8e5ae42332d0ac3164cd7",
}


def git_blob_sha(data):
    return sha1(b"blob %d\0" % len(data) + data).hexdigest()


destination = Path(__file__).resolve().parents[1] / "generated-assets" / "tessdata"
destination.mkdir(parents=True, exist_ok=True)
origin = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0"
for name, expected in FILES.items():
    path = destination / name
    if path.is_file() and git_blob_sha(path.read_bytes()) == expected:
        continue
    with urlopen(f"{origin}/{name}", timeout=60) as response:
        data = response.read(10 * 1024 * 1024)
    if git_blob_sha(data) != expected:
        raise ValueError(f"Unexpected OCR asset content: {name}")
    temporary = path.with_suffix(".part")
    try:
        temporary.write_bytes(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
