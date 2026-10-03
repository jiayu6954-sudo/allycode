"""Copy a DOCX, changing only blank paragraphs immediately after its main Title."""
import json
import sys
from zipfile import ZipFile
from lxml import etree as E

r = json.load(sys.stdin)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
w = '{' + ns['w'] + '}'


def blank(node):
    return (node.tag == w+'p' and not ''.join(node.itertext()).strip()
            and not any(child.tag != w+'pPr' for child in node))


with ZipFile(r['source']) as source:
    entries = source.infolist()
    assert len(entries) <= 10000 and sum(i.file_size for i in entries) <= 100*1024*1024, 'DOCX too large'
    assert len({i.filename for i in entries}) == len(entries), 'Duplicate ZIP entries'
    assert source.testzip() is None, 'DOCX CRC failed'
    raw = source.read('word/document.xml')
    assert b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw, 'Unsupported XML entities'
    root = E.fromstring(raw, E.XMLParser(resolve_entities=False, no_network=True))
    body = root.find('w:body', ns)
    title = next((el for el in body if el.tag == w+'p' and ''.join(el.itertext()).strip()), None)
    assert title is not None, 'Missing title'
    style = title.find('w:pPr/w:pStyle', ns)
    assert style is not None and style.get(w+'val') == 'Title', '首个大标题不是 Title 样式，无法安全自动定位；请先确认标题范围'
    position = list(body).index(title) + 1
    while position < len(body) and blank(body[position]):
        body.remove(body[position])
    for _ in range(2):
        body.insert(position, E.Element(w+'p'))
    changed = E.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)
    with open(r['output'], 'xb') as stream, ZipFile(stream, 'w') as target:
        for item in entries:
            target.writestr(item, changed if item.filename == 'word/document.xml' else source.read(item.filename))
    print(json.dumps({'title': ''.join(title.itertext()), 'scope': 'main_title_blank_lines_only'}, ensure_ascii=False))
