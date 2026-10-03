"""Local Linux image/PDF rendering and Tesseract evidence. No shell interpolation."""
import base64
import io
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageOps
import pypdfium2 as pdfium

Image.MAX_IMAGE_PIXELS = 50_000_000

def page_image(filename, page):
    if Path(filename).suffix.lower() == '.pdf':
        with pdfium.PdfDocument(filename) as pdf:
            total = len(pdf)
            if not 1 <= page <= total:
                raise ValueError('页码超出文件范围')
            p = pdf[page - 1]
            w, h = p.get_size()
            scale = min(2.0, 4096 / max(w, h))
            image = p.render(scale=scale).to_pil().copy()
            p.close()
    else:
        with Image.open(filename) as source:
            total = getattr(source, 'n_frames', 1)
            if not 1 <= page <= total:
                raise ValueError('页码超出文件范围')
            source.seek(page - 1)
            image = ImageOps.exif_transpose(source).convert('RGB').copy()
    return image, total

def render(request):
    page = request.get('page', 1)
    image, total = page_image(request['path'], page)
    original = image.size
    region = request.get('region')
    if region:
        x, y, w, h = [region[k] for k in ('x', 'y', 'width', 'height')]
        if min(x, y) < 0 or min(w, h) <= 0 or x+w > 1 or y+h > 1:
            raise ValueError('区域必须位于原图内')
        image = image.crop((int(x*image.width), int(y*image.height), int((x+w)*image.width), int((y+h)*image.height)))
    before = image.size
    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    data = io.BytesIO()
    image.save(data, format='PNG')
    return dict(image=base64.b64encode(data.getvalue()).decode(), page=page, totalPages=total,
                sourceWidth=original[0], sourceHeight=original[1], width=image.width,
                height=image.height, resized=before != image.size, region=region)

def recognize(request):
    check = subprocess.run(['tesseract', '--list-langs'], check=True, capture_output=True, text=True, timeout=10)
    languages = [v.strip() for v in check.stdout.splitlines()[1:] if v.strip()]
    if request['action'] == 'status':
        return dict(available='chi_sim' in languages and 'eng' in languages, method='tesseract-ocr', languages=languages)
    if not {'chi_sim', 'eng'}.issubset(languages):
        raise ValueError('缺少中英文 OCR 语言包，请在开始设置中安装组件')
    start, end = request.get('startPage', 1), request.get('endPage', 10)
    if start < 1 or end < start or end-start >= 10:
        raise ValueError('每次最多识别 10 页')
    segments, processed, total = [], [], 0
    for page in range(start, end+1):
        if total and page > total:
            break
        image, total = page_image(request['path'], page)
        data = io.BytesIO()
        image.save(data, format='PNG')
        response = subprocess.run(['tesseract', 'stdin', 'stdout', '-l', 'chi_sim+eng'], input=data.getvalue(), capture_output=True, check=True, timeout=90)
        text = response.stdout.decode('utf-8').strip()
        segments.append(dict(locator=f'page:{page}', page=page, text=text, reviewed=False))
        processed.append(page)
    return dict(method='tesseract-ocr', totalPages=total, processedPages=processed, segments=segments, reviewed=False)

if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(render(request) if request.get('action') == 'render' else recognize(request), ensure_ascii=False))
