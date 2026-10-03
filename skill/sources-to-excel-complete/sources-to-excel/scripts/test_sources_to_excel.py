"""Deterministic adapter tests; generated fixtures contain no real user data."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from openpyxl import load_workbook
from sources_to_excel import scan, build, typed

class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = self.root / 'inputs'
        self.inputs.mkdir()
        (self.inputs/'a.txt').write_text('编号 00123；金额 10.20；备注 =2+2；日期 2026-09-16\n', encoding='utf-8')
        (self.inputs/'b.txt').write_bytes((self.inputs/'a.txt').read_bytes())
        (self.inputs/'c.csv').write_text('品名,数量\n桌椅,12\n', encoding='utf-8')
        (self.inputs/'d.bin').write_bytes(b'opaque unsupported')
        self.manifest = self.root/'manifest.json'
        scan({'inputs':[str(self.inputs)], 'output':str(self.manifest)})
        self.data = json.loads(self.manifest.read_text(encoding='utf-8'))
        self.ids = {Path(f['path']).name:f['id'] for f in self.data['files']}

    def request(self):
        a,b,c,d = (self.ids[n] for n in ['a.txt','b.txt','c.csv','d.bin'])
        def ev(fid, loc, q): return [{'file_id':fid,'locator':loc,'quote':q}]
        return {'manifest':str(self.manifest), 'output':str(self.root/'result.xlsx'),
          'coverage':{a:{'status':'included'},b:{'status':'duplicate','duplicate_of':a,'reason':'same hash'},c:{'status':'included'},d:{'status':'unreadable','reason':'no parser'}},
          'sheets':[
            {'name':'记录','columns':[{'key':'id','header':'编号','type':'text'},{'key':'amount','header':'金额','type':'decimal'},{'key':'note','header':'备注'},{'key':'date','header':'日期','type':'date'}],
             'rows':[{'values':{'id':'00123','amount':'10.20','note':'=2+2','date':'2026-09-16'},'evidence':{'id':ev(a,'line:1','00123'),'amount':ev(a,'line:1','10.20'),'note':ev(a,'line:1','=2+2'),'date':ev(a,'line:1','2026-09-16')}}]},
            {'name':'物品','columns':[{'key':'item','header':'物品'},{'key':'qty','header':'数量','type':'integer'}],
             'rows':[{'values':{'item':'桌椅','qty':'12'},'evidence':{'item':ev(c,'row:2','桌椅'),'qty':ev(c,'row:2','12')}}]}]}

    def test_mixed_sources_dynamic_headers_precision_and_plain_style(self):
        self.assertEqual(len(self.data['files']),4)
        self.assertEqual(self.data['files'][1]['status'],'duplicate')
        result=build(self.request())
        self.assertEqual(result['unresolved_files'],[self.ids['d.bin']])
        wb=load_workbook(result['output'])
        self.assertEqual(wb['记录']['A2'].value,'00123')
        self.assertEqual(wb['记录']['B2'].value,10.2)
        self.assertEqual(wb['记录']['B2'].number_format,'0.00')
        self.assertEqual(wb['记录']['C2'].data_type,'s')
        self.assertEqual(wb['记录']['C2'].value,'=2+2')
        self.assertEqual(wb['物品']['B2'].value,12)
        self.assertFalse(wb['物品']['A1'].fill.patternType)
        self.assertEqual(wb['物品']['A1'].font.color.rgb,'00000000')
        self.assertEqual(typed('12345678901234567890','decimal')[0],'12345678901234567890')
        self.assertTrue(Path(result['audit']).exists())
        wb.close()

    def test_rejects_untraceable_values_and_missing_files(self):
        for variant in ('evidence','coverage'):
            req=self.request()
            if variant=='evidence': req['sheets'][0]['rows'][0]['evidence']['id'][0]['quote']='NOT PRESENT'
            else: del req['coverage'][self.ids['d.bin']]
            with self.assertRaises(ValueError): build(req)
            self.assertFalse(Path(req['output']).exists())

    def test_changed_input_and_existing_output_not_overwritten(self):
        req=self.request()
        Path(req['output']).write_bytes(b'keep me')
        with self.assertRaises(ValueError): build(req)
        self.assertEqual(Path(req['output']).read_bytes(),b'keep me')
        Path(req['output']).unlink()
        (self.inputs/'a.txt').write_text('changed',encoding='utf-8')
        with self.assertRaises(ValueError): build(req)
        self.assertFalse(Path(req['output']).exists())

    def test_ocr_append_partial_coverage_and_missing_value(self):
        req=self.request(); fid=self.ids['d.bin']
        self.data['files'][-1]['segments']=[{'locator':'page:1:ocr','text':'数量 8','method':'test fixture OCR','reviewed':True}]
        self.manifest.write_text(json.dumps(self.data),encoding='utf-8')
        req['coverage'][fid]={'status':'partial','reason':'second page unreadable','review_note':'page 1 OCR verified'}
        req['sheets'][1]['rows'].append({'values':{'item':None,'qty':'8'},'issues':['物品名称无法确认'],'evidence':{'qty':[{'file_id':fid,'locator':'page:1:ocr','quote':'8'}]}})
        result=build(req)
        self.assertEqual(result['review_rows'],1)
        self.assertIn(fid,result['unresolved_files'])

    def test_text_pdf_docx_and_image_inventory(self):
        from zipfile import ZipFile
        from pypdf import PdfWriter
        more=self.root/'more'; more.mkdir()
        writer=PdfWriter(); writer.add_blank_page(width=100,height=100)
        with (more/'blank.pdf').open('wb') as f: writer.write(f)
        with ZipFile(more/'note.docx','w') as z:
            z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>采购 12 件</w:t></w:r></w:p></w:body></w:document>')
        (more/'scan.png').write_bytes(b'image fixture')
        result=scan({'inputs':[str(more)],'output':str(self.root/'more.json')})
        self.assertEqual(result['files'],3)
        self.assertEqual(result['counts']['needs_visual_review'],2)
        self.assertEqual(result['counts']['needs_ocr'],1)
        data=json.loads((self.root/'more.json').read_text(encoding='utf-8'))
        self.assertTrue(any('采购' in s['text'] for f in data['files'] for s in f['segments']))

if __name__=='__main__': unittest.main()
